-- Feature 011, part N: a file can be tagged.
--
-- Finder's tags, and deliberately Finder's: seven colours, one per file, shown
-- as a dot beside the size. The vocabulary is the team's own — the product does
-- not say what red means — and the colours are the ones every person on a Mac
-- already reads without a legend.
--
-- Who may set one is the sharp edge here. A tag is a shared judgement about a
-- file, and a space full of people re-colouring each other's files is worse
-- than no tags at all, so this is the owner's alone: `teams.owner_id`, not a
-- permission flag that could be handed out. Everyone else reads them — the dot
-- is on their screen too, and it is not a button.

-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------
alter table public.team_materials add column tag_color text;

alter table public.team_materials
  add constraint team_materials_tag_color_value
  check (
    tag_color is null
    or tag_color in ('red', 'orange', 'yellow', 'green', 'blue', 'purple', 'grey')
  );

-- Sorting and filtering by tag reads only the tagged rows, which are the few.
create index team_materials_tag_idx
  on public.team_materials (team_id, tag_color)
  where tag_color is not null;

comment on column public.team_materials.tag_color is
  'Feature 011: the file''s Finder-style tag — red, orange, yellow, green, blue, purple, grey, or null.';

-- ---------------------------------------------------------------------------
-- 2. The listing carries it
-- ---------------------------------------------------------------------------
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
      'sortKey', page.sort_key,
      'tagColor', page.tag_color
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

-- ---------------------------------------------------------------------------
-- 3. Setting one: the space's owner, and nobody else
-- ---------------------------------------------------------------------------
create function public.set_team_material_tag(p_team uuid, p_material uuid, p_color text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  clean_color text := nullif(btrim(coalesce(p_color, '')), '');
begin
  -- Not `private.can(..., 'edit')`: this is the owner's alone, so an editor
  -- with every permission flag set still cannot re-colour the space's files.
  if actor is null or not exists (
    select 1 from public.teams as team
    where team.id = p_team and team.owner_id = actor
  ) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if clean_color is not null
     and clean_color not in ('red', 'orange', 'yellow', 'green', 'blue', 'purple', 'grey') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  update public.team_materials as material
  set tag_color = clean_color
  where material.id = p_material and material.team_id = p_team;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  return jsonb_build_object('id', p_material, 'tagColor', clean_color);
end;
$$;

revoke all on function public.set_team_material_tag(uuid, uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.set_team_material_tag(uuid, uuid, text) to authenticated;
