-- A manual subtree scan is a one-shot job, not another permanent changes poller.
alter table private.catalog_sync_jobs add column requested_folder_id text;

-- User-requested work must not wait behind the connection's perpetual pollers.
create or replace function private.claim_catalog_sync_jobs(
  p_worker text, p_limit integer default 5, p_lease_seconds integer default 60
)
returns setof private.catalog_sync_jobs
language plpgsql security definer set search_path = ''
as $$
declare slots integer;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(71101400) then return; end if;
  update private.catalog_sync_jobs as job
  set state = 'failed', lease_owner = null, lease_expires_at = null,
      last_error_code = 'RETRY_EXHAUSTED', completed_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  from public.team_drive_connections as connection
  where connection.id = job.connection_id and connection.state <> 'detached'
    and job.attempts >= 1000 and (job.state in ('pending', 'retry')
      or (job.state = 'leased' and job.lease_expires_at <= pg_catalog.clock_timestamp()));
  select greatest(0, 3 - count(*)::integer) into slots
  from private.catalog_sync_jobs
  where state = 'leased' and lease_expires_at > pg_catalog.clock_timestamp();
  if slots = 0 then return; end if;
  return query
  with candidates as (
    select job.id
    from private.catalog_sync_jobs as job
    join public.team_drive_connections as connection on connection.id = job.connection_id
    where job.attempts < 1000
      and (job.state in ('pending', 'retry')
        or (job.state = 'leased' and job.lease_expires_at <= pg_catalog.clock_timestamp()))
      and job.next_attempt_at <= pg_catalog.clock_timestamp() and connection.state <> 'detached'
    order by (job.requested_folder_id is null), job.next_attempt_at, job.created_at
    for update of job skip locked
    limit least(greatest(p_limit, 1), slots)
  )
  update private.catalog_sync_jobs as job
  set state = 'leased', lease_owner = p_worker,
      lease_expires_at = pg_catalog.clock_timestamp()
        + pg_catalog.make_interval(secs => least(greatest(p_lease_seconds, 10), 300)),
      next_attempt_at = pg_catalog.clock_timestamp()
        + pg_catalog.make_interval(secs => least(greatest(p_lease_seconds, 10), 300)),
      attempts = job.attempts + 1, updated_at = pg_catalog.clock_timestamp()
  from candidates where job.id = candidates.id returning job.*;
end;
$$;

create or replace function public.request_team_folder_resync(p_team uuid, p_folder text)
returns table (sync_job_id uuid, initial_sync_state text)
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  resolved_connection uuid;
  token text;
  created_job uuid;
begin
  if actor is null or coalesce(private.team_role(p_team, actor), '') not in ('owner', 'admin') then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select c.id, c.change_page_token into resolved_connection, token
  from public.team_drive_connections c
  join public.team_materials m on m.team_id = c.team_id and m.drive_file_id = p_folder
  where c.team_id = p_team and c.state = 'connected' and m.kind = 'folder' and m.lifecycle = 'active'
  for update of c;
  if resolved_connection is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select j.id into created_job from private.catalog_sync_jobs j
  where j.connection_id = resolved_connection and j.requested_folder_id = p_folder
    and j.state in ('pending', 'leased', 'retry')
  order by j.created_at limit 1;
  if created_job is null then
    insert into private.catalog_sync_jobs (connection_id, phase, cursor, folder_queue, requested_folder_id)
    values (resolved_connection, 'initial_scan',
      jsonb_build_object('pageToken', null, 'changePageToken', token, 'discoveredFolders', '[]'::jsonb),
      jsonb_build_array(p_folder), p_folder)
    returning id into created_job;
  end if;
  return query select created_job, 'scanning'::text;
end;
$$;

-- Keep the private queue private: expose only the requested job's outcome to its team.
create function public.get_team_folder_resync_status(p_team uuid, p_job uuid)
returns table (status text)
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null or not coalesce(private.can(p_team, 'view', auth.uid()), false) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
  select case when c.state = 'detached' then 'failed'
    when j.state = 'succeeded' then 'succeeded'
    when j.state = 'failed' then 'failed' else 'running' end
  from private.catalog_sync_jobs j
  join public.team_drive_connections c on c.id = j.connection_id
  where j.id = p_job and c.team_id = p_team and j.requested_folder_id is not null;
end;
$$;
revoke all on function public.get_team_folder_resync_status(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_team_folder_resync_status(uuid, uuid) to authenticated;

create or replace function public.service_complete_catalog_sync_job(
  p_job uuid, p_worker text, p_change_token text, p_next_phase text default 'incremental'
)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  resolved_team uuid;
  resolved_connection uuid;
  scoped_folder text;
begin
  if p_next_phase not in ('incremental', 'reconcile') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update private.catalog_sync_jobs as job
  set phase = p_next_phase,
      cursor = pg_catalog.jsonb_build_object('pageToken', p_change_token,
        'changePageToken', p_change_token, 'discoveredFolders', '[]'::jsonb),
      folder_queue = '[]'::jsonb,
      state = case when requested_folder_id is null then 'pending' else 'succeeded' end,
      completed_at = case when requested_folder_id is null then null else clock_timestamp() end,
      lease_owner = null, lease_expires_at = null,
      next_attempt_at = clock_timestamp() + interval '1 minute',
      last_error_code = null, updated_at = clock_timestamp()
  where job.id = p_job and job.lease_owner = p_worker and job.lease_expires_at > clock_timestamp()
  returning job.connection_id, job.requested_folder_id into resolved_connection, scoped_folder;
  if resolved_connection is null then return false; end if;

  if scoped_folder is null then
    update public.team_drive_connections as connection
    set change_page_token = p_change_token, initial_sync_state = 'ready',
        last_synced_at = clock_timestamp(), last_error_code = null, updated_at = clock_timestamp()
    where connection.id = resolved_connection returning connection.team_id into resolved_team;
  else
    -- A local rescan must not replace the ongoing connection's change cursor or health.
    select team_id into resolved_team from public.team_drive_connections where id = resolved_connection;
  end if;
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (resolved_team, null, 'sync_state');
  return true;
end;
$$;

notify pgrst, 'reload schema';
