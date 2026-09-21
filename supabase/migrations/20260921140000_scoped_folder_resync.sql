create or replace function public.request_team_folder_resync(p_team uuid, p_folder text)
returns table (sync_job_id uuid, initial_sync_state text)
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  connection_id uuid;
  token text;
  created_job uuid;
begin
  if actor is null or private.team_role(p_team, actor) not in ('owner', 'admin') then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select c.id, c.change_page_token into connection_id, token
  from public.team_drive_connections c
  join public.team_materials m on m.team_id = c.team_id and m.drive_file_id = p_folder
  where c.team_id = p_team and c.state = 'connected' and m.kind = 'folder' and m.lifecycle = 'active';
  if connection_id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  insert into private.catalog_sync_jobs (connection_id, phase, cursor, folder_queue)
  values (connection_id, 'initial_scan',
    jsonb_build_object('pageToken', null, 'changePageToken', token, 'discoveredFolders', '[]'::jsonb),
    jsonb_build_array(p_folder))
  returning id into created_job;
  return query select created_job, 'scanning'::text;
end;
$$;
revoke all on function public.request_team_folder_resync(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.request_team_folder_resync(uuid, text) to authenticated;
