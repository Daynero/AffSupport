-- Manual and discovered requests use one scope-join authority. The provider
-- parent is supplied for newly moved-in folders that have no catalog row yet.
create function private.join_catalog_subtree(
  p_connection uuid, p_folder text, p_parent text, p_kind text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare token text; joined uuid; widen uuid;
begin
  if p_kind not in ('user_subtree','discovered_subtree')
    or nullif(p_folder, '') is null or length(p_folder) > 1024
    or length(coalesce(p_parent, '')) > 1024 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select c.change_page_token into token from public.team_drive_connections c
    where c.id = p_connection and c.state = 'connected' for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  perform 1 from private.catalog_sync_authority
    where connection_id = p_connection for update;

  with recursive ancestors(id, parent, depth, trail) as (
    select p_folder, p_parent, 0, array[p_folder]
    union all
    select a.parent, m.parent_folder_id, a.depth + 1, a.trail || a.parent
      from ancestors a left join public.team_materials m
        on m.connection_id = p_connection and m.drive_file_id = a.parent
      where a.parent is not null and a.depth < 100 and a.parent <> all(a.trail)
  )
  select j.id into joined from ancestors a join private.catalog_sync_jobs j
    on j.connection_id = p_connection and j.requested_folder_id = a.id
    and j.job_kind in ('user_subtree','discovered_subtree')
    and j.state in ('pending','leased','retry')
  where not exists (
    select 1 from private.catalog_scan_frontier f
    where f.job_id = j.id and f.folder_id in (p_folder, p_parent)
      and f.state <> 'queued'
  )
  order by a.depth, j.created_at, j.id limit 1;
  if joined is not null then return joined; end if;

  with recursive job_ancestors(job_id, id, depth, trail) as (
    select j.id, j.requested_folder_id, 0, array[j.requested_folder_id]
      from private.catalog_sync_jobs j where j.connection_id = p_connection
        and j.job_kind in ('user_subtree','discovered_subtree')
        and j.state in ('pending','leased','retry')
    union all
    select a.job_id, m.parent_folder_id, a.depth + 1, a.trail || m.parent_folder_id
      from job_ancestors a join public.team_materials m
        on m.connection_id = p_connection and m.drive_file_id = a.id
      where m.parent_folder_id is not null and a.depth < 100
        and m.parent_folder_id <> all(a.trail)
  )
  select j.id into widen from job_ancestors a join private.catalog_sync_jobs j on j.id = a.job_id
    where a.id = p_folder and a.depth > 0 and j.state in ('pending','retry')
      and not j.scan_initialized
    order by j.created_at, j.id limit 1 for update of j;
  if widen is not null then
    update private.catalog_sync_jobs set requested_folder_id = p_folder,
      folder_queue = jsonb_build_array(p_folder), cursor = jsonb_build_object(
        'pageToken', null, 'changePageToken', token, 'discoveredFolders', '[]'::jsonb),
      updated_at = clock_timestamp() where id = widen;
    return widen;
  end if;

  insert into private.catalog_sync_jobs
    (connection_id, job_kind, phase, cursor, folder_queue, requested_folder_id)
  values (p_connection, p_kind, 'initial_scan', jsonb_build_object(
    'pageToken', null, 'changePageToken', token, 'discoveredFolders', '[]'::jsonb),
    jsonb_build_array(p_folder), p_folder) returning id into joined;
  return joined;
end;
$$;
revoke all on function private.join_catalog_subtree(uuid,text,text,text)
  from public, anon, authenticated, service_role;

create or replace function public.request_team_folder_resync(p_team uuid, p_folder text)
returns table(sync_job_id uuid, initial_sync_state text)
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); connected uuid; parent text; joined uuid;
begin
  if actor is null or coalesce(private.team_role(p_team, actor), '') not in ('owner', 'admin') then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if nullif(p_folder, '') is null then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  select c.id, m.parent_folder_id into connected, parent
    from public.team_drive_connections c join public.team_materials m
      on m.connection_id = c.id and m.team_id = c.team_id
      and m.drive_file_id = p_folder and m.kind = 'folder' and m.lifecycle = 'active'
    where c.team_id = p_team and c.state = 'connected';
  if connected is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  joined := private.join_catalog_subtree(connected, p_folder, parent, 'user_subtree');
  return query select joined, 'scanning'::text;
end;
$$;
revoke all on function public.request_team_folder_resync(uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.request_team_folder_resync(uuid,text) to authenticated;

create function public.service_enqueue_discovered_catalog_subtree(
  p_job uuid, p_worker text, p_epoch bigint, p_folder text, p_parent text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare connected uuid; existing public.team_materials;
begin
  if nullif(p_folder, '') is null or length(p_folder) > 1024
    or length(coalesce(p_parent, '')) > 1024 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select j.connection_id into connected from private.catalog_sync_jobs j where j.id = p_job;
  if connected is null then return false; end if;
  perform 1 from public.team_drive_connections c where c.id = connected for update;
  if not private.lock_catalog_sync_lease(p_job, p_worker, p_epoch) then return false; end if;
  select m.* into existing from public.team_materials m
    where m.connection_id = connected and m.drive_file_id = p_folder for update;
  if found and existing.kind = 'folder' and existing.lifecycle = 'active'
    and existing.parent_folder_id is not distinct from p_parent
    and existing.folder_indexed_at is not null then return true; end if;
  perform private.join_catalog_subtree(connected, p_folder, p_parent, 'discovered_subtree');
  return true;
end;
$$;
revoke all on function public.service_enqueue_discovered_catalog_subtree(uuid,text,bigint,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.service_enqueue_discovered_catalog_subtree(uuid,text,bigint,text,text)
  to service_role;
notify pgrst, 'reload schema';
