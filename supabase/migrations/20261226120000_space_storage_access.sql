-- 057 M1 (T008): who sees an R2 space, and the lists that read one (specs/057-r2-workspaces).
--
-- Additive: function bodies are replaced, nothing is dropped.
--
-- * list_my_teams() keeps its signature and no longer returns an R2 space, so the production web
--   and any old client never open one (research R6). list_my_teams_v2() returns every space with
--   storage_backend, storage_pilot and content_revision.
-- * private.team_workspace_allowed(): a pilot space (teams.storage_pilot) is open to pilot users
--   (storage_r2_pilots) without a 034 tariff, and closed to everyone else — an invited member
--   who is not a pilot does not open it.
-- * teams.access_epoch rises with every change of who may read an R2 space: a role, an override
--   or a status change of a membership, a deleted membership, an owner or status change of the
--   space, a removed pilot. It revokes every read grant already issued (research R4).
-- * The folder, tree, subtree, material and trash lists answer an R2 space by folder id and
--   without a Drive connection; the Drive branch of each is the previous body unchanged.
--
-- Inventory (grep of client-callable public functions over the full chain that join
-- team_drive_connections or read drive_file_id, 2026-11-28; 36 functions):
--   R2 branch here: list_my_teams, list_team_folder_page, list_team_folder_tree,
--     list_team_folder_subtree, list_team_materials, list_team_trashed_materials_v2.
--   Drive-only by design, refused for an R2 space where a client could reach them (T020 and the
--     space-storage routes replace them): add_team_drive_selection, list_team_drive_selections,
--     get_drive_connection_status, admin_approve_drive_account, find_team_folder_sync_request,
--     get_team_folder_sync_status, get_team_folder_resync_status, request_team_folder_resync,
--     request_team_catalog_resync, wake_team_catalog_sync, get_team_storage_health,
--     get_team_storage_health_v2, get_team_landing_source_status, list_landing_renders,
--     get_material_preview, list_team_trashed_materials (v1), start_team_bulk_trash.
--   Read an R2 space as an empty Drive answer until their own task: search_materials,
--     get_team_vocab_and_facets, list_library_materials, get_library_processing_context,
--     get_material_product_catalog, list_material_product_catalogs,
--     list_team_product_catalog_image_sources, get_material_transcript_companion,
--     team_catalog_creation_preflight, get_space_removal_preview.
--   Account and ownership paths, unaffected by the backend: accept_invitation,
--     transfer_ownership, admin_reassign_space_tariff.

create function private.space_is_r2(p_team uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.teams t where t.id = p_team and t.storage_backend = 'r2');
$$;

