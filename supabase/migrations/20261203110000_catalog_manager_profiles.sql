-- 039: independent update content for every product catalog.
-- Existing schedules remain in team_catalog_updater_items. Copy the current space switches
-- once so later edits to the default cannot silently change an existing catalog.
alter table public.team_product_catalogs add column last_update_error_at timestamptz;
alter table public.team_catalog_updaters add column default_restitch boolean not null default false;
update public.team_catalog_updaters set default_restitch = restitch;

create function public.get_team_catalog_updater_restitch_default(p_team uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return coalesce((select updater.default_restitch from public.team_catalog_updaters as updater
                   where updater.team_id = p_team), false);
end;
$$;
revoke all on function public.get_team_catalog_updater_restitch_default(uuid)
  from public, anon, authenticated;
grant execute on function public.get_team_catalog_updater_restitch_default(uuid)
  to authenticated;

create table public.team_catalog_update_profiles (
  catalog_material_id uuid primary key references public.team_product_catalogs(material_id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  refresh_images boolean not null,
  refresh_texts boolean not null,
  grow_products boolean not null,
  random_link_variation boolean not null,
  restitch boolean not null,
  version bigint not null default 1 check (version > 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create index team_catalog_update_profiles_team_idx
  on public.team_catalog_update_profiles(team_id, catalog_material_id);

create table public.team_catalog_update_attempts (
  attempt_id uuid primary key default gen_random_uuid(),
  catalog_material_id uuid not null references public.team_product_catalogs(material_id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  round_due_at timestamptz not null,
  trigger_kind text not null check (trigger_kind in ('schedule', 'manual', 'retry', 'unknown')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  result text not null default 'running'
    check (result in ('running', 'success', 'partial', 'failed', 'cancelled', 'unknown')),
  failure_code text check (failure_code is null or failure_code ~ '^[A-Z_]{2,64}$'),
  delivery_verified_at timestamptz,
  profile_version bigint,
  profile_snapshot jsonb,
  actual_changes jsonb,
  stage_history jsonb not null default '[]'::jsonb,
  source_attempt_id uuid,
  unique (catalog_material_id, round_due_at)
);
create index team_catalog_update_attempts_recent
  on public.team_catalog_update_attempts(catalog_material_id, started_at desc);

alter table public.team_catalog_update_attempts enable row level security;
alter table public.team_catalog_update_attempts force row level security;
revoke all on public.team_catalog_update_attempts from public, anon, authenticated;
create policy team_catalog_update_attempts_view
  on public.team_catalog_update_attempts for select to authenticated
  using (private.can(team_id, 'view', auth.uid()));
grant select (attempt_id, catalog_material_id, team_id, trigger_kind, started_at,
              ended_at, result, failure_code, delivery_verified_at)
  on public.team_catalog_update_attempts to authenticated;

-- Existing in-flight work has no known trigger. Preserve it as `unknown` until completion,
-- rather than invent a manual or scheduled origin.
insert into public.team_catalog_update_attempts (
  catalog_material_id, team_id, round_due_at, trigger_kind, started_at, result
)
select item.catalog_material_id, item.team_id, item.round_due_at,
       'unknown', item.round_due_at, 'unknown'
from public.team_catalog_updater_items as item
where item.round_due_at is not null;

create function private.track_catalog_update_round()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.round_due_at is not null
     and (tg_op = 'INSERT' or old.round_due_at is distinct from new.round_due_at) then
    insert into public.team_catalog_update_attempts (
      catalog_material_id, team_id, round_due_at, trigger_kind, started_at,
      profile_version, profile_snapshot, source_attempt_id
    ) values (
      new.catalog_material_id, new.team_id, new.round_due_at,
      case when pg_catalog.current_setting('soty.catalog_retry_run', true) = 'on' then 'retry'
           when pg_catalog.current_setting('soty.catalog_manual_run', true) = 'on' then 'manual'
           else 'schedule' end,
      clock_timestamp(),
      (select profile.version from public.team_catalog_update_profiles as profile
       where profile.catalog_material_id = new.catalog_material_id),
      (select jsonb_build_object(
         'refreshImages', profile.refresh_images, 'refreshTexts', profile.refresh_texts,
         'growProducts', profile.grow_products,
         'randomLinkVariation', profile.random_link_variation,
         'restitch', profile.restitch
       ) from public.team_catalog_update_profiles as profile
       where profile.catalog_material_id = new.catalog_material_id),
      nullif(pg_catalog.current_setting('soty.catalog_source_attempt', true), '')::uuid
    ) on conflict (catalog_material_id, round_due_at) do nothing;
  elsif tg_op = 'UPDATE' and old.round_due_at is not null and new.round_due_at is null then
    update public.team_catalog_update_attempts
       set result = 'cancelled', ended_at = clock_timestamp()
     where catalog_material_id = new.catalog_material_id
       and round_due_at = old.round_due_at and result in ('running', 'unknown');
  end if;
  return new;
end;
$$;
create trigger track_catalog_update_round
after insert or update of round_due_at on public.team_catalog_updater_items
for each row execute function private.track_catalog_update_round();

create function private.track_catalog_update_result()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  current_link text;
  wants_video boolean;
begin
  if new.update_count > old.update_count then
    select record.current_video_link,
           coalesce((select (attempt.profile_snapshot ->> 'restitch')::boolean
                     from public.team_catalog_update_attempts as attempt
                     where attempt.catalog_material_id = new.material_id
                       and attempt.result in ('running', 'unknown', 'cancelled', 'failed')
                     order by attempt.started_at desc limit 1), profile.restitch)
      into current_link, wants_video
    from public.team_product_catalogs as record
    join public.team_catalog_update_profiles as profile
      on profile.catalog_material_id = record.material_id
    where record.material_id = new.material_id;
    update public.team_catalog_update_attempts as attempt
       set result = case when wants_video and current_link is not distinct from old.current_video_link
                         then 'partial' else 'success' end,
           ended_at = clock_timestamp(), delivery_verified_at = clock_timestamp(),
           failure_code = null,
           actual_changes = coalesce(attempt.actual_changes, '{}'::jsonb) ||
             jsonb_build_object('videoReplaced', wants_video and
               current_link is distinct from old.current_video_link)
     where attempt.attempt_id = (
       select recent.attempt_id from public.team_catalog_update_attempts as recent
       where recent.catalog_material_id = new.material_id
         and recent.result in ('running', 'unknown', 'cancelled', 'failed')
       order by recent.started_at desc limit 1
     );
  elsif new.last_update_error is distinct from old.last_update_error
        and new.last_update_error is not null then
    update public.team_catalog_update_attempts as attempt
       set result = 'failed', failure_code = new.last_update_error,
           ended_at = clock_timestamp()
     where attempt.attempt_id = (
       select recent.attempt_id from public.team_catalog_update_attempts as recent
       where recent.catalog_material_id = new.material_id and recent.result in ('running', 'unknown')
       order by recent.started_at desc limit 1
     );
  end if;
  return null;
end;
$$;
create constraint trigger track_catalog_update_result
after update of update_count, last_update_error on public.team_product_catalogs
deferrable initially deferred
for each row execute function private.track_catalog_update_result();

insert into public.team_catalog_update_profiles (
  catalog_material_id, team_id, refresh_images, refresh_texts, grow_products,
  random_link_variation, restitch
)
select catalog.material_id, catalog.team_id,
       coalesce(updater.refresh_images, true),
       coalesce(updater.refresh_texts, true),
       coalesce(updater.grow_products, false),
       coalesce(updater.random_link_variation,
                catalog.settings_snapshot -> 'randomLinkVariation' <> 'false'::jsonb, true),
       coalesce(updater.restitch, false)
from public.team_product_catalogs as catalog
left join public.team_catalog_updaters as updater on updater.team_id = catalog.team_id;

create function private.seed_catalog_update_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.team_catalog_update_profiles (
    catalog_material_id, team_id, refresh_images, refresh_texts, grow_products,
    random_link_variation, restitch
  )
  select new.material_id, new.team_id,
         coalesce(updater.refresh_images, true),
         coalesce(updater.refresh_texts, true),
         coalesce(updater.grow_products, false),
         coalesce(updater.random_link_variation,
                  new.settings_snapshot -> 'randomLinkVariation' <> 'false'::jsonb, true),
         coalesce(updater.default_restitch, false)
  from (select 1) as seed
  left join public.team_catalog_updaters as updater on updater.team_id = new.team_id;
  return new;
end;
$$;

create trigger seed_catalog_update_profile
after insert on public.team_product_catalogs
for each row execute function private.seed_catalog_update_profile();

alter table public.team_catalog_update_profiles enable row level security;
alter table public.team_catalog_update_profiles force row level security;
revoke all on public.team_catalog_update_profiles from public, anon, authenticated;
create policy team_catalog_update_profiles_view
  on public.team_catalog_update_profiles for select to authenticated
  using (private.can(team_id, 'view', auth.uid()));
grant select (catalog_material_id, team_id, refresh_images, refresh_texts, grow_products,
              random_link_variation, restitch, version, updated_at)
  on public.team_catalog_update_profiles to authenticated;

alter table public.team_catalog_updater_items
  add column reconciliation_required boolean not null default false;

create table private.catalog_update_reconciliations (
  catalog_material_id uuid primary key references public.team_product_catalogs(material_id) on delete cascade,
  marker uuid not null,
  baseline_version text,
  expected_count integer not null,
  swapped_copy uuid,
  product_count integer not null,
  settings_snapshot jsonb not null,
  next_check_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp()
);
revoke all on private.catalog_update_reconciliations from public, anon, authenticated;

create function public.list_team_catalog_update_profiles(p_team uuid)
returns table (
  catalog_material_id uuid, refresh_images boolean, refresh_texts boolean,
  grow_products boolean, random_link_variation boolean, restitch boolean,
  version bigint, updated_at timestamptz, last_error_at timestamptz,
  restitch_status text, restitch_blocked_code text,
  reconciliation_required boolean
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
    select profile.catalog_material_id, profile.refresh_images, profile.refresh_texts,
           profile.grow_products, profile.random_link_variation, profile.restitch,
           profile.version, profile.updated_at, catalog.last_update_error_at,
           case when exists (
             select 1 from public.team_catalog_restitch_copies as copy
             where copy.catalog_material_id = profile.catalog_material_id and copy.role = 'spare'
           ) then 'ready'
           when exists (
             select 1 from private.catalog_restitch_jobs as job
             where job.catalog_material_id = profile.catalog_material_id and job.state = 'leased'
           ) then 'preparing'
           when exists (
             select 1 from private.catalog_restitch_jobs as job
             where job.catalog_material_id = profile.catalog_material_id
               and job.last_error_code is not null
           ) then 'blocked'
           else 'waiting' end,
           (select job.last_error_code from private.catalog_restitch_jobs as job
            where job.catalog_material_id = profile.catalog_material_id
            limit 1), coalesce(item.reconciliation_required, false)
    from public.team_catalog_update_profiles as profile
    join public.team_product_catalogs as catalog
      on catalog.material_id = profile.catalog_material_id
    join private.live_product_catalogs(p_team) as live
      on live.catalog_material_id = profile.catalog_material_id
    left join public.team_catalog_updater_items as item
      on item.catalog_material_id = profile.catalog_material_id
    where profile.team_id = p_team;
end;
$$;

create function public.patch_team_catalog_update_profile(
  p_team uuid, p_catalog uuid, p_expected_version bigint, p_patch jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  changed public.team_catalog_update_profiles%rowtype;
  key text;
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  for key in select jsonb_object_keys(p_patch) loop
    if (key = 'updateInterval' and
        jsonb_typeof(p_patch -> key) not in ('string', 'null'))
       or (key = 'updateInterval' and jsonb_typeof(p_patch -> key) = 'string'
           and private.catalog_updater_interval(p_patch ->> key) is null)
       or (key <> 'updateInterval' and
           (key not in ('refreshImages', 'refreshTexts', 'growProducts',
                        'randomLinkVariation', 'restitch')
            or jsonb_typeof(p_patch -> key) <> 'boolean')) then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
  end loop;
  update public.team_catalog_update_profiles as profile
     set refresh_images = coalesce((p_patch ->> 'refreshImages')::boolean, profile.refresh_images),
         refresh_texts = coalesce((p_patch ->> 'refreshTexts')::boolean, profile.refresh_texts),
         grow_products = coalesce((p_patch ->> 'growProducts')::boolean, profile.grow_products),
         random_link_variation = coalesce((p_patch ->> 'randomLinkVariation')::boolean,
                                          profile.random_link_variation),
         restitch = coalesce((p_patch ->> 'restitch')::boolean, profile.restitch),
         version = profile.version + 1,
         updated_at = clock_timestamp(), updated_by = auth.uid()
   where profile.team_id = p_team and profile.catalog_material_id = p_catalog
     and profile.version = p_expected_version
  returning * into changed;
  if not found then
    if exists (select 1 from public.team_catalog_update_profiles
               where team_id = p_team and catalog_material_id = p_catalog) then
      raise exception 'STALE_RESULT' using errcode = '40001';
    end if;
    raise exception 'NOT_FOUND' using errcode = '22023';
  end if;
  if p_patch ? 'updateInterval' then
    perform public.set_team_catalog_update_interval(
      p_team, array[p_catalog], p_patch ->> 'updateInterval');
  end if;
  update public.team_catalog_updaters as updater
     set restitch = exists (
       select 1 from public.team_catalog_update_profiles as profile
       where profile.team_id = p_team and profile.restitch
     )
   where updater.team_id = p_team;
  perform private.sync_catalog_updater(p_team);
  return jsonb_build_object(
    'catalogId', changed.catalog_material_id,
    'refreshImages', changed.refresh_images,
    'refreshTexts', changed.refresh_texts,
    'growProducts', changed.grow_products,
    'randomLinkVariation', changed.random_link_variation,
    'restitch', changed.restitch,
    'version', changed.version,
    'updatedAt', changed.updated_at
  );
end;
$$;

create function public.list_team_catalog_update_attempts(
  p_team uuid, p_catalog uuid, p_limit integer default 10
)
returns table (
  attempt_id uuid, catalog_material_id uuid, trigger_kind text,
  started_at timestamptz, ended_at timestamptz, result text,
  failure_code text, delivery_verified_at timestamptz,
  profile_version bigint, source_attempt_id uuid, profile_snapshot jsonb,
  stage_history jsonb, actual_changes jsonb
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
    select attempt.attempt_id, attempt.catalog_material_id, attempt.trigger_kind,
           attempt.started_at, attempt.ended_at, attempt.result,
           attempt.failure_code, attempt.delivery_verified_at,
           attempt.profile_version, attempt.source_attempt_id, attempt.profile_snapshot,
           attempt.stage_history, attempt.actual_changes
    from public.team_catalog_update_attempts as attempt
    where attempt.team_id = p_team and attempt.catalog_material_id = p_catalog
    order by attempt.started_at desc
    limit least(greatest(p_limit, 1), 50);
end;
$$;

revoke all on function public.list_team_catalog_update_profiles(uuid) from public, anon, authenticated;
revoke all on function public.list_team_catalog_update_attempts(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.patch_team_catalog_update_profile(uuid, uuid, bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.list_team_catalog_update_profiles(uuid) to authenticated;
grant execute on function public.list_team_catalog_update_attempts(uuid, uuid, integer)
  to authenticated;
grant execute on function public.patch_team_catalog_update_profile(uuid, uuid, bigint, jsonb)
  to authenticated;

create or replace function private.queue_restitch_jobs(p_team uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into private.catalog_restitch_jobs (catalog_material_id, team_id)
  select item.catalog_material_id, p_team
  from public.team_catalog_updater_items as item
  join public.team_catalog_update_profiles as profile
    on profile.catalog_material_id = item.catalog_material_id
  where item.team_id = p_team and profile.restitch
    and (item.update_interval is not null or item.round_due_at is not null)
    and not exists (
      select 1 from public.team_catalog_restitch_copies as copy
      where copy.catalog_material_id = item.catalog_material_id and copy.role = 'spare'
    )
  on conflict (catalog_material_id) do nothing;
end;
$$;

create or replace function private.sync_catalog_updater(p_team uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare earliest timestamptz; preparing_one_off boolean;
begin
  delete from public.team_catalog_updater_items as item
  where item.team_id = p_team and item.update_interval is null and item.round_due_at is null
    and item.paused_interval is null;

  select min(item.next_run_at) into earliest
  from public.team_catalog_updater_items as item
  where item.team_id = p_team and item.update_interval is not null;

  select exists (
    select 1 from public.team_catalog_updater_items as item
    join public.team_catalog_update_profiles as profile
      on profile.catalog_material_id = item.catalog_material_id
    left join public.team_catalog_update_attempts as attempt
      on attempt.catalog_material_id = item.catalog_material_id
     and attempt.round_due_at = item.round_due_at
    where item.team_id = p_team
      and coalesce((attempt.profile_snapshot ->> 'restitch')::boolean, profile.restitch)
      and item.round_due_at is not null
  ) into preparing_one_off;

  update public.team_catalog_updaters as updater
     set state = case when earliest is null and not preparing_one_off then 'stopped' else 'running' end,
         next_run_at = earliest,
         started_at = case
           when earliest is null and not preparing_one_off then updater.started_at
           when updater.state <> 'running' then clock_timestamp()
           else updater.started_at end,
         started_by = case
           when (earliest is not null or preparing_one_off) and updater.state <> 'running'
             then auth.uid() else updater.started_by end,
         updated_by = coalesce(auth.uid(), updater.updated_by),
         updated_at = clock_timestamp()
   where updater.team_id = p_team;

  if exists (select 1 from public.team_catalog_updaters
             where team_id = p_team and state = 'running') then
    perform private.retire_restitch_spares(p_team, array(
      select item.catalog_material_id from public.team_catalog_updater_items as item
      join public.team_catalog_update_profiles as profile
        on profile.catalog_material_id = item.catalog_material_id
      where item.team_id = p_team and profile.restitch
        and (item.update_interval is not null or item.round_due_at is not null
             or item.paused_interval is not null)
    ));
    perform private.queue_restitch_jobs(p_team);
  else
    perform private.retire_restitch_spares(p_team, array(
      select item.catalog_material_id from public.team_catalog_updater_items as item
      join public.team_catalog_update_profiles as profile
        on profile.catalog_material_id = item.catalog_material_id
      where item.team_id = p_team and profile.restitch and item.paused_interval is not null
    ));
  end if;

  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (p_team, null, 'sync_state');
end;
$$;

-- A one-off run waits for a video only when that catalog asks for one. Scheduled work
-- may proceed with the current video; unavailable local work cannot block the sheet.
create or replace function private.claim_catalog_updater_items(
  p_worker text, p_limit integer default 10, p_lease_seconds integer default 60
)
returns setof public.team_catalog_updater_items
language plpgsql security definer set search_path = '' as $$
declare slots integer; gone record;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(72301500) then return; end if;
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
    perform private.sync_catalog_updater(gone.team_id);
  end loop;

  select greatest(0, 12 - count(*)::integer) into slots
  from public.team_catalog_updater_items where lease_expires_at > clock_timestamp();
  if slots = 0 then return; end if;

  return query
  with candidates as (
    select item.catalog_material_id
    from public.team_catalog_updater_items as item
    join public.team_catalog_update_profiles as profile
      on profile.catalog_material_id = item.catalog_material_id
    left join public.team_catalog_update_attempts as attempt
      on attempt.catalog_material_id = item.catalog_material_id
     and attempt.round_due_at = item.round_due_at
    left join private.catalog_restitch_jobs as job
      on job.catalog_material_id = item.catalog_material_id
    where item.round_due_at is not null
      and item.next_attempt_at <= clock_timestamp()
      and (item.lease_expires_at is null or item.lease_expires_at <= clock_timestamp())
      and private.team_workspace_allowed(item.team_id)
      and (
        item.update_interval is not null
        or not coalesce((attempt.profile_snapshot ->> 'restitch')::boolean, profile.restitch)
        or exists (
          select 1 from public.team_catalog_restitch_copies as copy
          where copy.catalog_material_id = item.catalog_material_id and copy.role = 'spare'
        )
        or (item.round_due_at <= clock_timestamp() - interval '30 minutes'
            and (job.catalog_material_id is null or job.state <> 'leased'
                 or job.lease_expires_at <= clock_timestamp()))
      )
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

-- Keep the worker's existing return shape; only the effective values change. The profile
-- row is immutable for an already claimed item because its booleans travel with the claim.
drop function public.service_claim_catalog_updater_items(text, integer, integer);
create function public.service_claim_catalog_updater_items(
  p_worker text, p_limit integer default 10, p_lease_seconds integer default 60
)
returns table (
  catalog_material_id uuid, team_id uuid, attempts integer, update_count integer,
  product_count smallint, source_link text, video_link text, settings_snapshot jsonb,
  drive_file_id text, resource_key text, credential_id uuid, current_video_link text,
  spare_material_id uuid, spare_link text, refresh_images boolean, refresh_texts boolean,
  price_min integer, price_max integer, grow_products boolean, random_link_variation boolean
)
language sql security definer set search_path = '' as $$
  select item.catalog_material_id, item.team_id, item.attempts,
         record.update_count, record.product_count, record.source_link, record.video_link,
         record.settings_snapshot, sheet.drive_file_id, sheet.resource_key,
         connection.credential_id, record.current_video_link, spare.material_id, spare.shared_link,
         coalesce((attempt.profile_snapshot ->> 'refreshImages')::boolean, profile.refresh_images),
         coalesce((attempt.profile_snapshot ->> 'refreshTexts')::boolean, profile.refresh_texts),
         settings.price_min, settings.price_max,
         coalesce((attempt.profile_snapshot ->> 'growProducts')::boolean, profile.grow_products),
         coalesce((attempt.profile_snapshot ->> 'randomLinkVariation')::boolean,
                  profile.random_link_variation)
  from private.claim_catalog_updater_items(p_worker, p_limit, p_lease_seconds) as item
  join public.team_product_catalogs as record on record.material_id = item.catalog_material_id
  join public.team_catalog_update_profiles as profile
    on profile.catalog_material_id = item.catalog_material_id
  left join public.team_catalog_update_attempts as attempt
    on attempt.catalog_material_id = item.catalog_material_id
   and attempt.round_due_at = item.round_due_at
  join public.team_materials as sheet on sheet.id = item.catalog_material_id
  join public.team_drive_connections as connection on connection.id = sheet.connection_id
  left join public.team_product_catalog_settings as settings on settings.team_id = item.team_id
  left join lateral (
    select copy.material_id, copy.shared_link
    from public.team_catalog_restitch_copies as copy
    join public.team_materials as file on file.id = copy.material_id
    where coalesce((attempt.profile_snapshot ->> 'restitch')::boolean, profile.restitch)
      and copy.catalog_material_id = item.catalog_material_id
      and copy.role = 'spare' and file.lifecycle = 'active'
  ) as spare on true
  where connection.state in ('connected', 'unavailable');
$$;

revoke all on function public.service_claim_catalog_updater_items(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.service_claim_catalog_updater_items(text, integer, integer)
  to service_role;

-- Disabling future runs leaves a claimed or queued attempt intact. The separate cancel RPC
-- below owns interruption. Keep the existing per-catalog schedule calculation.
create or replace function public.set_team_catalog_update_interval(
  p_team uuid, p_catalogs uuid[], p_interval text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare wanted uuid[];
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
    update public.team_catalog_updater_items as item
       set update_interval = null, next_run_at = null, paused_interval = null
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
          end,
          paused_interval = null;
    update public.team_catalog_updaters set update_interval = p_interval where team_id = p_team;
  end if;
  perform private.clear_tariff_pause_mark(p_team);
  perform private.sync_catalog_updater(p_team);
  return private.catalog_updater_state(p_team);
end;
$$;

-- A manual run never shifts the next scheduled due time.
create or replace function public.run_team_catalog_update_now(p_team uuid, p_catalogs uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare wanted uuid[]; opened integer;
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
  perform pg_catalog.set_config('soty.catalog_manual_run', 'on', true);
  update public.team_catalog_updater_items as item
     set round_due_at = clock_timestamp(), next_attempt_at = clock_timestamp(), attempts = 0
   where item.team_id = p_team and item.catalog_material_id = any(wanted)
     and item.round_due_at is null and not item.reconciliation_required;
  get diagnostics opened = row_count;
  perform pg_catalog.set_config('soty.catalog_manual_run', 'off', true);
  perform private.sync_catalog_updater(p_team);
  return opened;
end;
$$;

create or replace function public.service_open_catalog_updater_rounds()
returns integer language plpgsql security definer set search_path = '' as $$
declare opened integer := 0; due record;
begin
  for due in
    select distinct item.team_id from public.team_catalog_updater_items as item
    where item.update_interval is not null and item.next_run_at <= clock_timestamp()
      and item.round_due_at is null and not item.reconciliation_required
  loop
    perform 1 from public.team_catalog_updaters as updater
    where updater.team_id = due.team_id for update skip locked;
    if not found then continue; end if;
    update public.team_catalog_updater_items as item
       set round_due_at = clock_timestamp(), next_attempt_at = clock_timestamp(),
           next_run_at = clock_timestamp() + private.catalog_updater_interval(item.update_interval)
     where item.team_id = due.team_id and item.update_interval is not null
       and item.next_run_at <= clock_timestamp() and item.round_due_at is null
       and not item.reconciliation_required;
    opened := opened + 1;
    update public.team_catalog_updaters as updater
       set next_run_at = (
         select min(item.next_run_at) from public.team_catalog_updater_items as item
         where item.team_id = due.team_id and item.update_interval is not null
           and not item.reconciliation_required),
           updated_at = clock_timestamp()
     where updater.team_id = due.team_id;
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    values (due.team_id, null, 'sync_state');
  end loop;
  return opened;
end;
$$;

create function public.cancel_team_catalog_update(p_team uuid, p_catalog uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare cancelled integer;
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.team_catalog_updater_items as item
     set round_due_at = null, attempts = 0, lease_owner = null,
         lease_expires_at = null, next_attempt_at = clock_timestamp()
   where item.team_id = p_team and item.catalog_material_id = p_catalog
     and item.round_due_at is not null
     and (item.lease_owner is null or item.lease_expires_at <= clock_timestamp());
  get diagnostics cancelled = row_count;
  if cancelled = 0 and exists (
    select 1 from public.team_catalog_updater_items as item
    where item.team_id = p_team and item.catalog_material_id = p_catalog
      and item.round_due_at is not null and item.lease_expires_at > clock_timestamp()
  ) then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;
  perform private.sync_catalog_updater(p_team);
  return cancelled > 0;
end;
$$;

revoke all on function public.cancel_team_catalog_update(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_team_catalog_update(uuid, uuid) to authenticated;

create function public.retry_team_catalog_update(
  p_team uuid, p_catalog uuid, p_source_attempt uuid
)
returns integer language plpgsql security definer set search_path = '' as $$
declare opened integer;
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.team_catalog_update_attempts as attempt
    where attempt.team_id = p_team and attempt.catalog_material_id = p_catalog
      and attempt.attempt_id = p_source_attempt
      and attempt.result in ('failed', 'partial')
  ) then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  perform pg_catalog.set_config('soty.catalog_retry_run', 'on', true);
  perform pg_catalog.set_config('soty.catalog_source_attempt', p_source_attempt::text, true);
  opened := public.run_team_catalog_update_now(p_team, array[p_catalog]);
  perform pg_catalog.set_config('soty.catalog_retry_run', 'off', true);
  perform pg_catalog.set_config('soty.catalog_source_attempt', '', true);
  return opened;
end;
$$;
revoke all on function public.retry_team_catalog_update(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.retry_team_catalog_update(uuid, uuid, uuid) to authenticated;

-- Agent-readable, content-free diagnosis. The analytics role is SELECT-only, so this
-- view exposes only identifiers, bounded configuration flags and outcome evidence.
create view public.analytics_catalog_updates as
select attempt.attempt_id, attempt.catalog_material_id, attempt.team_id,
       attempt.trigger_kind, attempt.started_at, attempt.ended_at,
       attempt.result, attempt.failure_code, attempt.delivery_verified_at,
       attempt.profile_version, attempt.source_attempt_id, attempt.stage_history,
       attempt.actual_changes,
       profile.version as current_profile_version,
       item.update_interval, item.next_run_at, item.reconciliation_required,
       catalog.last_updated_at as last_success_at,
       catalog.last_update_error as last_error_code,
       catalog.last_update_error_at as last_error_at
from public.team_catalog_update_attempts as attempt
join public.team_product_catalogs as catalog
  on catalog.material_id = attempt.catalog_material_id
join public.team_catalog_update_profiles as profile
  on profile.catalog_material_id = attempt.catalog_material_id
left join public.team_catalog_updater_items as item
  on item.catalog_material_id = attempt.catalog_material_id;
revoke all on public.analytics_catalog_updates from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'wishly_analytics_ro') then
    grant select on public.analytics_catalog_updates to wishly_analytics_ro;
  end if;
end
$$;

create or replace function public.service_retry_catalog_update(
  p_item uuid, p_worker text, p_error text, p_next_attempt_at timestamptz
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare owning_team uuid; tries integer;
begin
  if p_error is null or p_error !~ '^[A-Z_]{2,64}$' or p_next_attempt_at is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update public.team_catalog_updater_items as item
     set lease_owner = null, lease_expires_at = null, next_attempt_at = p_next_attempt_at
   where item.catalog_material_id = p_item and item.lease_owner = p_worker
     and item.lease_expires_at > clock_timestamp()
  returning item.team_id, item.attempts into owning_team, tries;
  if owning_team is null then return false; end if;
  if tries >= 3 then
    update public.team_product_catalogs as record
       set last_update_error = p_error, last_update_error_at = clock_timestamp()
     where record.material_id = p_item;
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    values (owning_team, p_item, 'upserted');
  end if;
  return true;
end;
$$;

-- Once a Drive write was attempted, an error is not evidence that the sheet is
-- unchanged. Stop automatic replay so growth/random draws cannot be applied twice.
create function public.service_begin_catalog_update_write(
  p_item uuid, p_worker text, p_marker uuid, p_baseline_version text,
  p_expected_count integer, p_swapped_copy uuid, p_product_count integer,
  p_settings_snapshot jsonb
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_marker is null or p_expected_count is null or p_product_count is null
     or p_settings_snapshot is null or jsonb_typeof(p_settings_snapshot) <> 'object' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update public.team_catalog_updater_items as item
     set reconciliation_required = true, next_attempt_at = 'infinity'::timestamptz
   where item.catalog_material_id = p_item and item.lease_owner = p_worker
     and item.lease_expires_at > clock_timestamp() and item.round_due_at is not null
     and not item.reconciliation_required;
  if not found then return false; end if;
  insert into private.catalog_update_reconciliations
    (catalog_material_id, marker, baseline_version, expected_count, swapped_copy,
     product_count, settings_snapshot)
  values (p_item, p_marker, p_baseline_version, p_expected_count, p_swapped_copy,
          p_product_count, p_settings_snapshot);
  return true;
end;
$$;
revoke all on function public.service_begin_catalog_update_write(uuid,text,uuid,text,integer,uuid,integer,jsonb)
  from public, anon, authenticated;
grant execute on function public.service_begin_catalog_update_write(uuid,text,uuid,text,integer,uuid,integer,jsonb)
  to service_role;

create function public.service_finish_catalog_update_write(p_item uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  delete from private.catalog_update_reconciliations as pending
  using public.team_product_catalogs as catalog
  where pending.catalog_material_id = p_item and catalog.material_id = p_item
    and catalog.update_count >= pending.expected_count;
  if not found then return false; end if;
  update public.team_catalog_updater_items as item
     set reconciliation_required = false
   where item.catalog_material_id = p_item;
  return true;
end;
$$;
revoke all on function public.service_finish_catalog_update_write(uuid)
  from public, anon, authenticated;
grant execute on function public.service_finish_catalog_update_write(uuid) to service_role;

create function public.service_mark_catalog_update_unknown(
  p_item uuid, p_worker text, p_error text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare due_at timestamptz;
begin
  if p_error is null or p_error !~ '^[A-Z_]{2,64}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select item.round_due_at into due_at
  from public.team_catalog_updater_items as item
  where item.catalog_material_id = p_item and item.lease_owner = p_worker
    and item.lease_expires_at > clock_timestamp()
    and item.round_due_at is not null
  for update;
  if not found then return false; end if;
  update public.team_catalog_updater_items as item
     set lease_owner = null, lease_expires_at = null,
         reconciliation_required = true, next_attempt_at = 'infinity'::timestamptz
   where item.catalog_material_id = p_item and item.lease_owner = p_worker
     and item.lease_expires_at > clock_timestamp()
     and item.round_due_at is not null
  ;
  update public.team_catalog_update_attempts as attempt
     set result = 'unknown', failure_code = p_error, ended_at = clock_timestamp()
   where attempt.catalog_material_id = p_item and attempt.round_due_at = due_at;
  return true;
end;
$$;
revoke all on function public.service_mark_catalog_update_unknown(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.service_mark_catalog_update_unknown(uuid, text, text)
  to service_role;

create function public.service_claim_catalog_reconciliations(p_limit integer default 3)
returns table (
  catalog_material_id uuid, marker uuid, baseline_version text,
  drive_file_id text, resource_key text, credential_id uuid
)
language plpgsql security definer set search_path = '' as $$
begin
  return query
  with due as (
    select pending.catalog_material_id
    from private.catalog_update_reconciliations as pending
    join public.team_catalog_updater_items as item
      on item.catalog_material_id = pending.catalog_material_id
    where pending.next_check_at <= clock_timestamp()
      and item.reconciliation_required
      and (item.lease_expires_at is null or item.lease_expires_at <= clock_timestamp())
    order by pending.next_check_at
    for update of pending skip locked
    limit least(greatest(p_limit, 1), 10)
  ), claimed as (
    update private.catalog_update_reconciliations as pending
       set next_check_at = clock_timestamp() + interval '5 minutes'
      from due where pending.catalog_material_id = due.catalog_material_id
    returning pending.catalog_material_id, pending.marker, pending.baseline_version
  )
  select claimed.catalog_material_id, claimed.marker, claimed.baseline_version,
         material.drive_file_id, material.resource_key, connection.credential_id
  from claimed
  join public.team_materials as material on material.id = claimed.catalog_material_id
  join public.team_drive_connections as connection on connection.id = material.connection_id;
end;
$$;
revoke all on function public.service_claim_catalog_reconciliations(integer)
  from public, anon, authenticated;
grant execute on function public.service_claim_catalog_reconciliations(integer) to service_role;

create function public.service_resolve_catalog_reconciliation(
  p_item uuid, p_marker uuid, p_outcome text, p_worker text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare pending private.catalog_update_reconciliations; done boolean;
begin
  if p_outcome not in ('delivered', 'unchanged') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into pending from private.catalog_update_reconciliations
  where catalog_material_id = p_item and marker = p_marker for update;
  if not found then return false; end if;
  if exists (
    select 1 from public.team_product_catalogs as catalog
    where catalog.material_id = p_item and catalog.update_count >= pending.expected_count
  ) then
    return public.service_finish_catalog_update_write(p_item);
  end if;
  if p_outcome = 'unchanged' then
    update public.team_catalog_updater_items as item
       set reconciliation_required = false, next_attempt_at = clock_timestamp(),
           attempts = 0
     where item.catalog_material_id = p_item and item.reconciliation_required
       and item.round_due_at is not null
       and (item.lease_expires_at is null or item.lease_expires_at <= clock_timestamp());
    if not found then return false; end if;
    update public.team_catalog_update_attempts as attempt
       set result = 'running', ended_at = null, failure_code = null
     where attempt.catalog_material_id = p_item and attempt.result = 'unknown'
       and attempt.round_due_at = (
         select item.round_due_at from public.team_catalog_updater_items as item
         where item.catalog_material_id = p_item);
    delete from private.catalog_update_reconciliations where catalog_material_id = p_item;
    return true;
  end if;
  update public.team_catalog_updater_items as item
     set lease_owner = p_worker, lease_expires_at = clock_timestamp() + interval '5 minutes'
   where item.catalog_material_id = p_item and item.reconciliation_required
     and item.round_due_at is not null
     and (item.lease_expires_at is null or item.lease_expires_at <= clock_timestamp());
  if not found then return false; end if;
  done := public.service_complete_catalog_update(
    p_item, p_worker, pending.expected_count, pending.swapped_copy,
    pending.product_count, pending.settings_snapshot);
  if not done then return false; end if;
  return public.service_finish_catalog_update_write(p_item);
end;
$$;
revoke all on function public.service_resolve_catalog_reconciliation(uuid,uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.service_resolve_catalog_reconciliation(uuid,uuid,text,text)
  to service_role;

create or replace function private.invoke_catalog_updater_worker()
returns bigint language plpgsql security definer set search_path = '' as $$
declare endpoint text; worker_secret text; request_id bigint;
begin
  if not exists (
    select 1 from public.team_catalog_updater_items as item
    where item.update_interval is not null and item.next_run_at <= clock_timestamp()
      and item.round_due_at is null and not item.reconciliation_required
  ) and not exists (
    select 1 from public.team_catalog_updater_items as item
    where item.round_due_at is not null and item.next_attempt_at <= clock_timestamp()
      and not item.reconciliation_required
      and (item.lease_expires_at is null or item.lease_expires_at <= clock_timestamp())
  ) and not exists (
    select 1 from private.catalog_update_reconciliations as pending
    where pending.next_check_at <= clock_timestamp()
  ) and not exists (
    select 1 from public.team_catalog_restitch_copies as copy
    where copy.role = 'retired' and copy.next_delete_at <= clock_timestamp()
  ) then return null; end if;
  if (select count(*) from public.team_catalog_updater_items
      where lease_expires_at > clock_timestamp()) >= 12 then return null; end if;
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

-- The legacy space switch is now only the template for catalogs created later.
create or replace function public.set_team_catalog_updater_restitch(p_team uuid, p_restitch boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_restitch is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  insert into public.team_catalog_updaters (team_id, default_restitch)
  values (p_team, p_restitch)
  on conflict (team_id) do update set default_restitch = excluded.default_restitch;
  return private.catalog_updater_state(p_team);
end;
$$;

-- Preserve the worker's proven stages for the attempt history and agent diagnosis.
alter table private.catalog_update_progress
  drop constraint catalog_update_progress_stage_check;
alter table private.catalog_update_progress
  add constraint catalog_update_progress_stage_check
  check (stage in ('preparing', 'refreshing', 'building', 'uploading', 'verifying', 'finalizing'));
create or replace function public.service_set_catalog_update_progress(
  p_item uuid, p_worker text, p_stage text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare due_at timestamptz;
begin
  if p_stage not in ('preparing', 'refreshing', 'building', 'uploading', 'verifying', 'finalizing') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select item.round_due_at into due_at
  from public.team_catalog_updater_items as item
  where item.catalog_material_id = p_item
    and item.round_due_at is not null
    and item.lease_owner = p_worker
    and item.lease_expires_at > clock_timestamp();
  if not found then return false; end if;
  insert into private.catalog_update_progress (catalog_material_id, worker, stage, updated_at)
  values (p_item, p_worker, p_stage, clock_timestamp())
  on conflict (catalog_material_id) do update
    set worker = excluded.worker, stage = excluded.stage, updated_at = excluded.updated_at;
  update public.team_catalog_update_attempts as attempt
     set stage_history = attempt.stage_history || jsonb_build_array(
       jsonb_build_object('stage', p_stage, 'at', clock_timestamp()))
   where attempt.catalog_material_id = p_item and attempt.round_due_at = due_at
     and attempt.result in ('running', 'unknown')
     and coalesce(attempt.stage_history -> -1 ->> 'stage', '') <> p_stage;
  return true;
end;
$$;

-- Content-free evidence recorded only by the worker holding the active lease.
create function public.service_record_catalog_update_changes(
  p_item uuid, p_worker text, p_changes jsonb
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare due_at timestamptz; key text;
begin
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  for key in select jsonb_object_keys(p_changes) loop
    if key not in ('productIds', 'linksVaried', 'imagesRefreshed',
                   'textsRefreshed', 'productsAdded')
       or jsonb_typeof(p_changes -> key) <> 'boolean' then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
  end loop;
  select item.round_due_at into due_at from public.team_catalog_updater_items as item
  where item.catalog_material_id = p_item and item.lease_owner = p_worker
    and item.lease_expires_at > clock_timestamp() and item.round_due_at is not null;
  if not found then return false; end if;
  update public.team_catalog_update_attempts as attempt
     set actual_changes = p_changes
   where attempt.catalog_material_id = p_item and attempt.round_due_at = due_at
     and attempt.result in ('running', 'unknown');
  return found;
end;
$$;
revoke all on function public.service_record_catalog_update_changes(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.service_record_catalog_update_changes(uuid, text, jsonb)
  to service_role;
