-- Feature 023 (delivery 1) — the catalog updater.
--
-- A space keeps one updater: a set of 022 product catalogs, an interval (1 hour, 1 day, 1 week),
-- and — later, with the desktop release — a re-stitch option. At each round a scheduled Edge
-- Function rewrites every selected sheet in place with its product IDs moved on by the owner's rule
-- (+500, +501, +502…). The sheet keeps its file and its link, because ad platforms read that link.
--
-- What this adds:
--   team_product_catalogs            how many updates a sheet has had, when, and the last failure
--   team_catalog_updaters            one per space
--   team_catalog_updater_items       the catalogs in it, with round and lease state
--   four client RPCs                 the registry, the updater's state, save, stop
--   the worker's service functions   open rounds, claim, complete, retry
--   private.invoke_catalog_updater_worker + a cron job
--
-- The worker reuses the catalog-sync secret and derives its URL from the catalog-sync URL already
-- in Vault, so neither beta nor production needs a manual step. Additive for the released client.
-- Forward-only; reverse steps in ROLLBACK.md.

-- ---------------------------------------------------------------------------------------------
-- A sheet's update history. It belongs to the sheet, not to the updater: a catalog taken out of the
-- updater and put back must continue from its count, or its IDs could come back.

alter table public.team_product_catalogs
  add column if not exists update_count integer not null default 0,
  add column if not exists last_updated_at timestamptz,
  add column if not exists last_update_error text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'team_product_catalogs_update_count_check'
  ) then
    alter table public.team_product_catalogs
      add constraint team_product_catalogs_update_count_check check (update_count >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'team_product_catalogs_update_error_check'
  ) then
    alter table public.team_product_catalogs
      add constraint team_product_catalogs_update_error_check
      check (last_update_error is null or last_update_error ~ '^[A-Z_]{2,64}$');
  end if;
end $$;

grant select (update_count, last_updated_at, last_update_error)
  on public.team_product_catalogs to authenticated;

-- ---------------------------------------------------------------------------------------------
-- The updater.

create table public.team_catalog_updaters (
  team_id uuid primary key references public.teams(id) on delete cascade,
  state text not null default 'stopped',
  update_interval text not null default '1h',
  restitch boolean not null default false,
  next_run_at timestamptz,
  started_at timestamptz,
  started_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint team_catalog_updaters_state_check check (state in ('running', 'stopped')),
  constraint team_catalog_updaters_interval_check check (update_interval in ('1h', '1d', '1w')),
  -- A running updater always knows when it runs next; a stopped one never does.
  constraint team_catalog_updaters_due_check
    check ((state = 'running') = (next_run_at is not null))
);

create table public.team_catalog_updater_items (
  catalog_material_id uuid primary key
    references public.team_product_catalogs(material_id) on delete cascade,
  team_id uuid not null references public.team_catalog_updaters(team_id) on delete cascade,
  added_at timestamptz not null default now(),
  -- Set when a round opens; cleared when this catalog's update commits. A round that opens while
  -- the previous one is still pending for this catalog does not stack a second update.
  round_due_at timestamptz,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  constraint team_catalog_updater_items_attempts_check check (attempts >= 0)
);

create index team_catalog_updater_items_team_idx on public.team_catalog_updater_items (team_id);
create index team_catalog_updater_items_due_idx
  on public.team_catalog_updater_items (next_attempt_at)
  where round_due_at is not null;

alter table public.team_catalog_updaters enable row level security;
alter table public.team_catalog_updaters force row level security;
alter table public.team_catalog_updater_items enable row level security;
alter table public.team_catalog_updater_items force row level security;

revoke all on public.team_catalog_updaters from anon, authenticated;
revoke all on public.team_catalog_updater_items from anon, authenticated;

grant select (
  team_id, state, update_interval, restitch, next_run_at, started_at, started_by, updated_by,
  updated_at
) on public.team_catalog_updaters to authenticated;
grant select (catalog_material_id, team_id, added_at, round_due_at, attempts)
  on public.team_catalog_updater_items to authenticated;

