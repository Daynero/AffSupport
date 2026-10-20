-- Manual runs with video replacement wait for the prepared copy, including catalogs with a schedule.
begin;
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
        (item.update_interval is not null and coalesce(attempt.trigger_kind, 'unknown') not in ('manual', 'retry'))
        or not coalesce((attempt.profile_snapshot ->> 'restitch')::boolean, profile.restitch)
        or exists (
          select 1 from public.team_catalog_restitch_copies as copy
          where copy.catalog_material_id = item.catalog_material_id and copy.role = 'spare'
        )
        or (coalesce(attempt.trigger_kind, 'unknown') not in ('manual', 'retry')
            and item.round_due_at <= clock_timestamp() - interval '30 minutes'
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
  if opened > 0 then
    -- A user's new run retries preparation immediately; never steal an active app lease.
    update private.catalog_restitch_jobs as job
       set next_attempt_at = clock_timestamp(), attempts = 0, last_error_code = null
     where job.team_id = p_team and job.catalog_material_id = any(wanted)
       and job.state = 'queued';
  end if;
  return opened;
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
       operation.state as video_operation_state, operation.stage as video_operation_stage
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
