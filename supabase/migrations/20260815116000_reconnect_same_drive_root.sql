-- Re-selecting the same Drive root is a recovery action, not a replacement.
-- Keeping the active connection preserves its catalog identity and makes the
-- action reliably schedule a full recursive scan instead of detaching the
-- exact source the member expects to browse.

create or replace function public.service_replace_drive_connection(
  p_team uuid,
  p_actor uuid,
  p_credential uuid,
  p_root_folder_id text,
  p_root_folder_name text,
  p_drive_id text,
  p_drive_kind text,
  p_capabilities jsonb
)
returns table (connection_id uuid, sync_job_id uuid, state text, initial_sync_state text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_connection uuid;
  old_root_folder_id text;
  old_drive_id text;
  old_drive_kind text;
  resync_job uuid;
begin
  -- Keep the same validation as a first-time connection before changing the
  -- currently active source. A replacement may only use the caller's own
  -- credential and a validated Drive root shape.
  if private.team_role(p_team, p_actor) <> 'owner'
     or p_drive_kind is null
     or p_drive_kind not in ('my_drive', 'shared_drive')
     or (p_drive_kind = 'my_drive' and p_drive_id is not null)
     or (p_drive_kind = 'shared_drive' and p_drive_id is null)
     or coalesce(char_length(p_root_folder_id), 0) not between 1 and 1024
     or coalesce(char_length(p_root_folder_name), 0) not between 1 and 255
     or jsonb_typeof(coalesce(p_capabilities, '{}'::jsonb)) <> 'object'
     or not exists (
       select 1
       from private.google_drive_credentials as credential
       where credential.id = p_credential and credential.connected_by = p_actor
     ) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  select connection.id,
         connection.root_folder_id,
         connection.drive_id,
         connection.drive_kind
    into old_connection,
         old_root_folder_id,
         old_drive_id,
         old_drive_kind
  from public.team_drive_connections as connection
  where connection.team_id = p_team and connection.state <> 'detached'
  for update;

  if old_connection is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  if old_root_folder_id = p_root_folder_id
     and old_drive_kind = p_drive_kind
     and old_drive_id is not distinct from p_drive_id then
    update public.team_drive_connections
    set credential_id = p_credential,
        root_resource_key = nullif(coalesce(p_capabilities, '{}'::jsonb) ->> 'resourceKey', ''),
        root_folder_name = p_root_folder_name,
        drive_id = p_drive_id,
        drive_kind = p_drive_kind,
        capability_snapshot = coalesce(p_capabilities, '{}'::jsonb) - 'resourceKey' - 'startPageToken',
        capabilities_checked_at = clock_timestamp(),
        state = 'connected',
        initial_sync_state = 'scanning',
        change_page_token = coalesce(
          nullif(coalesce(p_capabilities, '{}'::jsonb) ->> 'startPageToken', ''),
          change_page_token
        ),
        last_synced_at = null,
        last_error_code = null,
        detached_at = null
    where id = old_connection;

    resync_job := public.service_enqueue_catalog_reconciliation(old_connection);
    delete from private.drive_credential_references
    where team_id = p_team and actor_id = p_actor;
    perform private.record_team_audit(
      p_team,
      p_actor,
      'drive.resynced',
      jsonb_build_object('connection_id', old_connection, 'state', 'connected'),
      'succeeded',
      null
    );

    return query select old_connection, resync_job, 'connected'::text, 'scanning'::text;
    return;
  end if;

  update public.team_drive_connections
  set state = 'detached', detached_at = clock_timestamp()
  where id = old_connection;

  return query
  select confirmed.connection_id,
         confirmed.sync_job_id,
         confirmed.state,
         confirmed.initial_sync_state
  from public.service_confirm_drive_connection(
    p_team, p_actor, p_credential, p_root_folder_id, p_root_folder_name,
    p_drive_id, p_drive_kind, p_capabilities
  ) as confirmed;
end;
$$;

revoke all on function public.service_replace_drive_connection(
  uuid, uuid, uuid, text, text, text, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.service_replace_drive_connection(
  uuid, uuid, uuid, text, text, text, text, jsonb
) to service_role;

-- A detached history is actionable only when it belongs to another root than
-- the one that is currently connected. This intentionally keeps the signal
-- content-free while avoiding a permanent warning after reconnecting the same
-- Drive folder.
create or replace function public.get_team_landing_source_status(p_team uuid)
returns table (has_detached_landing_candidates boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  return query
  with active_connection as (
    select connection.root_folder_id,
           connection.drive_id,
           connection.drive_kind
    from public.team_drive_connections as connection
    where connection.team_id = p_team
      and connection.state = 'connected'
    limit 1
  )
  select exists (
    select 1
    from public.team_materials as material
    join public.team_drive_connections as detached_connection
      on detached_connection.id = material.connection_id
     and detached_connection.team_id = material.team_id
     and detached_connection.state = 'detached'
    cross join active_connection
    where material.team_id = p_team
      and material.kind = 'file'
      and material.lifecycle = 'active'
      and material.category in ('archive', 'landing')
      and (
        detached_connection.root_folder_id is distinct from active_connection.root_folder_id
        or detached_connection.drive_id is distinct from active_connection.drive_id
        or detached_connection.drive_kind is distinct from active_connection.drive_kind
      )
  );
end;
$$;

revoke all on function public.get_team_landing_source_status(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.get_team_landing_source_status(uuid) to authenticated;

comment on function public.get_team_landing_source_status(uuid) is
  'Caller-checked, content-free recovery signal for landing candidates in a different detached Drive root.';
