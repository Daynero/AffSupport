-- Feature 024 — every catalog keeps its own schedule, and any catalog can be updated now.
--
-- 023 gave a space one updater: tick catalogs, choose one interval, start. The owner runs catalogs
-- on different rhythms — one every hour, another once a day — and sometimes needs one renewed this
-- minute. So the schedule moves onto the catalog: each item in the updater has its own interval and
-- its own next run, and "update now" opens a round for any live catalog, scheduled or not.
--
-- What changes:
--   team_catalog_updater_items.update_interval  the catalog's own interval; null = not scheduled
--                                               (a row kept only for an update-now in flight)
--   team_catalog_updater_items.next_run_at      when this catalog is due
--   private.sync_catalog_updater                the space row follows its items: running while any
--                                               catalog is scheduled, due at the earliest of them
--   set_team_catalog_update_interval            schedule, reschedule or unschedule catalogs
--   run_team_catalog_update_now                 open a round for catalogs this minute
--   set_team_catalog_updater_restitch           re-stitching stays one switch for the space
--   service_open_catalog_updater_rounds         opens rounds per catalog
--   claim / worker wake-up                      serve update-now rows without a running updater
--   list_team_product_catalogs                  + update_interval, next_run_at, update_pending
--   save / stop                                 kept for the released client, on the new model
--
-- The space row's `update_interval` stays: it is the interval last chosen, which the list offers
-- first for a catalog being scheduled. Forward-only; reverse steps in ROLLBACK.md.

alter table public.team_catalog_updater_items
  add column if not exists update_interval text,
  add column if not exists next_run_at timestamptz;

update public.team_catalog_updater_items as item
   set update_interval = updater.update_interval,
       next_run_at = coalesce(updater.next_run_at, clock_timestamp()
         + private.catalog_updater_interval(updater.update_interval))
  from public.team_catalog_updaters as updater
 where updater.team_id = item.team_id and item.update_interval is null;

alter table public.team_catalog_updater_items
  drop constraint if exists team_catalog_updater_items_interval_check;
alter table public.team_catalog_updater_items
  add constraint team_catalog_updater_items_interval_check
  check (
    (update_interval is null and next_run_at is null)
    or (private.catalog_updater_interval(update_interval) is not null and next_run_at is not null)
  );

create index if not exists team_catalog_updater_items_next_run_idx
  on public.team_catalog_updater_items (next_run_at)
  where update_interval is not null;

grant select (update_interval, next_run_at) on public.team_catalog_updater_items to authenticated;

-- ---------------------------------------------------------------------------------------------
-- The space row follows its catalogs.

