-- One rule for the housekeeping files, and the counts that follow it.
--
-- `.DS_Store` and its kind were hidden from the file list by a name rule in the
-- browser, and by nothing anywhere else — so the folder tree's badge counted
-- them and the list's "Елементів:" did not, and the same folder showed two
-- numbers two hundred pixels apart. The rule lives in one place now and both
-- counts read it, which also means the total the server reports is the total
-- the page shows.

create or replace function private.is_housekeeping_name(p_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select lower(btrim(coalesce(p_name, ''))) in
    ('.ds_store', 'thumbs.db', 'desktop.ini', '_organize_log.json');
$$;

create or replace function public.list_team_folder_tree(p_team uuid)
returns table (
  id uuid,
  drive_file_id text,
  parent_folder_id text,
  selection_id uuid,
  name text,
  indexed_at timestamptz,
  child_folder_count integer,
  child_file_count integer,
  thumbnail_ready_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  active_connection uuid;
  folder_count bigint;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select connection.id into active_connection
  from public.team_drive_connections as connection
  where connection.team_id = p_team
    and connection.state in ('connected', 'needs_reauth', 'root_missing')
  order by connection.connected_at desc nulls last
  limit 1;
  if active_connection is null then
    return;
  end if;

  select count(*) into folder_count
  from public.team_materials as material
  where material.team_id = p_team
    and material.connection_id = active_connection
    and material.kind = 'folder'
    and material.lifecycle = 'active';
  if folder_count > 10000 then
    raise exception 'TREE_TOO_LARGE' using errcode = 'P0001';
  end if;

  return query
  with counts as (
    select child.parent_folder_id,
           count(*) filter (where child.kind = 'folder')::integer as folders,
           count(*) filter (
             where child.kind <> 'folder' and not private.is_housekeeping_name(child.name)
           )::integer as files,
           count(*) filter (where child.provider_thumbnail_state = 'ready')::integer as ready
    from public.team_materials as child
    where child.team_id = p_team
      and child.connection_id = active_connection
      and child.lifecycle = 'active'
    group by child.parent_folder_id
  )
  select folder.id,
         folder.drive_file_id,
         folder.parent_folder_id,
         folder.selection_id,
         folder.name,
         folder.folder_indexed_at,
         coalesce(counts.folders, 0),
         coalesce(counts.files, 0),
         coalesce(counts.ready, 0)
  from public.team_materials as folder
  left join counts on counts.parent_folder_id = folder.drive_file_id
  where folder.team_id = p_team
    and folder.connection_id = active_connection
    and folder.kind = 'folder'
    and folder.lifecycle = 'active'
  order by lower(folder.name), folder.id;
end;
$fn$;

create or replace function public.list_team_folder_page(
  p_team uuid,
  p_parent_folder_id text default null,
  p_kind text[] default null,
  p_after_sort_key text default null,
  p_after_id uuid default null,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  active_connection uuid;
  root_folder text;
  parent text;
  total_count integer;
  page_rows jsonb;
  next_cursor jsonb := null;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 200
     or (p_after_sort_key is null) <> (p_after_id is null)
     or (p_kind is not null and exists (
       select 1 from unnest(p_kind) as requested(kind)
       where requested.kind not in (
         'folder', 'image', 'video', 'landing', 'archive', 'transcript', 'document', 'shortcut', 'other'
       )
     )) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  select connection.id, connection.root_folder_id
    into active_connection, root_folder
  from public.team_drive_connections as connection
  where connection.team_id = p_team
    and connection.state in ('connected', 'needs_reauth', 'root_missing')
  order by connection.connected_at desc nulls last
  limit 1;
  if active_connection is null then
    return jsonb_build_object('rows', '[]'::jsonb, 'total', 0, 'next', null);
  end if;
  parent := coalesce(p_parent_folder_id, root_folder);

  select count(*) into total_count
  from public.team_materials as material
  where material.team_id = p_team
    and material.connection_id = active_connection
    and material.lifecycle = 'active'
    and material.parent_folder_id is not distinct from parent
    and not private.is_housekeeping_name(material.name)
    and (
      p_kind is null
      or material.kind = 'folder'
      or public.team_material_kind(material.kind, material.mime_type, material.category) = any(p_kind)
    );

  with candidate as (
    select material.*,
           public.team_material_kind(material.kind, material.mime_type, material.category) as row_kind,
           (case when material.kind = 'folder' then '0' else '1' end) || '|' || lower(material.name)
             as sort_key
    from public.team_materials as material
    where material.team_id = p_team
      and material.connection_id = active_connection
      and material.lifecycle = 'active'
      and material.parent_folder_id is not distinct from parent
      and not private.is_housekeeping_name(material.name)
  ),
  page as (
    select candidate.*,
           (
             select render.render_state
             from public.team_landing_renders as render
             where render.team_id = p_team and render.material_id = candidate.id
             order by render.updated_at desc
             limit 1
           ) as render_state
    from candidate
    where (p_kind is null or candidate.row_kind = 'folder' or candidate.row_kind = any(p_kind))
      and (p_after_sort_key is null or (candidate.sort_key, candidate.id) > (p_after_sort_key, p_after_id))
    order by candidate.sort_key, candidate.id
    limit p_limit + 1
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', page.id,
      'teamId', page.team_id,
      'name', page.name,
      'category', page.category,
      'mimeType', page.mime_type,
      'fileExtension', page.file_extension,
      'sizeBytes', page.size_bytes,
      'kind', page.row_kind,
      'driveFileId', page.drive_file_id,
      'parentFolderId', page.parent_folder_id,
      'modifiedAt', page.modified_at,
      'driveVersion', page.drive_version,
      'previewState', page.provider_thumbnail_state,
      'thumbnailReady', page.provider_thumbnail_state = 'ready',
      'sortKey', page.sort_key
    )
    || case when page.provider_thumbnail_reason is not null
         then jsonb_build_object('previewReason', page.provider_thumbnail_reason) else '{}'::jsonb end
    || case when page.row_kind = 'landing'
         then jsonb_build_object('landingRender',
                jsonb_build_object('state', coalesce(page.render_state, 'none')))
         else '{}'::jsonb end
    order by page.sort_key, page.id
  ), '[]'::jsonb) into page_rows
  from page;

  if jsonb_array_length(page_rows) > p_limit then
    next_cursor := jsonb_build_object(
      'sortKey', page_rows -> (p_limit - 1) ->> 'sortKey',
      'id', page_rows -> (p_limit - 1) ->> 'id'
    );
    select coalesce(jsonb_agg(element.value order by element.ordinality), '[]'::jsonb)
      into page_rows
    from jsonb_array_elements(page_rows) with ordinality as element(value, ordinality)
    where element.ordinality <= p_limit;
  end if;

  return jsonb_build_object('rows', page_rows, 'total', total_count, 'next', next_cursor);
end;
$fn$;

revoke all on function private.is_housekeeping_name(text) from public, anon;
revoke all on function public.list_team_folder_tree(uuid) from public, anon;
revoke all on function public.list_team_folder_page(uuid, text, text[], text, uuid, integer)
  from public, anon;
grant execute on function public.list_team_folder_tree(uuid) to authenticated;
grant execute on function public.list_team_folder_page(uuid, text, text[], text, uuid, integer)
  to authenticated;
