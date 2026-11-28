-- 057 T041: creating a catalog in an R2 space (FR-050; plan «Каталожні маршрути drive-ops»).
--
-- The catalog routes of drive-ops stay the one implementation of a catalog; for an R2 space they
-- read the video and its folder here instead of through Drive, write the feed instead of a sheet
-- (catalog-feed-document.ts) and link it here. Nothing below is reached by a Drive space:
--
-- * service_space_catalog_material / service_space_catalog_names — the video, its folder and the
--   folder's names, for a member of an R2 space only (private.require_space_actor).
-- * service_space_catalog_video_link — the catalog video of an R2 space is always its R2 copy
--   (050): there is no Drive link to fall back to. The copy is planned (or found) with the
--   object's content id as its source version, which is what the copy claim of a space source
--   expects (20261226210000), and the address it has or will have once verified is returned.
-- * service_commit_space_catalog_feed — the feed's companion row: an R2 row without an object
--   (team_materials_storage_shape_check allows exactly this, as the video's catalog companion),
--   committed by the catalog's own upload operation, idempotently.
-- * service_link_space_catalog_feed — the Drive link function, then, in the same transaction, the
--   feed (service_record_catalog_feed) and the catalog's R2 video preference, which queues or
--   adopts the copy for the new catalog.
-- * service_link_product_catalog_companion — patched in place: a companion row of an R2 space
--   (no connection) may be a CSV feed that is already the video's companion, and a retired one
--   keeps its companion fields. Every Drive row has a connection, so its checks are the old ones.
-- * service_catalog_video_r2_resolve_current — patched in place: a file of an R2 space is
--   identified by its object's content id (the Drive identity function answers null for it).

-- 1. Reads -----------------------------------------------------------------------------------

create function public.service_space_catalog_material(
  p_team uuid, p_material uuid, p_actor uuid, p_permission text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  m public.team_materials%rowtype;
  o public.space_objects%rowtype;
begin
  if p_permission is null or p_permission not in ('view', 'upload', 'edit') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform private.require_space_actor(p_team, p_actor, p_permission);
  select * into m from public.team_materials material
  where material.id = p_material and material.team_id = p_team
    and material.connection_id is null and material.lifecycle = 'active';
  if not found or m.kind not in ('file', 'folder') then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if m.kind = 'file' then
    select * into o from public.space_objects object
    where object.id = m.space_object_id and object.team_id = p_team
      and object.kind = 'original' and object.state = 'committed';
    if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  end if;
  return jsonb_build_object(
    'id', m.id,
    'name', m.name,
    'kind', m.kind,
    'category', m.category,
    'mimeType', coalesce(m.mime_type, o.content_type),
    'fileExtension', m.file_extension,
    'parentFolderId', m.parent_folder_id,
    'sizeBytes', case when m.kind = 'file' then o.byte_size::text else null end,
    'contentId', o.content_id,
    'materialRevision', m.material_revision::text);
end;
$$;

-- The live names in one R2 folder that start like the catalog's, for the name plan.
create function public.service_space_catalog_names(
  p_team uuid, p_folder uuid, p_actor uuid, p_prefix text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if p_folder is null or p_prefix is null or char_length(p_prefix) > 255 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform private.require_space_actor(p_team, p_actor, 'upload');
  if private.space_live_folder(p_team, p_folder) is distinct from p_folder then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('materialId', named.id, 'name', named.name) order by named.name)
    from (
      select child.id, child.name from public.team_materials child
      where child.team_id = p_team and child.connection_id is null
        and child.parent_folder_id = p_folder::text and child.lifecycle = 'active'
        and starts_with(lower(child.name), lower(p_prefix))
      order by child.name
      limit 200) named), '[]'::jsonb);
end;
$$;

-- 2. The catalog video's R2 copy ---------------------------------------------------------------