create policy team_catalog_updaters_select_team
on public.team_catalog_updaters for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

create policy team_catalog_updater_items_select_team
on public.team_catalog_updater_items for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

-- ---------------------------------------------------------------------------------------------
-- Which catalogs are live: the sheet is still the video's catalog and both files still exist.

create or replace function private.live_product_catalogs(p_team uuid)
returns table (catalog_material_id uuid, video_material_id uuid)
language sql
security definer
set search_path = ''
stable
as $$
  select sheet.id, video.id
  from public.team_product_catalogs as record
  join public.team_materials as sheet on sheet.id = record.material_id
  join public.team_materials as video on video.id = sheet.companion_of
  where record.team_id = p_team
    and sheet.team_id = p_team
    and sheet.lifecycle = 'active'
    and sheet.companion_kind = 'product_catalog'
    and video.lifecycle = 'active'
    and video.category = 'video';
$$;

create or replace function private.catalog_updater_interval(p_interval text)
returns interval
language sql
immutable
set search_path = ''
as $$
  select case p_interval
    when '1h' then interval '1 hour'
    when '1d' then interval '1 day'
    when '1w' then interval '7 days'
  end;
$$;

-- The updater as the web shows it. A space that never started one reads as stopped.
create or replace function private.catalog_updater_state(p_team uuid)
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  select jsonb_build_object(
    'state', coalesce(updater.state, 'stopped'),
    'interval', coalesce(updater.update_interval, '1h'),
    'restitch', coalesce(updater.restitch, false),
    'nextRunAt', updater.next_run_at,
    'startedAt', updater.started_at,
    'catalogCount', (
      select count(*) from public.team_catalog_updater_items as item where item.team_id = p_team
    ),
    'failingCount', (
      select count(*)
      from public.team_catalog_updater_items as item
      join public.team_product_catalogs as record
        on record.material_id = item.catalog_material_id
      where item.team_id = p_team
        and item.attempts >= 3
        and record.last_update_error is not null
    ),
    'spareReadyCount', null,
    'device', null,
    'serverNow', clock_timestamp()
  )
  from (select 1) as anchor
  left join public.team_catalog_updaters as updater on updater.team_id = p_team;
$$;

-- ---------------------------------------------------------------------------------------------
-- Client RPCs.

