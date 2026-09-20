-- Feature 024 US25 — the explorer can tell a companion from a file of its own.
--
-- A transcript and a catalog belong to a video; the folder listing did not say so, so every
-- surface showed them as three unrelated files. The row carries what it belongs to, and the
-- explorer folds them under their video rather than spreading them through the folder.
-- Forward-only; ROLLBACK.md re-applies the listing from 20260906160000.

create or replace function public.list_team_folder_page(p_team uuid, p_parent_folder_id text DEFAULT NULL::text, p_kind text[] DEFAULT NULL::text[], p_after_sort_key text DEFAULT NULL::text, p_after_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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
      'tagColor', page.tag_color,
      -- What this file belongs to (024, US25): a transcript or a catalog folds under its video.
      'companionOf', page.companion_of,
      'companionKind', page.companion_kind
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
$$;
