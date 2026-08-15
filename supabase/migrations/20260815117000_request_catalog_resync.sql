-- An owner can explicitly re-run the recursive catalog scan for the already
-- connected root. This is intentionally separate from changing the Drive
-- folder: it cannot detach or replace the current storage authority.

create or replace function public.request_team_catalog_resync(p_team uuid)
returns table (sync_job_id uuid, initial_sync_state text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  resolved_connection uuid;
  queued_job uuid;
begin
  if actor is null or private.team_role(p_team, actor) is distinct from 'owner' then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  -- Lock the live connection so repeat clicks cannot queue competing full
  -- scans for the same Drive root.
  select connection.id
    into resolved_connection
  from public.team_drive_connections as connection
  where connection.team_id = p_team
    and connection.state = 'connected'
  for update;

  if resolved_connection is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  select job.id
    into queued_job
  from private.catalog_sync_jobs as job
  where job.connection_id = resolved_connection
    and job.phase = 'initial_scan'
    and job.state in ('pending', 'leased', 'retry')
  order by job.created_at desc
  limit 1;

  if queued_job is null then
    queued_job := public.service_enqueue_catalog_reconciliation(resolved_connection);
  end if;

  update public.team_drive_connections as connection
  set initial_sync_state = 'scanning',
      last_synced_at = null,
      last_error_code = null
  where connection.id = resolved_connection;

  perform private.record_team_audit(
    p_team,
    actor,
    'drive.resynced',
    jsonb_build_object('connection_id', resolved_connection, 'state', 'scanning'),
    'succeeded',
    null
  );
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (p_team, null, 'sync_state');

  return query select queued_job, 'scanning'::text;
end;
$$;

revoke all on function public.request_team_catalog_resync(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.request_team_catalog_resync(uuid) to authenticated;

comment on function public.request_team_catalog_resync(uuid) is
  'Owner-requested, idempotent full recursive scan of the currently connected Drive root.';