create or replace function private.sync_catalog_updater(p_team uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  earliest timestamptz;
begin
  -- Rows with no schedule and no round in flight are nothing; they go.
  delete from public.team_catalog_updater_items as item
  where item.team_id = p_team and item.update_interval is null and item.round_due_at is null;

  select min(item.next_run_at) into earliest
  from public.team_catalog_updater_items as item
  where item.team_id = p_team and item.update_interval is not null;

  update public.team_catalog_updaters as updater
     set state = case when earliest is null then 'stopped' else 'running' end,
         next_run_at = earliest,
         started_at = case
           when earliest is null then updater.started_at
           when updater.state <> 'running' then clock_timestamp()
           else updater.started_at
         end,
         started_by = case
           when earliest is not null and updater.state <> 'running' then auth.uid()
           else updater.started_by
         end,
         updated_by = coalesce(auth.uid(), updater.updated_by),
         updated_at = clock_timestamp()
   where updater.team_id = p_team;

  -- Spares only for catalogs that are scheduled; a one-off update keeps the video it points at.
  if exists (
    select 1 from public.team_catalog_updaters as updater
    where updater.team_id = p_team and updater.restitch and updater.state = 'running'
  ) then
    perform private.retire_restitch_spares(p_team, array(
      select item.catalog_material_id from public.team_catalog_updater_items as item
      where item.team_id = p_team and item.update_interval is not null
    ));
    perform private.queue_restitch_jobs(p_team);
  else
    perform private.retire_restitch_spares(p_team, null);
  end if;

  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (p_team, null, 'sync_state');
end;
$$;

create or replace function private.queue_restitch_jobs(p_team uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.team_catalog_updaters as updater
    where updater.team_id = p_team and updater.state = 'running' and updater.restitch
  ) then return; end if;
  insert into private.catalog_restitch_jobs (catalog_material_id, team_id)
  select item.catalog_material_id, p_team
  from public.team_catalog_updater_items as item
  where item.team_id = p_team
    and item.update_interval is not null
    and not exists (
      select 1 from public.team_catalog_restitch_copies as copy
      where copy.catalog_material_id = item.catalog_material_id and copy.role = 'spare'
    )
  on conflict (catalog_material_id) do nothing;
end;
$$;

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
      select count(*) from public.team_catalog_updater_items as item
      where item.team_id = p_team and item.update_interval is not null
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
    'spareReadyCount', case when coalesce(updater.restitch, false) then (
      select count(*)
      from public.team_catalog_updater_items as item
      join public.team_catalog_restitch_copies as copy
        on copy.catalog_material_id = item.catalog_material_id and copy.role = 'spare'
      where item.team_id = p_team and item.update_interval is not null
    ) end,
    'device', null,
    'serverNow', clock_timestamp()
  )
  from (select 1) as anchor
  left join public.team_catalog_updaters as updater on updater.team_id = p_team;
$$;

