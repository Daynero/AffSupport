-- The existing storage chip state remains compatible; coverage and freshness
-- are separate facts. A claim, retry or connection timestamp is not a
-- confirmed provider checkpoint.
create function public.get_team_storage_health_v2(p_team uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  base jsonb;
  connection record;
  canonical private.catalog_sync_jobs;
  latest_finite private.catalog_sync_jobs;
  coverage text := 'unknown';
  health text := 'working';
  next_action text := 'wait';
  last_confirmed timestamptz;
begin
  -- The established RPC performs the membership check and keeps all preview
  -- and provider-waiting semantics. Never broaden its authorization surface.
  base := public.get_team_storage_health(p_team);
  select drive.id, drive.state, drive.initial_sync_state, drive.last_error_code,
         drive.last_reconciled_at, drive.last_synced_at
    into connection
    from public.team_drive_connections drive
   where drive.team_id = p_team and drive.state <> 'detached'
   order by drive.connected_at desc nulls last limit 1;

  if connection.id is null then
    return base || jsonb_build_object('coverage', coverage, 'syncHealth', 'failed',
      'lastConfirmedAt', null, 'nextAction', 'connect');
  end if;

  last_confirmed := coalesce(connection.last_reconciled_at, connection.last_synced_at);
  select job.*
    into canonical
    from private.catalog_sync_jobs job
   where job.connection_id = connection.id and job.job_kind = 'incremental'
   order by job.created_at desc limit 1;
  select job.*
    into latest_finite
    from private.catalog_sync_jobs job
   where job.connection_id = connection.id and job.job_kind <> 'incremental'
   order by job.created_at desc, job.id desc limit 1;

  if connection.state = 'needs_reauth' or canonical.last_error_code = 'NEEDS_REAUTH' then
    coverage := 'permission_limited';
    health := 'needs_reauth';
    next_action := 'reconnect';
  elsif connection.state = 'root_missing' then
    coverage := 'permission_limited';
    health := 'failed';
    next_action := 'restore_root';
  elsif connection.last_error_code in ('PERMISSION_DENIED', 'ROOT_ESCAPE')
     or canonical.last_error_code in ('PERMISSION_DENIED', 'ROOT_ESCAPE')
     or exists (
       select 1 from private.catalog_scan_generations generation
       join private.catalog_sync_jobs job on job.id = generation.job_id
       where job.connection_id = connection.id and job.id = latest_finite.id
         and generation.state <> 'abandoned' and generation.coverage = 'permission_limited'
     ) then
    coverage := 'permission_limited';
    health := 'failed';
    next_action := 'grant_access';
  elsif canonical.state = 'failed' or connection.initial_sync_state = 'failed' then
    coverage := 'partial';
    health := 'failed';
    next_action := 'retry';
  elsif canonical.state = 'retry'
     and canonical.last_error_code in ('RATE_LIMITED', 'DRIVE_UNAVAILABLE') then
    coverage := case when connection.initial_sync_state = 'ready' then 'complete' else 'partial' end;
    health := 'delayed';
    next_action := 'wait';
  elsif canonical.id is not null
     and canonical.last_progress_at < clock_timestamp() - interval '15 minutes'
     and (last_confirmed is null or last_confirmed < clock_timestamp() - interval '15 minutes') then
    coverage := case when connection.initial_sync_state = 'ready' then 'complete' else 'partial' end;
    health := 'delayed';
    next_action := 'retry';
  elsif latest_finite.state = 'failed' then
    coverage := 'partial';
    health := 'failed';
    next_action := 'retry';
  elsif exists (
    select 1 from private.catalog_sync_jobs job
    where job.connection_id = connection.id and job.job_kind = 'discovered_subtree'
      and job.state in ('pending', 'leased', 'retry')
  ) then
    coverage := 'partial';
    health := 'working';
    next_action := 'wait';
  elsif exists (
    select 1 from private.catalog_scan_generations generation
    where generation.job_id = latest_finite.id and generation.state <> 'abandoned'
      and generation.coverage = 'partial'
  ) then
    coverage := 'partial';
    next_action := 'retry';
  elsif connection.initial_sync_state = 'ready' then
    coverage := 'complete';
    health := 'current';
    next_action := 'none';
  end if;

  return base || jsonb_build_object('coverage', coverage, 'syncHealth', health,
    'lastConfirmedAt', last_confirmed, 'nextAction', next_action);
end;
$$;

revoke all on function public.get_team_storage_health_v2(uuid) from public, anon, authenticated;
grant execute on function public.get_team_storage_health_v2(uuid) to authenticated;
notify pgrst, 'reload schema';