-- 1. Team lists and the gate -------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_my_teams()
 RETURNS TABLE(id uuid, name text, role text, permissions jsonb, connection_state text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select team.id,
         team.name,
         case when team.owner_id = auth.uid() then 'owner' else member.base_role end,
         private.effective_permissions(team.id, auth.uid()),
         coalesce(connection.state, 'none')
  from public.team_members member
  join public.teams team
    on team.id = member.team_id
   and team.status = 'active'
   -- 057: an R2 space is listed only by list_my_teams_v2, so a client that cannot open one never sees it.
   and team.storage_backend = 'drive'
  left join lateral (
    select drive.state
    from public.team_drive_connections drive
    where drive.team_id = team.id
      and drive.state <> 'detached'
    order by drive.created_at desc
    limit 1
  ) connection on true
  where auth.uid() is not null
    and private.team_profile_active(auth.uid())
    and member.user_id = auth.uid()
    and member.status = 'active'
    and private.team_workspace_allowed(team.id)
  order by team.created_at, team.id;
$function$;

CREATE FUNCTION public.list_my_teams_v2()
 RETURNS TABLE(id uuid, name text, role text, permissions jsonb, connection_state text, storage_backend text, storage_pilot boolean, content_revision bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select team.id,
         team.name,
         case when team.owner_id = auth.uid() then 'owner' else member.base_role end,
         private.effective_permissions(team.id, auth.uid()),
         coalesce(connection.state, 'none'),
         team.storage_backend,
         team.storage_pilot,
         team.content_revision
  from public.team_members member
  join public.teams team
    on team.id = member.team_id
   and team.status = 'active'
  left join lateral (
    select drive.state
    from public.team_drive_connections drive
    where drive.team_id = team.id
      and drive.state <> 'detached'
    order by drive.created_at desc
    limit 1
  ) connection on true
  where auth.uid() is not null
    and private.team_profile_active(auth.uid())
    and member.user_id = auth.uid()
    and member.status = 'active'
    and private.team_workspace_allowed(team.id)
  order by team.created_at, team.id;
$function$;

CREATE OR REPLACE FUNCTION private.team_workspace_allowed(p_team uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.teams as team
    where team.id = p_team
      and team.status = 'active'
      and (
        -- 057: a pilot space opens to pilot users only, without a 034 tariff. A service call
        -- (no user) acts for the space, so it is open while the owner is a pilot.
        (team.storage_pilot and private.is_storage_r2_pilot_user(coalesce(auth.uid(), team.owner_id)))
        or (not team.storage_pilot and (
        exists (select 1 from public.admin_users as owner_admin where owner_admin.user_id = team.owner_id)
        or exists (
          select 1 from public.space_tariffs as tariff
          where tariff.team_id = team.id
            and (tariff.revoked_at is null or tariff.revoked_at > private.tariff_now())
            and private.tariff_now() < private.kyiv_day_end(tariff.ends_on + 3)
        )
        or (private.tariff_legacy_rule_enabled() and private.team_legacy_open(team.id))
        ))
      )
  );
$function$;

-- 2. access_epoch ------------------------------------------------------------------------

create function private.bump_space_access_epoch(p_team uuid) returns void
language sql security definer set search_path = '' as $$
  update public.teams set access_epoch = access_epoch + 1
  where id = p_team and storage_backend = 'r2';
$$;

create function private.team_member_access_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'active' then perform private.bump_space_access_epoch(old.team_id); end if;
    return null;
  end if;
  if new.base_role is distinct from old.base_role
    or new.permission_overrides is distinct from old.permission_overrides
    or new.status is distinct from old.status
    or new.user_id is distinct from old.user_id
    or new.team_id is distinct from old.team_id then
    perform private.bump_space_access_epoch(new.team_id);
    if new.team_id is distinct from old.team_id then
      perform private.bump_space_access_epoch(old.team_id);
    end if;
  end if;
  return null;
end;
$$;
create trigger team_members_space_access_epoch after update or delete on public.team_members
  for each row execute function private.team_member_access_changed();

create function private.team_space_access_changed() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.storage_backend = 'r2' and (new.owner_id is distinct from old.owner_id or new.status is distinct from old.status
    or new.storage_pilot is distinct from old.storage_pilot) then
    new.access_epoch := old.access_epoch + 1;
  end if;
  return new;
end;
$$;
create trigger teams_space_access_epoch before update of owner_id, status, storage_pilot on public.teams
  for each row execute function private.team_space_access_changed();

create function private.storage_r2_pilot_access_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_team uuid; v_user uuid;
begin
  if tg_op = 'DELETE' then
    v_user := old.user_id;
  elsif old.removed_at is null and new.removed_at is not null then
    v_user := new.user_id;
  else
    return null;
  end if;
  for v_team in
    select member.team_id from public.team_members member
    join public.teams team on team.id = member.team_id and team.storage_backend = 'r2' and team.storage_pilot
    where member.user_id = v_user and member.status = 'active'
  loop
    perform private.bump_space_access_epoch(v_team);
  end loop;
  return null;
end;
$$;
create trigger storage_r2_pilots_access_epoch after update of removed_at or delete on public.storage_r2_pilots
  for each row execute function private.storage_r2_pilot_access_changed();

-- 3. Lists over R2 rows ------------------------------------------------------------------

CREATE FUNCTION private.space_list_folder_page(p_team uuid, p_parent_folder_id text, p_kind text[], p_after_sort_key text, p_after_id uuid, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  root_folder text;
  parent text;
  total_count integer;
  page_rows jsonb;
  next_cursor jsonb := null;
begin
  select team.storage_root_material_id::text into root_folder
  from public.teams as team where team.id = p_team;
  if root_folder is null then
    return jsonb_build_object('rows', '[]'::jsonb, 'total', 0, 'next', null);
  end if;
  parent := coalesce(p_parent_folder_id, root_folder);

  select count(*) into total_count
  from public.team_materials as material
  where material.team_id = p_team
    and material.connection_id is null
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
      and material.connection_id is null
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
    -- 012 (T003): whether the video already has text to read, so the row can say so without a
    -- second call per file.
    || case when page.row_kind = 'video'
         then jsonb_build_object(
                'hasTranscriptCompanion', private.has_readable_transcript(p_team, page.id))
         else '{}'::jsonb end
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
$function$;

CREATE OR REPLACE FUNCTION public.list_team_folder_page(p_team uuid, p_parent_folder_id text DEFAULT NULL::text, p_kind text[] DEFAULT NULL::text[], p_after_sort_key text DEFAULT NULL::text, p_after_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- 057: an R2 space lists by folder id, without a Drive connection.
  if private.space_is_r2(p_team) then
    return private.space_list_folder_page(p_team, p_parent_folder_id, p_kind, p_after_sort_key, p_after_id, p_limit);
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
    -- 012 (T003): whether the video already has text to read, so the row can say so without a
    -- second call per file.
    || case when page.row_kind = 'video'
         then jsonb_build_object(
                'hasTranscriptCompanion', private.has_readable_transcript(p_team, page.id))
         else '{}'::jsonb end
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
$function$;

CREATE FUNCTION private.space_list_folder_tree(p_team uuid)
 RETURNS TABLE(id uuid, drive_file_id text, parent_folder_id text, selection_id uuid, name text, indexed_at timestamp with time zone, child_folder_count integer, child_file_count integer, thumbnail_ready_count integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  folder_count bigint;
begin
  select count(*) into folder_count
  from public.team_materials as material
  where material.team_id = p_team
    and material.connection_id is null
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
      and child.connection_id is null
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
  left join counts on counts.parent_folder_id = folder.id::text
  where folder.team_id = p_team
    and folder.connection_id is null
    and folder.kind = 'folder'
    and folder.lifecycle = 'active'
  order by lower(folder.name), folder.id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.list_team_folder_tree(p_team uuid)
 RETURNS TABLE(id uuid, drive_file_id text, parent_folder_id text, selection_id uuid, name text, indexed_at timestamp with time zone, child_folder_count integer, child_file_count integer, thumbnail_ready_count integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  active_connection uuid;
  folder_count bigint;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  -- 057: an R2 space counts children by folder id, without a Drive connection.
  if private.space_is_r2(p_team) then
    return query select * from private.space_list_folder_tree(p_team);
    return;
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
$function$;

CREATE FUNCTION private.space_list_folder_subtree(p_team uuid, p_root text, p_max_folders integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  payload jsonb;
begin
  if p_root !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  -- The folder itself, then everything under it, in one chain: a `stable`
  -- function may not build a temporary table, and this read must stay stable so
  -- it can be planned as the single query it is. One row past the ceiling is
  -- fetched deliberately — that extra row is how the answer knows it was cut.
  with recursive walk as (
    select folder.id::text as folder_key, 1 as depth
    from public.team_materials as folder
    where folder.team_id = p_team
      and folder.connection_id is null
      and folder.kind = 'folder'
      and folder.lifecycle = 'active'
      and folder.id = p_root::uuid
    union
    select child.id::text, walk.depth + 1
    from walk
    join public.team_materials as child
      on child.parent_folder_id = walk.folder_key
     and child.team_id = p_team
     and child.connection_id is null
     and child.kind = 'folder'
     and child.lifecycle = 'active'
    where walk.depth < 64
  ), capped as (
    select folder_key, depth,
           row_number() over (order by depth, folder_key) as position
    from walk
    limit p_max_folders + 1
  ), kept as (
    select folder_key from capped where position <= p_max_folders
  ), files as (
    select material.id, material.team_id, material.drive_file_id,
           material.parent_folder_id, material.name, material.category
    from public.team_materials as material
    join kept on kept.folder_key = material.parent_folder_id
    where material.team_id = p_team
      and material.connection_id is null
      and material.lifecycle = 'active'
      and material.kind <> 'folder'
      and material.category in ('video', 'landing')
      and not private.is_housekeeping_name(material.name)
  )
  select jsonb_build_object(
    'foldersVisited', least((select count(*) from capped), p_max_folders)::integer,
    'truncated', (select count(*) from capped) > p_max_folders
                 or coalesce((select max(depth) from capped), 0) >= 64,
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
$function$;

CREATE OR REPLACE FUNCTION public.list_team_folder_subtree(p_team uuid, p_root text, p_max_folders integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- 057: an R2 space walks folders by id, without a Drive connection.
  if private.space_is_r2(p_team) then
    return private.space_list_folder_subtree(p_team, p_root, p_max_folders);
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
    select drive_file_id, depth,
           row_number() over (order by depth, drive_file_id) as position
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
    'truncated', (select count(*) from capped) > p_max_folders
                 or coalesce((select max(depth) from capped), 0) >= 64,
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
$function$;

CREATE OR REPLACE FUNCTION public.list_team_materials(p_team uuid, p_parent_folder_id text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, team_id uuid, drive_file_id text, parent_folder_id text, name text, kind text, category text, mime_type text, file_extension text, size_bytes bigint, modified_at timestamp with time zone, preview_state text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  active_connection_id uuid;
  resolved_parent_folder_id text;
begin
  if not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  -- 057: an R2 space reads its folders by id, without a Drive connection.
  if private.space_is_r2(p_team) then
    return query
    select material.id, material.team_id, material.drive_file_id, material.parent_folder_id,
           material.name, material.kind, material.category, material.mime_type,
           material.file_extension, material.size_bytes, material.modified_at, material.preview_state
    from public.team_materials as material
    where material.team_id = p_team
      and material.connection_id is null
      and material.lifecycle = 'active'
      and material.parent_folder_id = coalesce(p_parent_folder_id,
        (select team.storage_root_material_id::text from public.teams as team where team.id = p_team))
    order by material.kind desc, lower(material.name), material.id
    limit 500;
    return;
  end if;

  select connection.id, connection.root_folder_id
    into active_connection_id, resolved_parent_folder_id
  from public.team_drive_connections as connection
  where connection.team_id = p_team
    and connection.state = 'connected'
  limit 1;

  resolved_parent_folder_id := coalesce(p_parent_folder_id, resolved_parent_folder_id);

  return query
  select material.id,
         material.team_id,
         material.drive_file_id,
         material.parent_folder_id,
         material.name,
         material.kind,
         material.category,
         material.mime_type,
         material.file_extension,
         material.size_bytes,
         material.modified_at,
         material.preview_state
  from public.team_materials as material
  where material.team_id = p_team
    and material.connection_id = active_connection_id
    and material.lifecycle = 'active'
    and material.parent_folder_id is not distinct from resolved_parent_folder_id
  order by material.kind desc, lower(material.name), material.id
  limit 500;
end;
$function$;

CREATE OR REPLACE FUNCTION public.list_team_trashed_materials_v2(p_team uuid, p_limit integer DEFAULT 50, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, name text, kind text, trashed_at timestamp with time zone, parent_path_hint text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if (p_before is null) <> (p_before_id is null)
     or (p_before is not null and not pg_catalog.isfinite(p_before)) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  -- 057: an R2 row names its parent folder by id.
  if private.space_is_r2(p_team) then
    return query
    select material.id, material.name, material.kind, material.trashed_at, parent.name
    from public.team_materials as material
    left join public.team_materials as parent
      on parent.team_id = material.team_id
     and parent.id::text = material.parent_folder_id
     and parent.kind = 'folder'
    where material.team_id = p_team and material.lifecycle = 'trashed'
      and material.connection_id is null
      and material.trashed_at is not null and material.folder_trash_root is null
      and (p_before is null or (material.trashed_at, material.id) < (p_before, p_before_id))
    order by material.trashed_at desc, material.id desc
    limit p_limit;
    return;
  end if;
  return query
  select material.id, material.name, material.kind, material.trashed_at, parent.name
  from public.team_materials as material
  left join public.team_materials as parent
    on parent.team_id = material.team_id
   and parent.drive_file_id = material.parent_folder_id
   and parent.kind = 'folder'
  where material.team_id = p_team and material.lifecycle = 'trashed'
    and not exists (select 1 from private.catalog_video_r2_preferences as pref
                    where pref.catalog_material_id = material.id and pref.enabled)
    and material.trashed_at is not null and material.folder_trash_root is null
    and (p_before is null or (material.trashed_at, material.id) < (p_before, p_before_id))
  order by material.trashed_at desc, material.id desc
  limit p_limit;
end;
$function$;

-- 4. Grants ------------------------------------------------------------------------------

revoke all on function private.space_is_r2(uuid), private.bump_space_access_epoch(uuid),
  private.team_member_access_changed(), private.team_space_access_changed(),
  private.storage_r2_pilot_access_changed(),
  private.space_list_folder_page(uuid, text, text[], text, uuid, integer),
  private.space_list_folder_tree(uuid), private.space_list_folder_subtree(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.list_my_teams_v2() from public, anon;
grant execute on function public.list_my_teams_v2() to authenticated;