-- Refuses what cannot be updated: nothing, too much, or a catalog that is not live in this space.
create or replace function private.checked_catalogs(p_team uuid, p_catalogs uuid[])
returns uuid[]
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  wanted uuid[];
begin
  select coalesce(array_agg(distinct catalog), '{}') into wanted
  from unnest(coalesce(p_catalogs, '{}')) as catalog
  where catalog is not null;
  if cardinality(wanted) = 0
     or cardinality(wanted) > 2000
     or exists (
       select 1 from unnest(wanted) as catalog
       where catalog not in (
         select live.catalog_material_id from private.live_product_catalogs(p_team) as live
       )
     ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return wanted;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Client RPCs.

/*
 * Schedules catalogs on an interval, reschedules them, or — with a null interval — takes them off
 * the schedule. A catalog newly scheduled, or given a different interval, is due one interval from
 * now; one that keeps its interval keeps its due time.
 */
create or replace function public.set_team_catalog_update_interval(
  p_team uuid,
  p_catalogs uuid[],
  p_interval text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  wanted uuid[];
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_interval is not null and private.catalog_updater_interval(p_interval) is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  wanted := private.checked_catalogs(p_team, p_catalogs);

  insert into public.team_catalog_updaters (team_id) values (p_team)
  on conflict (team_id) do nothing;
  perform 1 from public.team_catalog_updaters where team_id = p_team for update;

  if p_interval is null then
    -- Off the schedule means no update is waiting either, unless a worker is already on it.
    update public.team_catalog_updater_items as item
       set update_interval = null,
           next_run_at = null,
           round_due_at = case
             when item.lease_expires_at > clock_timestamp() then item.round_due_at
           end
     where item.team_id = p_team and item.catalog_material_id = any(wanted);
  else
    insert into public.team_catalog_updater_items (
      catalog_material_id, team_id, update_interval, next_run_at
    )
    select catalog, p_team, p_interval,
           clock_timestamp() + private.catalog_updater_interval(p_interval)
    from unnest(wanted) as catalog
    on conflict (catalog_material_id) do update
      set update_interval = excluded.update_interval,
          next_run_at = case
            when public.team_catalog_updater_items.update_interval
                 is not distinct from excluded.update_interval
              then public.team_catalog_updater_items.next_run_at
            else excluded.next_run_at
          end;
    update public.team_catalog_updaters
       set update_interval = p_interval
     where team_id = p_team;
  end if;

  perform private.sync_catalog_updater(p_team);
  return private.catalog_updater_state(p_team);
end;
$$;

/*
 * Opens a round for catalogs this minute. A scheduled catalog's next run moves one interval from
 * now, so "now" is not followed by a scheduled run a few minutes later. A catalog with a round
 * already waiting is left as it is. The worker is woken every ten seconds, so nothing else is
 * needed for it to start.
 */
create or replace function public.run_team_catalog_update_now(p_team uuid, p_catalogs uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  wanted uuid[];
  opened integer;
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  wanted := private.checked_catalogs(p_team, p_catalogs);

  insert into public.team_catalog_updaters (team_id) values (p_team)
  on conflict (team_id) do nothing;
  perform 1 from public.team_catalog_updaters where team_id = p_team for update;

  insert into public.team_catalog_updater_items (catalog_material_id, team_id)
  select catalog, p_team from unnest(wanted) as catalog
  on conflict (catalog_material_id) do nothing;

  update public.team_catalog_updater_items as item
     set round_due_at = clock_timestamp(),
         next_attempt_at = clock_timestamp(),
         attempts = 0,
         next_run_at = case
           when item.update_interval is null then null
           else clock_timestamp() + private.catalog_updater_interval(item.update_interval)
         end
   where item.team_id = p_team
     and item.catalog_material_id = any(wanted)
     and item.round_due_at is null;
  get diagnostics opened = row_count;

  perform private.sync_catalog_updater(p_team);
  return opened;
end;
$$;

create or replace function public.set_team_catalog_updater_restitch(p_team uuid, p_restitch boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  insert into public.team_catalog_updaters (team_id) values (p_team)
  on conflict (team_id) do nothing;
  update public.team_catalog_updaters
     set restitch = coalesce(p_restitch, false)
   where team_id = p_team;
  perform private.sync_catalog_updater(p_team);
  return private.catalog_updater_state(p_team);
end;
$$;

-- The released client's start / save: every listed catalog on one interval, the rest unscheduled.
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
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_interval is null or private.catalog_updater_interval(p_interval) is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  wanted := private.checked_catalogs(p_team, p_catalogs);

  insert into public.team_catalog_updaters (team_id) values (p_team)
  on conflict (team_id) do nothing;
  perform 1 from public.team_catalog_updaters where team_id = p_team for update;
  update public.team_catalog_updaters
     set restitch = coalesce(p_restitch, false), update_interval = p_interval
   where team_id = p_team;

  update public.team_catalog_updater_items as item
     set update_interval = null,
         next_run_at = null,
         round_due_at = case
           when item.lease_expires_at > clock_timestamp() then item.round_due_at
         end
   where item.team_id = p_team and not (item.catalog_material_id = any(wanted));
  insert into public.team_catalog_updater_items (
    catalog_material_id, team_id, update_interval, next_run_at
  )
  select catalog, p_team, p_interval,
         clock_timestamp() + private.catalog_updater_interval(p_interval)
  from unnest(wanted) as catalog
  on conflict (catalog_material_id) do update
    set update_interval = excluded.update_interval,
        next_run_at = case
          when public.team_catalog_updater_items.update_interval
               is not distinct from excluded.update_interval
            then public.team_catalog_updater_items.next_run_at
          else excluded.next_run_at
        end;

  perform private.sync_catalog_updater(p_team);
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
  update public.team_catalog_updater_items as item
     set update_interval = null,
         next_run_at = null,
         round_due_at = case
           when item.lease_expires_at > clock_timestamp() then item.round_due_at
         end
   where item.team_id = p_team;
  perform private.sync_catalog_updater(p_team);
  return private.catalog_updater_state(p_team);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Rounds, per catalog.

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
    select distinct item.team_id
    from public.team_catalog_updater_items as item
    where item.update_interval is not null
      and item.next_run_at <= clock_timestamp()
      and item.round_due_at is null
  loop
    perform 1 from public.team_catalog_updaters as updater
    where updater.team_id = due.team_id for update skip locked;
    if not found then continue; end if;
    update public.team_catalog_updater_items as item
       set round_due_at = clock_timestamp(),
           next_attempt_at = clock_timestamp(),
           next_run_at = clock_timestamp() + private.catalog_updater_interval(item.update_interval)
     where item.team_id = due.team_id
       and item.update_interval is not null
       and item.next_run_at <= clock_timestamp()
       and item.round_due_at is null;
    opened := opened + 1;
    update public.team_catalog_updaters as updater
       set next_run_at = (
             select min(item.next_run_at) from public.team_catalog_updater_items as item
             where item.team_id = due.team_id and item.update_interval is not null
           ),
           updated_at = clock_timestamp()
     where updater.team_id = due.team_id;
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    values (due.team_id, null, 'sync_state');
  end loop;
  return opened;
end;
$$;

-- An update-now row is served whether or not anything is scheduled in the space.
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
    where item.round_due_at is not null
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
    select 1 from public.team_catalog_updater_items as item
    where item.update_interval is not null
      and item.next_run_at <= clock_timestamp()
      and item.round_due_at is null
  ) and not exists (
    select 1 from public.team_catalog_updater_items as item
    where item.round_due_at is not null
      and item.next_attempt_at <= clock_timestamp()
      and (item.lease_expires_at is null or item.lease_expires_at <= clock_timestamp())
  ) and not exists (
    select 1 from public.team_catalog_restitch_copies as copy
    where copy.role = 'retired' and copy.next_delete_at <= clock_timestamp()
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

-- An update-now row with no schedule is done once its round commits.
create or replace function private.forget_unscheduled_catalog_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.round_due_at is null and new.update_interval is null then
    delete from public.team_catalog_updater_items
    where catalog_material_id = new.catalog_material_id;
  end if;
  return null;
end;
$$;

drop trigger if exists team_catalog_updater_items_forget_unscheduled
  on public.team_catalog_updater_items;
create trigger team_catalog_updater_items_forget_unscheduled
  after update of round_due_at on public.team_catalog_updater_items
  for each row
  when (old.round_due_at is not null and new.round_due_at is null)
  execute function private.forget_unscheduled_catalog_item();

-- ---------------------------------------------------------------------------------------------
-- The registry, with each catalog's schedule.

drop function if exists public.list_team_product_catalogs(uuid);

create function public.list_team_product_catalogs(p_team uuid)
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
  last_update_error text,
  update_interval text,
  next_run_at timestamptz,
  update_pending boolean
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
           coalesce(item.update_interval is not null, false),
           record.last_update_error,
           item.update_interval,
           item.next_run_at,
           coalesce(item.round_due_at is not null, false)
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

-- ---------------------------------------------------------------------------------------------
-- Grants.

revoke all on function private.sync_catalog_updater(uuid) from public;
revoke all on function private.checked_catalogs(uuid, uuid[]) from public;
revoke all on function private.forget_unscheduled_catalog_item() from public;

revoke all on function public.list_team_product_catalogs(uuid) from public, anon, authenticated;
revoke all on function public.set_team_catalog_update_interval(uuid, uuid[], text)
  from public, anon, authenticated;
revoke all on function public.run_team_catalog_update_now(uuid, uuid[])
  from public, anon, authenticated;
revoke all on function public.set_team_catalog_updater_restitch(uuid, boolean)
  from public, anon, authenticated;

grant execute on function public.list_team_product_catalogs(uuid) to authenticated;
grant execute on function public.set_team_catalog_update_interval(uuid, uuid[], text)
  to authenticated;
grant execute on function public.run_team_catalog_update_now(uuid, uuid[]) to authenticated;
grant execute on function public.set_team_catalog_updater_restitch(uuid, boolean)
  to authenticated;
