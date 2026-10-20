-- Persist explicit local calendar schedules with versioned profile edits.
begin;
create function private.valid_catalog_schedule(p_schedule jsonb)
returns boolean language plpgsql stable set search_path = '' as $$
begin
  if p_schedule is null then return true; end if;
  if jsonb_typeof(p_schedule) <> 'object' then return false; end if;
  if not (p_schedule ?& array['timeZone','weekday','time'])
     or (select count(*) from jsonb_object_keys(p_schedule)) <> 3
     or jsonb_typeof(p_schedule -> 'timeZone') <> 'string'
     or jsonb_typeof(p_schedule -> 'weekday') <> 'number'
     or jsonb_typeof(p_schedule -> 'time') <> 'string'
     or (p_schedule ->> 'weekday') !~ '^[1-7]$'
     or (p_schedule ->> 'time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then return false; end if;
  return exists (select 1 from pg_catalog.pg_timezone_names as zone
    where zone.name = p_schedule ->> 'timeZone'
      and (zone.name = 'UTC' or strpos(zone.name, '/') > 0));
end;
$$;
revoke all on function private.valid_catalog_schedule(jsonb) from public, anon, authenticated;

alter table public.team_catalog_update_profiles add column schedule jsonb;
alter table public.team_catalog_update_profiles add constraint catalog_update_schedule_check
  check (private.valid_catalog_schedule(schedule));

-- Calendar intervals keep civil wall time across DST. PostgreSQL resolves a skipped
-- wall time forward through the gap and an ambiguous time to its later/standard occurrence.
-- Hour intervals advance from the existing anchor, skipping missed slots without drift.
create function private.next_catalog_schedule(
  p_interval text, p_schedule jsonb, p_after timestamptz, p_anchor timestamptz default null
)
returns timestamptz language plpgsql stable set search_path = '' as $$
declare cadence interval; zone text; local_day date; candidate timestamptz; seconds double precision;
begin
  cadence := private.catalog_updater_interval(p_interval);
  if cadence is null or p_after is null or not private.valid_catalog_schedule(p_schedule) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_schedule is null then return p_after + cadence; end if;
  zone := p_schedule ->> 'timeZone';
  local_day := (p_after at time zone zone)::date;
  if p_interval = '1w' then
    local_day := local_day + (((p_schedule ->> 'weekday')::integer
      - extract(isodow from local_day)::integer + 7) % 7);
  end if;
  candidate := (local_day + (p_schedule ->> 'time')::time) at time zone zone;
  if p_interval in ('1d','1w') then
    if candidate <= p_after then
      local_day := local_day + case when p_interval = '1w' then 7 else 1 end;
      candidate := (local_day + (p_schedule ->> 'time')::time) at time zone zone;
    end if;
    return candidate;
  end if;
  candidate := coalesce(p_anchor, candidate);
  if candidate > p_after then return candidate; end if;
  seconds := extract(epoch from cadence);
  return candidate + make_interval(secs =>
    (floor(extract(epoch from (p_after - candidate)) / seconds) + 1) * seconds);
end;
$$;
revoke all on function private.next_catalog_schedule(text,jsonb,timestamptz,timestamptz)
  from public, anon, authenticated;
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
  -- Legacy interval-only callers must not silently carry an old calendar anchor to a new cadence.
  update public.team_catalog_update_profiles as profile
     set schedule = null, version = profile.version + 1,
         updated_at = clock_timestamp(), updated_by = auth.uid()
   where profile.team_id = p_team and profile.catalog_material_id = any(wanted)
     and profile.schedule is not null
     and (select item.update_interval from public.team_catalog_updater_items as item
          where item.catalog_material_id = profile.catalog_material_id) is distinct from p_interval;
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

create or replace function public.patch_team_catalog_update_profile(
  p_team uuid, p_catalog uuid, p_expected_version bigint, p_patch jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare changed public.team_catalog_update_profiles%rowtype; key text;
  previous_interval text; target_interval text; target_schedule jsonb; previous_version bigint;
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  for key in select jsonb_object_keys(p_patch) loop
    if key = 'updateInterval' then
      if jsonb_typeof(p_patch -> key) not in ('string','null') or
         (jsonb_typeof(p_patch -> key) = 'string' and private.catalog_updater_interval(p_patch ->> key) is null) then
        raise exception 'INVALID_INPUT' using errcode = '22023';
      end if;
    elsif key = 'schedule' then
      if not private.valid_catalog_schedule(nullif(p_patch -> key, 'null'::jsonb)) then
        raise exception 'INVALID_INPUT' using errcode = '22023';
      end if;
    elsif key not in ('refreshImages','refreshTexts','growProducts','randomLinkVariation','restitch')
          or jsonb_typeof(p_patch -> key) <> 'boolean' then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
  end loop;
  insert into public.team_catalog_updaters (team_id) values (p_team) on conflict (team_id) do nothing;
  -- Same lock order as interval setters and scheduled workers: team, then profile/item.
  perform 1 from public.team_catalog_updaters where team_id = p_team for update;
  select * into changed from public.team_catalog_update_profiles
   where team_id = p_team and catalog_material_id = p_catalog for update;
  if not found then raise exception 'NOT_FOUND' using errcode = '22023'; end if;
  if changed.version is distinct from p_expected_version then raise exception 'STALE_RESULT' using errcode = '40001'; end if;
  previous_version := changed.version;
  select item.update_interval into previous_interval from public.team_catalog_updater_items as item
   where item.catalog_material_id = p_catalog;
  target_interval := case when p_patch ? 'updateInterval' then p_patch ->> 'updateInterval' else previous_interval end;
  target_schedule := case when p_patch ? 'schedule' then nullif(p_patch -> 'schedule','null'::jsonb)
    when target_interval is distinct from previous_interval then null else changed.schedule end;
  if target_schedule is not null and target_interval is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_patch ? 'updateInterval' then
    perform public.set_team_catalog_update_interval(p_team,array[p_catalog],target_interval);
  end if;
  update public.team_catalog_update_profiles as profile
     set refresh_images = coalesce((p_patch ->> 'refreshImages')::boolean, profile.refresh_images),
         refresh_texts = coalesce((p_patch ->> 'refreshTexts')::boolean, profile.refresh_texts),
         grow_products = coalesce((p_patch ->> 'growProducts')::boolean, profile.grow_products),
         random_link_variation = coalesce((p_patch ->> 'randomLinkVariation')::boolean, profile.random_link_variation),
         restitch = coalesce((p_patch ->> 'restitch')::boolean, profile.restitch),
         schedule = target_schedule, version = previous_version + 1,
         updated_at = clock_timestamp(), updated_by = auth.uid()
   where profile.team_id = p_team and profile.catalog_material_id = p_catalog;
  if target_interval is not null and
     (target_interval is distinct from previous_interval or target_schedule is distinct from changed.schedule) then
    update public.team_catalog_updater_items set next_run_at = private.next_catalog_schedule(
      target_interval,target_schedule,clock_timestamp()) where catalog_material_id = p_catalog;
  end if;
  perform private.sync_catalog_updater(p_team);
  select * into changed from public.team_catalog_update_profiles where catalog_material_id = p_catalog;
  return jsonb_build_object('catalogId',changed.catalog_material_id,
    'refreshImages',changed.refresh_images,'refreshTexts',changed.refresh_texts,
    'growProducts',changed.grow_products,'randomLinkVariation',changed.random_link_variation,
    'restitch',changed.restitch,'schedule',changed.schedule,
    'version',changed.version,'updatedAt',changed.updated_at);
end;
$$;


drop function public.list_team_catalog_update_profiles(uuid);
create or replace function public.list_team_catalog_update_profiles(p_team uuid)
returns table (
  catalog_material_id uuid, refresh_images boolean, refresh_texts boolean,
  grow_products boolean, random_link_variation boolean, restitch boolean,
  version bigint, updated_at timestamptz, last_error_at timestamptz,
  restitch_status text, restitch_blocked_code text,
  reconciliation_required boolean,
  last_result text, latest_attempt_at timestamptz, last_successful_at timestamptz, schedule jsonb
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
           case when private.catalog_has_usable_spare(profile.catalog_material_id) then 'ready'
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
            limit 1), coalesce(item.reconciliation_required, false),
           latest.result, latest.started_at,
           (select max(attempt.delivery_verified_at)
              from public.team_catalog_update_attempts as attempt
             where attempt.catalog_material_id = profile.catalog_material_id
               and attempt.team_id = p_team
               and attempt.result = 'success'
               and attempt.delivery_verified_at is not null), profile.schedule
    from public.team_catalog_update_profiles as profile
    join public.team_product_catalogs as catalog
      on catalog.material_id = profile.catalog_material_id
    join private.live_product_catalogs(p_team) as live
      on live.catalog_material_id = profile.catalog_material_id
    left join public.team_catalog_updater_items as item
      on item.catalog_material_id = profile.catalog_material_id
    left join lateral (
      select attempt.result, attempt.started_at
        from public.team_catalog_update_attempts as attempt
       where attempt.catalog_material_id = profile.catalog_material_id
         and attempt.team_id = p_team
       order by attempt.started_at desc, attempt.attempt_id desc
       limit 1
    ) as latest on true
    where profile.team_id = p_team;
end;
$$;
revoke all on function public.list_team_catalog_update_profiles(uuid) from public, anon, authenticated;
grant execute on function public.list_team_catalog_update_profiles(uuid) to authenticated;


create or replace function public.service_open_catalog_updater_rounds()
returns integer language plpgsql security definer set search_path = '' as $$
declare opened integer := 0; due record;
begin
  for due in
    select distinct item.team_id from public.team_catalog_updater_items as item
    where item.update_interval is not null and item.next_run_at <= clock_timestamp()
      and item.round_due_at is null and not item.reconciliation_required
      and private.team_workspace_allowed(item.team_id)
  loop
    perform 1 from public.team_catalog_updaters as updater
    where updater.team_id = due.team_id for update skip locked;
    if not found then continue; end if;
    update public.team_catalog_updater_items as item
       set round_due_at = clock_timestamp(), next_attempt_at = clock_timestamp(),
           next_run_at = private.next_catalog_schedule(item.update_interval,
             (select profile.schedule from public.team_catalog_update_profiles as profile
              where profile.catalog_material_id = item.catalog_material_id),
             clock_timestamp(),item.next_run_at)
     where item.team_id = due.team_id and item.update_interval is not null
       and item.next_run_at <= clock_timestamp() and item.round_due_at is null
       and not item.reconciliation_required
       and private.team_workspace_allowed(item.team_id);
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

create or replace function private.track_catalog_update_round()
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
         'restitch', profile.restitch, 'schedule', profile.schedule
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
create or replace view public.analytics_catalog_updates as
select attempt.attempt_id, attempt.catalog_material_id, attempt.team_id,
       attempt.trigger_kind, attempt.started_at, attempt.ended_at,
       attempt.result, attempt.failure_code, attempt.delivery_verified_at,
       attempt.profile_version, attempt.source_attempt_id, attempt.stage_history,
       attempt.actual_changes,
       profile.version as current_profile_version,
       item.update_interval, item.next_run_at, item.reconciliation_required,
       catalog.last_updated_at as last_success_at,
       catalog.last_update_error as last_error_code,
       catalog.last_update_error_at as last_error_at,
       job.state as video_preparation_state,
       coalesce(operation.error_code, job.last_error_code) as video_preparation_error,
       job.next_attempt_at as video_preparation_retry_at,
       job.lease_expires_at as video_preparation_lease_until,
       operation.state as video_operation_state, operation.stage as video_operation_stage,
       profile.schedule, attempt.profile_snapshot -> 'schedule' as attempt_schedule
from public.team_catalog_update_attempts as attempt
join public.team_product_catalogs as catalog
  on catalog.material_id = attempt.catalog_material_id
join public.team_catalog_update_profiles as profile
  on profile.catalog_material_id = attempt.catalog_material_id
left join public.team_catalog_updater_items as item
  on item.catalog_material_id = attempt.catalog_material_id
left join private.catalog_restitch_jobs as job
  on job.catalog_material_id = attempt.catalog_material_id
left join public.team_operations as operation on operation.id = job.operation_id;

commit;
