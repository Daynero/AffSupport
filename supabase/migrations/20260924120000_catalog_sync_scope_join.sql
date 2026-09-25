-- Serialize manual scope decisions per connection. A request inside an active
-- scan joins it; a broader request widens an unstarted queued scan or becomes
-- one follow-up when the narrower scan has already begun.
create or replace function public.request_team_folder_resync(p_team uuid, p_folder text)
returns table(sync_job_id uuid, initial_sync_state text)
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  connected uuid;
  token text;
  joined uuid;
  widen uuid;
begin
  if actor is null or coalesce(private.team_role(p_team, actor), '') not in ('owner', 'admin') then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if nullif(p_folder, '') is null then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  select c.id, c.change_page_token into connected, token
  from public.team_drive_connections c
  join public.team_materials m on m.connection_id = c.id and m.team_id = c.team_id
    and m.drive_file_id = p_folder and m.kind = 'folder' and m.lifecycle = 'active'
  where c.team_id = p_team and c.state = 'connected' for update of c;
  if connected is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  -- Use the same lock order as worker claims before touching a job row.
  perform 1 from private.catalog_sync_authority where connection_id = connected for update;

  with recursive ancestors(id, depth, trail) as (
    select p_folder, 0, array[p_folder]
    union all
    select m.parent_folder_id, a.depth + 1, a.trail || m.parent_folder_id
    from ancestors a join public.team_materials m
      on m.connection_id = connected and m.drive_file_id = a.id
    where m.parent_folder_id is not null and a.depth < 100
      and m.parent_folder_id <> all(a.trail)
  )
  select j.id into joined from ancestors a join private.catalog_sync_jobs j
    on j.connection_id = connected and j.requested_folder_id = a.id
    and j.job_kind = 'user_subtree' and j.state in ('pending', 'leased', 'retry')
  order by a.depth, j.created_at, j.id limit 1;
  if joined is not null then return query select joined, 'scanning'::text; return; end if;

  -- Find one active descendant. A queued, untouched job can be widened in
  -- place; its existing waiters still get a superset of what they requested.
  with recursive job_ancestors(job_id, id, depth, trail) as (
    select j.id, j.requested_folder_id, 0, array[j.requested_folder_id]
    from private.catalog_sync_jobs j where j.connection_id = connected
      and j.job_kind = 'user_subtree' and j.state in ('pending', 'leased', 'retry')
    union all
    select a.job_id, m.parent_folder_id, a.depth + 1, a.trail || m.parent_folder_id
    from job_ancestors a join public.team_materials m
      on m.connection_id = connected and m.drive_file_id = a.id
    where m.parent_folder_id is not null and a.depth < 100
      and m.parent_folder_id <> all(a.trail)
  )
  select j.id into widen from job_ancestors a join private.catalog_sync_jobs j on j.id = a.job_id
    where a.id = p_folder and a.depth > 0 and j.state in ('pending', 'retry')
      and not j.scan_initialized
    order by j.created_at, j.id limit 1 for update of j;
  if widen is not null then
    update private.catalog_sync_jobs set requested_folder_id = p_folder,
      folder_queue = jsonb_build_array(p_folder), cursor = jsonb_build_object(
        'pageToken', null, 'changePageToken', token, 'discoveredFolders', '[]'::jsonb),
      updated_at = clock_timestamp() where id = widen;
    return query select widen, 'scanning'::text; return;
  end if;

  insert into private.catalog_sync_jobs
    (connection_id, job_kind, phase, cursor, folder_queue, requested_folder_id)
  values (connected, 'user_subtree', 'initial_scan', jsonb_build_object(
    'pageToken', null, 'changePageToken', token, 'discoveredFolders', '[]'::jsonb),
    jsonb_build_array(p_folder), p_folder) returning id into joined;
  return query select joined, 'scanning'::text;
end;
$$;
revoke all on function public.request_team_folder_resync(uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.request_team_folder_resync(uuid,text) to authenticated;
notify pgrst, 'reload schema';
