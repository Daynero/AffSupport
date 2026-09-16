-- Feature 024 — the space's folder opens in Drive from its settings.
--
-- The storage card named the folder ("Aff") and nothing more; the way to see it in Drive was to
-- find it there by hand. The status now carries the folder's Drive id, which every member who may
-- view the space already sees on each file. The return type grows a column, so the function is
-- dropped and made again with its grants. ROLLBACK.md re-applies 20260916100000's definition.

drop function if exists public.get_drive_connection_status(uuid);

create function public.get_drive_connection_status(p_team uuid)
returns table (
  connection_id uuid,
  state text,
  root_folder_name text,
  drive_kind text,
  initial_sync_state text,
  last_synced_at timestamptz,
  last_error_code text,
  connected_account_email text,
  capabilities_checked_at timestamptz,
  root_folder_id text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller_role text := private.team_role(p_team, auth.uid());
begin
  if caller_role is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  return query
  select connection.id,
         coalesce(connection.state, 'none'),
         connection.root_folder_name,
         connection.drive_kind,
         coalesce(connection.initial_sync_state, 'not_started'),
         connection.last_synced_at,
         connection.last_error_code,
         case when caller_role in ('owner', 'admin') then credential.google_account_email end,
         case when caller_role in ('owner', 'admin') then connection.capabilities_checked_at end,
         connection.root_folder_id
  from (select 1) as singleton
  left join lateral (
    select drive.*
    from public.team_drive_connections as drive
    where drive.team_id = p_team and drive.state <> 'detached'
    order by drive.connected_at desc nulls last
    limit 1
  ) as connection on true
  left join private.google_drive_credentials as credential
    on credential.id = connection.credential_id;
end;
$$;

revoke all on function public.get_drive_connection_status(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_drive_connection_status(uuid) to authenticated;