create function public.service_space_catalog_video_link(p_team uuid, p_actor uuid, p_material uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  m public.team_materials%rowtype;
  o public.space_objects%rowtype;
  cfg private.catalog_video_r2_config%rowtype;
  c private.catalog_video_r2_copies%rowtype;
  decision jsonb;
begin
  perform private.require_space_actor(p_team, p_actor, 'view');
  select * into m from public.team_materials material
  where material.id = p_material and material.team_id = p_team and material.connection_id is null
    and material.lifecycle = 'active' and material.kind = 'file' and material.category = 'video';
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select * into o from public.space_objects object
  where object.id = m.space_object_id and object.team_id = p_team
    and object.kind = 'original' and object.state = 'committed';
  if not found then raise exception 'VIDEO_R2_SOURCE_UNAVAILABLE' using errcode = '55000'; end if;
  -- The catalog does not exist yet: the request itself carries the option (pre-creation scope).
  decision := public.service_catalog_video_r2_resolve(
    null, m.id, o.content_id, o.byte_size, coalesce(m.mime_type, o.content_type), null, null,
    p_team, true);
  if decision ->> 'copyId' is null then
    raise exception using
      message = coalesce(nullif(decision ->> 'reason', ''), 'VIDEO_R2_SOURCE_UNAVAILABLE'),
      errcode = '55000';
  end if;
  select * into cfg from private.catalog_video_r2_config where singleton;
  select * into c from private.catalog_video_r2_copies copy where copy.id = (decision ->> 'copyId')::uuid;
  if c.id is null or cfg.public_origin is null then
    raise exception 'VIDEO_R2_SOURCE_UNAVAILABLE' using errcode = '55000';
  end if;
  return jsonb_build_object(
    'url', cfg.public_origin || '/' || c.object_key,
    'copyId', c.id,
    'state', c.state,
    'sourceVersion', o.content_id);
end;
$$;

-- 3. The feed's companion row ------------------------------------------------------------------

create function public.service_commit_space_catalog_feed(
  p_operation uuid, p_actor uuid, p_name text, p_bytes bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  op public.team_operations%rowtype;
  v_folder uuid;
  v_id uuid;
begin
  if p_operation is null or p_name is null or char_length(p_name) not between 1 and 255
     or p_bytes is null or p_bytes not between 1 and 104857600 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into op from public.team_operations operation
  where operation.id = p_operation and operation.actor_id = p_actor
  for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  -- A repeated commit of the same operation (a resumed creation) answers what it committed.
  if op.state = 'succeeded' and op.result_material_id is not null then
    return jsonb_build_object('materialId', op.result_material_id, 'reused', true);
  end if;
  if op.kind <> 'upload' or op.state not in ('pending', 'running')
     or op.destination_folder_id is null or op.source_material_id is null then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;
  perform private.require_space_actor(op.team_id, p_actor, 'upload');
  v_folder := private.space_live_folder(op.team_id, op.destination_folder_id);
  if v_folder is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if not exists (
    select 1 from public.team_materials video
    where video.id = op.source_material_id and video.team_id = op.team_id
      and video.connection_id is null and video.lifecycle = 'active'
      and video.parent_folder_id = v_folder::text
  ) then
    raise exception 'SOURCE_CHANGED' using errcode = '55000';
  end if;
  insert into public.team_materials (
    team_id, parent_folder_id, name, kind, mime_type, file_extension, category,
    classification_source, size_bytes, modified_at, companion_of, companion_kind, placement_state)
  values (
    op.team_id, v_folder::text, p_name, 'file', 'text/csv', 'csv', 'other',
    'mime', p_bytes, now(), op.source_material_id, 'product_catalog', 'ready')
  returning id into v_id;
  if op.state = 'pending' then
    update public.team_operations set state = 'running', stage = 'finalizing', updated_at = clock_timestamp()
    where id = p_operation;
  end if;
  update public.team_operations operation set
    state = 'succeeded',
    stage = 'completed',
    progress = 100,
    result_material_id = v_id,
    bytes_completed = p_bytes,
    error_code = null,
    retryable = false,
    reservation_released_at = coalesce(operation.reservation_released_at, clock_timestamp()),
    finished_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where operation.id = p_operation;
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (op.team_id, v_id, 'upserted');
  perform private.space_content_changed(op.team_id, v_folder, false);
  return jsonb_build_object('materialId', v_id, 'reused', false);
end;
$$;

-- 4. Linking a feed ----------------------------------------------------------------------------

do $link$
declare d text;
begin
  select pg_get_functiondef('public.service_link_product_catalog_companion(uuid,uuid,uuid,uuid,jsonb)'::regprocedure) into d;
  if strpos(d, 'or companion_row.mime_type is distinct from ''application/vnd.google-apps.spreadsheet''') = 0
     or strpos(d, 'or companion_row.companion_of is not null then') = 0
     or strpos(d, 'companion_of = null,') = 0 or strpos(d, 'companion_kind = null,') = 0 then
    raise exception 'CATALOG_LINK_FEED_PATCH_MISSING';
  end if;
  -- An R2 feed row is a CSV, and it is born the video's companion: an R2 row without an object
  -- must be a catalog companion (team_materials_storage_shape_check, companion_kind_check). It is
  -- eligible while no catalog record names it yet.
  d := replace(d,
    'or companion_row.mime_type is distinct from ''application/vnd.google-apps.spreadsheet''',
    'or (companion_row.mime_type is distinct from ''application/vnd.google-apps.spreadsheet''
         and not (companion_row.connection_id is null and companion_row.mime_type = ''text/csv''))');
  d := replace(d,
    'or companion_row.companion_of is not null then',
    'or (companion_row.companion_of is not null
         and not (companion_row.connection_id is null and companion_row.mime_type = ''text/csv''
                  and companion_row.companion_of = p_video
                  and not exists (select 1 from public.team_product_catalogs as known
                                  where known.material_id = companion_row.id))) then');
  -- A retired R2 feed keeps its companion fields (the same shape rule); it is trashed all the same.
  d := replace(d, 'companion_of = null,',
    'companion_of = case when previous.connection_id is null then previous.companion_of else null end,');
  d := replace(d, 'companion_kind = null,',
    'companion_kind = case when previous.connection_id is null then previous.companion_kind else null end,');
  execute d;
end;
$link$;

create function public.service_link_space_catalog_feed(
  p_team uuid, p_video uuid, p_companion uuid, p_replaces uuid, p_record jsonb, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_feed text := p_record ->> 'feedId';
  v_bytes text := p_record ->> 'feedBytes';
  result jsonb;
begin
  if p_record is null or jsonb_typeof(p_record) <> 'object'
     or v_feed is null or v_feed !~ '^[0-9a-f]{32}$' or v_bytes is null or v_bytes !~ '^[1-9][0-9]{0,8}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform private.require_space_actor(p_team, p_actor, 'upload');
  if not exists (
    select 1 from public.team_materials companion
    where companion.id = p_companion and companion.team_id = p_team and companion.connection_id is null
      and companion.mime_type = 'text/csv' and companion.companion_kind = 'product_catalog'
  ) then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;
  result := public.service_link_product_catalog_companion(
    p_team, p_video, p_companion, p_replaces, p_record - 'feedId' - 'feedBytes');
  if coalesce((result ->> 'linked')::boolean, false) then
    perform public.service_record_catalog_feed(p_companion, v_feed, v_bytes::bigint, 0);
    -- The video of an R2 space's catalog is always its R2 copy: the preference is part of it,
    -- not a setting (050's set_preference asks for catalog settings rights; this does not).
    insert into private.catalog_video_r2_preferences(catalog_material_id, team_id, enabled, configured_by)
    values (p_companion, p_team, true, p_actor)
    on conflict (catalog_material_id) do update set
      enabled = true,
      revision = private.catalog_video_r2_preferences.revision + 1,
      configured_by = excluded.configured_by,
      updated_at = clock_timestamp();
    perform private.catalog_video_r2_journal_write(p_team, null, p_companion, null, p_actor, 'configured', null);
    perform private.catalog_video_r2_signal(p_companion);
    perform public.service_catalog_video_r2_resolve_current(p_companion);
  end if;
  return result;
end;
$$;

-- 5. The copy's source identity for a file of an R2 space ------------------------------------

do $resolve$
declare d text;
begin
  select pg_get_functiondef('public.service_catalog_video_r2_resolve_current(uuid,uuid)'::regprocedure) into d;
  if strpos(d, 'version:=private.catalog_video_r2_source_identity(m);') = 0 then
    raise exception 'CATALOG_VIDEO_SPACE_IDENTITY_PATCH_MISSING';
  end if;
  d := replace(d, 'version:=private.catalog_video_r2_source_identity(m);',
    'version:=coalesce(private.catalog_video_r2_source_identity(m),(select o.content_id from public.space_objects o where m.connection_id is null and o.id=m.space_object_id and o.team_id=m.team_id and o.kind=''original'' and o.state=''committed''));');
  execute d;
end;
$resolve$;

revoke all on function public.service_space_catalog_material(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.service_space_catalog_names(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.service_space_catalog_video_link(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.service_commit_space_catalog_feed(uuid, uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.service_link_space_catalog_feed(uuid, uuid, uuid, uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.service_space_catalog_material(uuid, uuid, uuid, text) to service_role;
grant execute on function public.service_space_catalog_names(uuid, uuid, uuid, text) to service_role;
grant execute on function public.service_space_catalog_video_link(uuid, uuid, uuid) to service_role;
grant execute on function public.service_commit_space_catalog_feed(uuid, uuid, text, bigint) to service_role;
grant execute on function public.service_link_space_catalog_feed(uuid, uuid, uuid, uuid, jsonb, uuid) to service_role;
