-- 011 (findings I4): a re-consent that widens the grant — drive.file to the
-- restricted scope, or a grant that had expired — changes what Drive shows,
-- and the change feed never replays files that were there all along. The
-- OAuth callback asks for a full walk through this service-side twin of
-- request_team_catalog_resync: same queue, same "scanning" state, same
-- history line, an explicit actor instead of auth.uid(), and silence rather
-- than an error when the team has no connected root yet.

create or replace function public.service_request_catalog_rescan(p_team uuid, p_actor uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_connection uuid;
  queued_job uuid;
begin
  if p_actor is null or private.team_role(p_team, p_actor) is distinct from 'owner' then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  select connection.id
    into resolved_connection
  from public.team_drive_connections as connection
  where connection.team_id = p_team
    and connection.state = 'connected'
  for update;

  if resolved_connection is null then
    return null;
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
    p_actor,
    'drive.resynced',
    jsonb_build_object('connection_id', resolved_connection, 'state', 'scanning'),
    'succeeded',
    null
  );
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (p_team, null, 'sync_state');

  return queued_job;
end;
$$;

revoke all on function public.service_request_catalog_rescan(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.service_request_catalog_rescan(uuid, uuid) to service_role;