create or replace function public.list_team_product_catalogs(p_team uuid)
returns table (
  catalog_id uuid,
  name text,
  sheet_url text,
  video_id uuid,
  video_name text,
  folder_name text,
  product_count smallint,
  created_at timestamptz,
  last_updated_at timestamptz,
  update_count integer,
  in_updater boolean,
  last_update_error text
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
    select sheet.id,
           sheet.name,
           record.sheet_url,
           video.id,
           video.name,
           folder.name,
           record.product_count,
           record.created_at,
           record.last_updated_at,
           record.update_count,
           item.catalog_material_id is not null,
           record.last_update_error
    from private.live_product_catalogs(p_team) as live
    join public.team_product_catalogs as record on record.material_id = live.catalog_material_id
    join public.team_materials as sheet on sheet.id = live.catalog_material_id
    join public.team_materials as video on video.id = live.video_material_id
    left join public.team_materials as folder
      on folder.team_id = p_team
     and folder.drive_file_id = video.parent_folder_id
     and folder.kind = 'folder'
     and folder.lifecycle = 'active'
    left join public.team_catalog_updater_items as item
      on item.catalog_material_id = live.catalog_material_id
    order by record.created_at desc;
end;
$$;

create or replace function public.get_team_catalog_updater(p_team uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return private.catalog_updater_state(p_team);
end;
$$;

create or replace function public.save_team_catalog_updater(
  p_team uuid,
  p_catalogs uuid[],
  p_interval text,
  p_restitch boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  wanted uuid[];
  current_row public.team_catalog_updaters%rowtype;
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select coalesce(array_agg(distinct catalog), '{}') into wanted
  from unnest(coalesce(p_catalogs, '{}')) as catalog
  where catalog is not null;
  if p_interval is null
     or private.catalog_updater_interval(p_interval) is null
     or coalesce(p_restitch, false)            -- re-stitching arrives with the desktop release
     or cardinality(wanted) = 0
     or cardinality(wanted) > 2000
     or exists (
       select 1 from unnest(wanted) as catalog
       where catalog not in (
         select live.catalog_material_id from private.live_product_catalogs(p_team) as live
       )
     ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  insert into public.team_catalog_updaters (team_id) values (p_team)
  on conflict (team_id) do nothing;
  select * into current_row from public.team_catalog_updaters
  where team_id = p_team for update;

  update public.team_catalog_updaters as updater
     set state = 'running',
         update_interval = p_interval,
         restitch = false,
         next_run_at = case
           when current_row.state <> 'running' or current_row.update_interval <> p_interval
             then clock_timestamp() + private.catalog_updater_interval(p_interval)
           else current_row.next_run_at
         end,
         started_at = case
           when current_row.state <> 'running' then clock_timestamp()
           else current_row.started_at
         end,
         started_by = case
           when current_row.state <> 'running' then auth.uid()
           else current_row.started_by
         end,
         updated_by = auth.uid(),
         updated_at = clock_timestamp()
   where updater.team_id = p_team;

  delete from public.team_catalog_updater_items as item
  where item.team_id = p_team and not (item.catalog_material_id = any(wanted));
  insert into public.team_catalog_updater_items (catalog_material_id, team_id)
  select catalog, p_team from unnest(wanted) as catalog
  on conflict (catalog_material_id) do nothing;

  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (p_team, null, 'sync_state');
  return private.catalog_updater_state(p_team);
end;
$$;

create or replace function public.stop_team_catalog_updater(p_team uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.team_catalog_updaters as updater
     set state = 'stopped',
         next_run_at = null,
         updated_by = auth.uid(),
         updated_at = clock_timestamp()
   where updater.team_id = p_team;
  delete from public.team_catalog_updater_items as item where item.team_id = p_team;
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (p_team, null, 'sync_state');
  return private.catalog_updater_state(p_team);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- The worker's side.

/*
 * Opens a round for every running updater that is due: stamps its catalogs and moves its next run
 * one interval on from now. An updater overdue by many intervals opens one round, not many.
 */
create or replace function public.service_open_catalog_updater_rounds()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  opened integer := 0;
  due record;
begin
  for due in
    select updater.team_id, updater.update_interval
    from public.team_catalog_updaters as updater
    where updater.state = 'running' and updater.next_run_at <= clock_timestamp()
    for update skip locked
  loop
    update public.team_catalog_updater_items as item
       set round_due_at = clock_timestamp(),
           next_attempt_at = clock_timestamp()
     where item.team_id = due.team_id and item.round_due_at is null;
    update public.team_catalog_updaters as updater
       set next_run_at = clock_timestamp() + private.catalog_updater_interval(due.update_interval),
           updated_at = clock_timestamp()
     where updater.team_id = due.team_id;
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    values (due.team_id, null, 'sync_state');
    opened := opened + 1;
  end loop;
  return opened;
end;
$$;

create or replace function private.claim_catalog_updater_items(
  p_worker text, p_limit integer default 10, p_lease_seconds integer default 60
)
returns setof public.team_catalog_updater_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  slots integer;
  gone record;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(72301500) then return; end if;

  -- A catalog whose sheet or video is gone leaves the updater instead of failing every round.
  for gone in
    delete from public.team_catalog_updater_items as item
    where item.round_due_at is not null
      and not exists (
        select 1 from private.live_product_catalogs(item.team_id) as live
        where live.catalog_material_id = item.catalog_material_id
      )
    returning item.team_id, item.catalog_material_id
  loop
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    values (gone.team_id, gone.catalog_material_id, 'upserted');
  end loop;

  select greatest(0, 12 - count(*)::integer) into slots
  from public.team_catalog_updater_items
  where lease_expires_at > clock_timestamp();
  if slots = 0 then return; end if;

  return query
  with candidates as (
    select item.catalog_material_id
    from public.team_catalog_updater_items as item
    join public.team_catalog_updaters as updater on updater.team_id = item.team_id
    where updater.state = 'running'
      and item.round_due_at is not null
      and item.next_attempt_at <= clock_timestamp()
      and (item.lease_expires_at is null or item.lease_expires_at <= clock_timestamp())
    order by item.next_attempt_at, item.round_due_at
    for update of item skip locked
    limit least(greatest(p_limit, 1), slots)
  )
  update public.team_catalog_updater_items as item
     set lease_owner = p_worker,
         lease_expires_at = clock_timestamp()
           + make_interval(secs => least(greatest(p_lease_seconds, 10), 300)),
         next_attempt_at = clock_timestamp()
           + make_interval(secs => least(greatest(p_lease_seconds, 10), 300)),
         attempts = item.attempts + 1
    from candidates
   where item.catalog_material_id = candidates.catalog_material_id
  returning item.*;
end;
$$;

create or replace function public.service_claim_catalog_updater_items(
  p_worker text, p_limit integer default 10, p_lease_seconds integer default 60
)
returns table (
  catalog_material_id uuid,
  team_id uuid,
  attempts integer,
  update_count integer,
  product_count smallint,
  source_link text,
  video_link text,
  settings_snapshot jsonb,
  drive_file_id text,
  resource_key text,
  credential_id uuid
)
language sql
security definer
set search_path = ''
as $$
  select item.catalog_material_id,
         item.team_id,
         item.attempts,
         record.update_count,
         record.product_count,
         record.source_link,
         record.video_link,
         record.settings_snapshot,
         sheet.drive_file_id,
         sheet.resource_key,
         connection.credential_id
  from private.claim_catalog_updater_items(p_worker, p_limit, p_lease_seconds) as item
  join public.team_product_catalogs as record on record.material_id = item.catalog_material_id
  join public.team_materials as sheet on sheet.id = item.catalog_material_id
  join public.team_drive_connections as connection on connection.id = sheet.connection_id
  where connection.state in ('connected', 'unavailable');
$$;

create or replace function public.service_complete_catalog_update(
  p_item uuid, p_worker text, p_update_count integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  owning_team uuid;
begin
  update public.team_catalog_updater_items as item
     set round_due_at = null,
         attempts = 0,
         lease_owner = null,
         lease_expires_at = null,
         next_attempt_at = clock_timestamp()
   where item.catalog_material_id = p_item
     and item.lease_owner = p_worker
     and item.lease_expires_at > clock_timestamp()
  returning item.team_id into owning_team;
  if owning_team is null then return false; end if;

  -- Only ever one step on: a retried completion of an update that already counted must not
  -- move the sheet's count past the IDs it actually carries.
  update public.team_product_catalogs as record
     set update_count = greatest(record.update_count, p_update_count),
         last_updated_at = clock_timestamp(),
         last_update_error = null
   where record.material_id = p_item
     and p_update_count between record.update_count and record.update_count + 1;

  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (owning_team, p_item, 'upserted');
  return true;
end;
$$;

create or replace function public.service_retry_catalog_update(
  p_item uuid, p_worker text, p_error text, p_next_attempt_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  owning_team uuid;
  tries integer;
begin
  if p_error is null or p_error !~ '^[A-Z_]{2,64}$' or p_next_attempt_at is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update public.team_catalog_updater_items as item
     set lease_owner = null,
         lease_expires_at = null,
         next_attempt_at = p_next_attempt_at
   where item.catalog_material_id = p_item
     and item.lease_owner = p_worker
     and item.lease_expires_at > clock_timestamp()
  returning item.team_id, item.attempts into owning_team, tries;
  if owning_team is null then return false; end if;

  if tries >= 3 then
    update public.team_product_catalogs as record
       set last_update_error = p_error
     where record.material_id = p_item;
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    values (owning_team, p_item, 'upserted');
  end if;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- The schedule. Ticks cost nothing when no updater is due and no retry is waiting.

create or replace function private.catalog_updater_endpoint(p_catalog_sync_url text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_catalog_sync_url ~ '^https?://[^[:space:]]+/catalog-sync$'
      then regexp_replace(p_catalog_sync_url, '/catalog-sync$', '/catalog-updater')
  end;
$$;

create or replace function private.invoke_catalog_updater_worker()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  endpoint text;
  worker_secret text;
  request_id bigint;
begin
  if not exists (
    select 1 from public.team_catalog_updaters as updater
    where updater.state = 'running' and updater.next_run_at <= clock_timestamp()
  ) and not exists (
    select 1 from public.team_catalog_updater_items as item
    join public.team_catalog_updaters as updater on updater.team_id = item.team_id
    where updater.state = 'running'
      and item.round_due_at is not null
      and item.next_attempt_at <= clock_timestamp()
      and (item.lease_expires_at is null or item.lease_expires_at <= clock_timestamp())
  ) then return null; end if;
  if (select count(*) from public.team_catalog_updater_items
      where lease_expires_at > clock_timestamp()) >= 12
  then return null; end if;

  select private.catalog_updater_endpoint(secret.decrypted_secret) into endpoint
  from vault.decrypted_secrets as secret where secret.name = 'wishly_catalog_sync_url'
  order by secret.created_at desc limit 1;
  select secret.decrypted_secret into worker_secret
  from vault.decrypted_secrets as secret where secret.name = 'wishly_catalog_sync_secret'
  order by secret.created_at desc limit 1;
  if endpoint is null or worker_secret is null or char_length(worker_secret) < 32 then
    return null;
  end if;

  select net.http_post(
    url := endpoint,
    headers := pg_catalog.jsonb_build_object('content-type', 'application/json',
      'x-catalog-sync-secret', worker_secret),
    body := '{"scheduled":true}'::jsonb, timeout_milliseconds := 60000
  ) into request_id;
  return request_id;
end;
$$;

select cron.unschedule(job.jobid) from cron.job as job
where job.jobname = 'wishly-catalog-updater';
select cron.schedule('wishly-catalog-updater', '10 seconds',
  $cron$select private.invoke_catalog_updater_worker()$cron$);

-- ---------------------------------------------------------------------------------------------
-- Grants: closed to PUBLIC first, then opened to the role each function was written for.

revoke all on function private.live_product_catalogs(uuid) from public;
revoke all on function private.catalog_updater_interval(text) from public;
revoke all on function private.catalog_updater_state(uuid) from public;
revoke all on function private.claim_catalog_updater_items(text, integer, integer) from public;
revoke all on function private.catalog_updater_endpoint(text) from public;
revoke all on function private.invoke_catalog_updater_worker() from public;

revoke all on function public.list_team_product_catalogs(uuid) from public, anon, authenticated;
revoke all on function public.get_team_catalog_updater(uuid) from public, anon, authenticated;
revoke all on function public.save_team_catalog_updater(uuid, uuid[], text, boolean)
  from public, anon, authenticated;
revoke all on function public.stop_team_catalog_updater(uuid) from public, anon, authenticated;
revoke all on function public.service_open_catalog_updater_rounds()
  from public, anon, authenticated;
revoke all on function public.service_claim_catalog_updater_items(text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.service_complete_catalog_update(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.service_retry_catalog_update(uuid, text, text, timestamptz)
  from public, anon, authenticated;

grant execute on function public.list_team_product_catalogs(uuid) to authenticated;
grant execute on function public.get_team_catalog_updater(uuid) to authenticated;
grant execute on function public.save_team_catalog_updater(uuid, uuid[], text, boolean)
  to authenticated;
grant execute on function public.stop_team_catalog_updater(uuid) to authenticated;
grant execute on function public.service_open_catalog_updater_rounds() to service_role;
grant execute on function public.service_claim_catalog_updater_items(text, integer, integer)
  to service_role;
grant execute on function public.service_complete_catalog_update(uuid, text, integer)
  to service_role;
grant execute on function public.service_retry_catalog_update(uuid, text, text, timestamptz)
  to service_role;
