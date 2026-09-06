-- The folder walk, as one question.
--
-- "Process this folder and everything in it" read the drive one folder at a
-- time from the browser, sequentially, up to five hundred round trips — half a
-- minute of "Дивимось усередину — папок: N…" on a real library, and a ceiling
-- that had to be explained to the person when it was reached. The tree is in
-- the catalogue already; walking it there is one query.
--
-- Returns the videos and landings under a folder, the number of folders it
-- passed through, and whether the ceiling stopped it — the same three things
-- the client walk reported, so the window above it does not change.

create or replace function public.list_team_folder_subtree(
  p_team uuid,
  p_root text,
  p_max_folders integer default 500
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  active_connection uuid;
  payload jsonb;
begin
  if actor is null or not private.can(p_team, 'view', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_root is null or char_length(p_root) not between 1 and 512
     or p_max_folders not between 1 and 5000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  select connection.id into active_connection
  from public.team_drive_connections as connection
  where connection.team_id = p_team
    and connection.state in ('connected', 'needs_reauth', 'root_missing')
  order by connection.connected_at desc nulls last
  limit 1;
  if active_connection is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  -- The folder itself, then everything under it, in one chain: a `stable`
  -- function may not build a temporary table, and this read must stay stable so
  -- it can be planned as the single query it is. One row past the ceiling is
  -- fetched deliberately — that extra row is how the answer knows it was cut.
  with recursive walk as (
    select folder.drive_file_id, 1 as depth
    from public.team_materials as folder
    where folder.team_id = p_team
      and folder.connection_id = active_connection
      and folder.kind = 'folder'
      and folder.lifecycle = 'active'
      and folder.drive_file_id = p_root
    union
    select child.drive_file_id, walk.depth + 1
    from walk
    join public.team_materials as child
      on child.parent_folder_id = walk.drive_file_id
     and child.team_id = p_team
     and child.connection_id = active_connection
     and child.kind = 'folder'
     and child.lifecycle = 'active'
    where walk.depth < 64
  ), capped as (
    select drive_file_id, row_number() over (order by depth, drive_file_id) as position
    from walk
    limit p_max_folders + 1
  ), kept as (
    select drive_file_id from capped where position <= p_max_folders
  ), files as (
    select material.id, material.team_id, material.drive_file_id,
           material.parent_folder_id, material.name, material.category
    from public.team_materials as material
    join kept on kept.drive_file_id = material.parent_folder_id
    where material.team_id = p_team
      and material.connection_id = active_connection
      and material.lifecycle = 'active'
      and material.kind <> 'folder'
      and material.category in ('video', 'landing')
      and not private.is_housekeeping_name(material.name)
  )
  select jsonb_build_object(
    'foldersVisited', least((select count(*) from capped), p_max_folders)::integer,
    'truncated', (select count(*) from capped) > p_max_folders,
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', files.id,
          'teamId', files.team_id,
          'providerId', files.drive_file_id,
          'parentFolderId', files.parent_folder_id,
          'name', files.name,
          'kind', 'file',
          'category', files.category
        )
        order by lower(files.name), files.id
      )
      from files
    ), '[]'::jsonb)
  ) into payload;

  return payload;
end;
$$;

revoke all on function public.list_team_folder_subtree(uuid, text, integer) from public, anon;
grant execute on function public.list_team_folder_subtree(uuid, text, integer) to authenticated;
