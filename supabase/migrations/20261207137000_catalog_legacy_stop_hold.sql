begin;
-- Preserve authoritative reconciliation protection for pre-047 clients too.
create or replace function public.cancel_team_catalog_update(p_team uuid,p_catalog uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare item public.team_catalog_updater_items%rowtype;
begin
  if auth.uid() is null or not private.can(p_team,'process',auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode='42501';
  end if;
  -- All interactive Run/Stop paths take the updater before an item.
  perform 1 from public.team_catalog_updaters where team_id=p_team for update;
  select * into item from public.team_catalog_updater_items
    where team_id=p_team and catalog_material_id=p_catalog for update;
  if coalesce(item.reconciliation_required,false) or exists(
    select 1 from private.catalog_update_reconciliations pending
    join public.team_product_catalogs catalog on catalog.material_id=pending.catalog_material_id
    where pending.catalog_material_id=p_catalog and catalog.team_id=p_team
  ) then
    raise exception 'CATALOG_UPDATE_RECONCILIATION_REQUIRED' using errcode='55000';
  end if;
  if item.catalog_material_id is null or item.round_due_at is null then return false; end if;
  if item.lease_owner is not null and
     (item.lease_expires_at is null or item.lease_expires_at>clock_timestamp()) then
    raise exception 'WRONG_STATE' using errcode='55000';
  end if;
  update public.team_catalog_updater_items
    set round_due_at=null,attempts=0,lease_owner=null,lease_expires_at=null,
        next_attempt_at=clock_timestamp()
    where team_id=p_team and catalog_material_id=p_catalog;
  perform private.sync_catalog_updater(p_team);
  return true;
end $$;

-- A stale list must never stop a replacement round. Existing provider-lease protection remains.
create or replace function public.cancel_team_catalog_update_attempt(
  p_team uuid, p_catalog uuid, p_expected_round timestamptz, p_expected_attempt uuid default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare current_round timestamptz; needs_reconciliation boolean;
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_expected_round is null or not isfinite(p_expected_round) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform 1 from public.team_catalog_updaters where team_id = p_team for update;
  select item.round_due_at, item.reconciliation_required into current_round, needs_reconciliation
  from public.team_catalog_updater_items item
  where item.team_id = p_team and item.catalog_material_id = p_catalog
  for update;
  if coalesce(needs_reconciliation,false) or exists (
    select 1 from private.catalog_update_reconciliations pending
    join public.team_product_catalogs catalog on catalog.material_id=pending.catalog_material_id
    where pending.catalog_material_id=p_catalog and catalog.team_id=p_team
  ) then
    raise exception 'CATALOG_UPDATE_RECONCILIATION_REQUIRED' using errcode = '55000';
  end if;
  if current_round is null then return false; end if;
  if current_round is distinct from p_expected_round or
     (p_expected_attempt is not null and not exists (
       select 1 from public.team_catalog_update_attempts attempt
       where attempt.team_id = p_team and attempt.catalog_material_id = p_catalog
         and attempt.round_due_at = current_round and attempt.attempt_id = p_expected_attempt
     )) then
    raise exception 'STALE_RESULT' using errcode = '40001';
  end if;
  return public.cancel_team_catalog_update(p_team, p_catalog);
end;
$$;
revoke all on function public.cancel_team_catalog_update_attempt(uuid,uuid,timestamptz,uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_team_catalog_update_attempt(uuid,uuid,timestamptz,uuid)
  to authenticated;

-- A missing legacy updater item is not evidence that its provider write was absent.
-- Preserve the authoritative receipt, refuse replacement work, and expose the hold.
create or replace function public.run_team_catalog_update_now(p_team uuid, p_catalogs uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare wanted uuid[]; accepted uuid[]; opened integer;
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
  with new_attempts as (
  update public.team_catalog_updater_items as item
     set round_due_at = clock_timestamp(), next_attempt_at = clock_timestamp(), attempts = 0
   where item.team_id = p_team and item.catalog_material_id = any(wanted)
     and item.round_due_at is null and not item.reconciliation_required
     and not exists (select 1 from private.catalog_update_reconciliations pending
       where pending.catalog_material_id=item.catalog_material_id)
   returning item.catalog_material_id
  ) select coalesce(array_agg(catalog_material_id), '{}'::uuid[]) into accepted from new_attempts;
  opened := cardinality(accepted);
  perform pg_catalog.set_config('soty.catalog_manual_run', 'off', true);
  perform private.sync_catalog_updater(p_team);
  if opened > 0 then
    -- A user's new run retries preparation immediately; never steal an active app lease.
    update private.catalog_restitch_jobs as job
       set next_attempt_at = clock_timestamp(), attempts = 0, last_error_code = null
     where job.team_id = p_team and job.catalog_material_id = any(accepted)
       and job.state = 'queued';
  end if;
  if opened > 0 then
    begin
      -- pg_net dispatches after this transaction commits the accepted round.
      perform private.invoke_catalog_updater_worker();
    exception when others then
      -- The durable round and periodic dispatcher remain the recovery path.
      null;
    end;
  end if;
  return opened;
end;
$$;

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
             where job.catalog_material_id = profile.catalog_material_id and job.state = 'leased' and job.lease_expires_at > clock_timestamp()
           ) then 'preparing'
           when exists (
             select 1 from private.catalog_restitch_jobs as job
             where job.catalog_material_id = profile.catalog_material_id
               and private.catalog_restitch_visible_error(profile.catalog_material_id) is not null
           ) then 'blocked'
           else 'waiting' end,
           private.catalog_restitch_visible_error(profile.catalog_material_id), (coalesce(item.reconciliation_required, false) or exists (
             select 1 from private.catalog_update_reconciliations pending
             where pending.catalog_material_id=profile.catalog_material_id)),
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
      and not exists (select 1 from private.catalog_update_reconciliations pending
        where pending.catalog_material_id=item.catalog_material_id)
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

  -- A prepared file may be removed between preparation and the next worker tick.
  for gone in
    select distinct copy.team_id from public.team_catalog_restitch_copies as copy
    where copy.role = 'spare' and not private.catalog_has_usable_spare(copy.catalog_material_id)
  loop
    perform private.queue_restitch_jobs(gone.team_id);
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
      and not exists (select 1 from private.catalog_update_reconciliations pending
        where pending.catalog_material_id=item.catalog_material_id)
      and not item.reconciliation_required
      and item.next_attempt_at <= clock_timestamp()
      and (item.lease_expires_at is null or item.lease_expires_at <= clock_timestamp())
      and private.team_workspace_allowed(item.team_id)
      and (
        (item.update_interval is not null and coalesce(attempt.trigger_kind, 'unknown') not in ('manual', 'retry'))
        or not coalesce((attempt.profile_snapshot ->> 'restitch')::boolean, profile.restitch)
        or private.catalog_has_usable_spare(item.catalog_material_id)
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

create or replace view public.analytics_catalog_updates as
select attempt.attempt_id, attempt.catalog_material_id, attempt.team_id,
       attempt.trigger_kind, attempt.started_at, attempt.ended_at,
       attempt.result, attempt.failure_code, attempt.delivery_verified_at,
       attempt.profile_version, attempt.source_attempt_id, attempt.stage_history,
       attempt.actual_changes,
       profile.version as current_profile_version,
       item.update_interval, item.next_run_at,
       (coalesce(item.reconciliation_required,false) or exists (
         select 1 from private.catalog_update_reconciliations pending
         where pending.catalog_material_id=attempt.catalog_material_id
       )) as reconciliation_required,
       catalog.last_updated_at as last_success_at,
       catalog.last_update_error as last_error_code,
       catalog.last_update_error_at as last_error_at,
       job.state as video_preparation_state,
       case when job.state = 'queued'
         then coalesce(job.last_error_code, operation.error_code)
         else coalesce(operation.error_code, job.last_error_code)
       end as video_preparation_error,
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
