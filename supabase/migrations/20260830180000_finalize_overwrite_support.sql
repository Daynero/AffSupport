-- 013 (B4): let a process operation overwrite its own source in place.
-- The compressor's "перезаписати оригінал" writes the result INTO the source
-- file (same Drive file id, PATCH resumable session). Three checks predated
-- that flow and rejected it with SOURCE_CHANGED / MATERIAL_LINK_CYCLE:
--   1. the stale-source guard (the source's drive version has legitimately
--      advanced — this very operation advanced it);
--   2. the "result must not be the source file" guard;
--   3. the processed_from self-link (skipped: a material cannot derive from
--      itself).
-- All three are now skipped ONLY when intent.version_of_material_id equals
-- the operation's source_material_id — the explicit overwrite contract.

CREATE OR REPLACE FUNCTION public.service_finalize_uploaded_material(p_operation uuid, p_actor uuid, p_drive jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  operation_row public.team_operations%rowtype;
  intent_row private.team_operation_intents%rowtype;
  destination public.team_materials%rowtype;
  -- The space root is not a material, so a root upload has no destination row:
  -- these two carry what the rest of the function actually needs from it.
  destination_connection_id uuid;
  destination_drive_file_id text;
  source public.team_materials%rowtype;
  result_row public.team_materials%rowtype;
  actual_drive_file_id text;
  actual_name text;
  actual_mime text;
  actual_parent text;
  actual_kind text;
  actual_category text;
  actual_extension text;
  actual_classification_source text;
  actual_size bigint;
  actual_modified_at timestamptz;
  actual_version text;
  actual_checksum text;
  actual_drive_id text;
  actual_resource_key text;
  required_permission text;
begin
  if pg_catalog.jsonb_typeof(p_drive) <> 'object'
     or exists (
       select 1 from pg_catalog.jsonb_object_keys(p_drive) as key(name)
       where key.name not in (
         'driveFileId','driveId','resourceKey','parentFolderId','name','mimeType',
         'fileExtension','kind','category','classificationSource','sizeBytes',
         'modifiedAt','driveVersion','checksum'
       )
     ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select operation.* into operation_row
  from public.team_operations as operation
  where operation.id = p_operation and operation.actor_id = p_actor
  for update;
  if operation_row.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if operation_row.state = 'succeeded' and operation_row.result_material_id is not null then
    return pg_catalog.jsonb_build_object(
      'operationId', operation_row.id,
      'state', operation_row.state,
      'materialId', operation_row.result_material_id,
      'reused', true
    );
  end if;
  if operation_row.kind not in ('upload','new_version','process')
     or operation_row.state not in ('pending','running') then
    raise exception 'WRONG_STATE' using errcode = '23514';
  end if;
  required_permission := case when operation_row.kind = 'process' then 'process' else 'upload' end;
  if not private.can(operation_row.team_id, required_permission, p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select intent.* into intent_row
  from private.team_operation_intents as intent
  where intent.operation_id = p_operation and intent.team_id = operation_row.team_id;
  if intent_row.operation_id is null then raise exception 'WRONG_STATE' using errcode = '23514'; end if;
  if operation_row.destination_folder_id is null then
    select connection.id, connection.root_folder_id
      into destination_connection_id, destination_drive_file_id
    from public.team_drive_connections as connection
    where connection.team_id = operation_row.team_id
      and connection.state = 'connected'
    order by connection.connected_at desc nulls last
    limit 1;
  else
    select folder.* into destination
    from public.team_materials as folder
    where folder.id = operation_row.destination_folder_id
      and folder.team_id = operation_row.team_id
      and folder.kind = 'folder'
      and folder.lifecycle = 'active';
    destination_connection_id := destination.connection_id;
    destination_drive_file_id := destination.drive_file_id;
  end if;
  if destination_drive_file_id is null or destination_connection_id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if operation_row.source_material_id is not null then
    select material.* into source
    from public.team_materials as material
    where material.id = operation_row.source_material_id
      and material.team_id = operation_row.team_id;
    if source.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    if intent_row.expected_source_drive_file_id is not null
       and (intent_row.version_of_material_id is null
            or intent_row.version_of_material_id <> operation_row.source_material_id)
       and (
      source.drive_file_id is distinct from intent_row.expected_source_drive_file_id
      or source.drive_version is distinct from intent_row.expected_source_version
      or source.checksum is distinct from intent_row.expected_source_checksum
    ) then
      raise exception 'SOURCE_CHANGED' using errcode = '23514';
    end if;
  end if;

  actual_drive_file_id := p_drive ->> 'driveFileId';
  actual_name := p_drive ->> 'name';
  actual_mime := p_drive ->> 'mimeType';
  actual_parent := p_drive ->> 'parentFolderId';
  actual_kind := coalesce(p_drive ->> 'kind', 'file');
  actual_category := p_drive ->> 'category';
  actual_extension := p_drive ->> 'fileExtension';
  actual_classification_source := coalesce(p_drive ->> 'classificationSource', 'fallback');
  actual_size := nullif(p_drive ->> 'sizeBytes', '')::bigint;
  actual_modified_at := nullif(p_drive ->> 'modifiedAt', '')::timestamptz;
  actual_version := p_drive ->> 'driveVersion';
  actual_checksum := p_drive ->> 'checksum';
  actual_drive_id := p_drive ->> 'driveId';
  actual_resource_key := p_drive ->> 'resourceKey';
  if actual_drive_file_id is null or char_length(actual_drive_file_id) not between 1 and 1024
     or actual_name is distinct from intent_row.expected_name
     or actual_mime is distinct from intent_row.mime_type
     or actual_parent is distinct from destination_drive_file_id
     or actual_kind <> 'file'
     or actual_category not in ('video','image','archive','transcript','landing','other')
     or actual_classification_source not in ('mime','extension','inspected_landing','fallback')
     or actual_size is distinct from intent_row.expected_size
     or intent_row.replace_material_id is null and source.id is not null
        and actual_drive_file_id = source.drive_file_id
        and (intent_row.version_of_material_id is null
             or intent_row.version_of_material_id <> operation_row.source_material_id)
     or intent_row.replace_material_id is not null and not exists (
       select 1 from public.team_materials as replacement
       where replacement.id = intent_row.replace_material_id
         and replacement.team_id = operation_row.team_id
         and replacement.drive_file_id = actual_drive_file_id
     ) then
    raise exception 'SOURCE_CHANGED' using errcode = '23514';
  end if;

  if intent_row.replace_material_id is not null then
    update public.team_materials as material
    set connection_id = destination_connection_id,
        drive_id = actual_drive_id,
        resource_key = actual_resource_key,
        parent_folder_id = actual_parent,
        name = actual_name,
        mime_type = actual_mime,
        file_extension = actual_extension,
        kind = 'file',
        category = actual_category,
        classification_version = 1,
        classification_source = actual_classification_source,
        size_bytes = actual_size,
        modified_at = actual_modified_at,
        drive_version = actual_version,
        checksum = actual_checksum,
        lifecycle = 'active',
        trashed_at = null,
        missing_at = null,
        transcript_text = null,
        transcript_ingest_state = case when actual_category = 'transcript' then 'pending' else 'not_applicable' end,
        transcript_truncated = false,
        transcript_indexed_bytes = 0,
        transcript_source_version = null,
        transcript_source_checksum = null,
        preview_state = 'pending',
        preview_error_code = null,
        updated_at = pg_catalog.clock_timestamp()
    where material.id = intent_row.replace_material_id
      and material.team_id = operation_row.team_id
    returning material.* into result_row;
  else
    insert into public.team_materials (
      team_id, connection_id, drive_file_id, drive_id, resource_key,
      parent_folder_id, name, mime_type, file_extension, kind, category,
      classification_version, classification_source, size_bytes, modified_at,
      drive_version, checksum, lifecycle, geo, language, offer, tags,
      transcript_ingest_state, preview_state
    ) values (
      operation_row.team_id, destination_connection_id, actual_drive_file_id, actual_drive_id, actual_resource_key,
      actual_parent, actual_name, actual_mime, actual_extension, 'file', actual_category,
      1, actual_classification_source, actual_size, actual_modified_at,
      actual_version, actual_checksum, 'active', source.geo, source.language, source.offer,
      coalesce(source.tags, '{}'::text[]),
      case when actual_category = 'transcript' then 'pending' else 'not_applicable' end,
      'pending'
    )
    on conflict (team_id, drive_file_id) do update
    set connection_id = excluded.connection_id,
        drive_id = excluded.drive_id,
        resource_key = excluded.resource_key,
        parent_folder_id = excluded.parent_folder_id,
        name = excluded.name,
        mime_type = excluded.mime_type,
        file_extension = excluded.file_extension,
        category = excluded.category,
        classification_version = excluded.classification_version,
        classification_source = excluded.classification_source,
        size_bytes = excluded.size_bytes,
        modified_at = excluded.modified_at,
        drive_version = excluded.drive_version,
        checksum = excluded.checksum,
        lifecycle = 'active',
        trashed_at = null,
        missing_at = null,
        updated_at = pg_catalog.clock_timestamp()
    returning public.team_materials.* into result_row;
  end if;

  if intent_row.relation is not null and source.id is distinct from result_row.id then
    if source.id is null or source.id = result_row.id then
      raise exception 'MATERIAL_LINK_CYCLE' using errcode = '23514';
    end if;
    insert into public.team_material_links (
      team_id, source_material_id, derivative_material_id, relation,
      source_name_snapshot, tool_id, tool_contract_version, created_by
    ) values (
      operation_row.team_id, source.id, result_row.id, intent_row.relation,
      source.name, intent_row.tool_id, intent_row.tool_contract_version, p_actor
    ) on conflict (team_id, source_material_id, derivative_material_id, relation) do nothing;
  end if;

  if operation_row.state = 'pending' then
    update public.team_operations set state = 'running', stage = 'finalizing', updated_at = pg_catalog.clock_timestamp()
    where id = p_operation;
  end if;
  update public.team_operations as operation
  set state = 'succeeded',
      stage = 'completed',
      progress = 100,
      result_material_id = result_row.id,
      bytes_completed = case
        when operation.kind = 'process' then coalesce(operation.bytes_total, 0)
        else coalesce(intent_row.expected_size, 0)
      end,
      error_code = null,
      retryable = false,
      reservation_released_at = coalesce(operation.reservation_released_at, pg_catalog.clock_timestamp()),
      finished_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  where operation.id = p_operation;
  update private.team_operation_intents
  set provider_result_id = actual_drive_file_id, updated_at = pg_catalog.clock_timestamp()
  where operation_id = p_operation;
  update private.team_transfer_grants
  set revoked_at = pg_catalog.clock_timestamp()
  where operation_id = p_operation and revoked_at is null;
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (operation_row.team_id, result_row.id, 'upserted');
  perform private.record_team_audit(
    operation_row.team_id, p_actor,
    case operation_row.kind
      when 'new_version' then 'material.version_created'
      when 'process' then 'material.processed'
      else 'material.uploaded'
    end,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'material_id', result_row.id,
      'operation_id', p_operation,
      'relation', intent_row.relation
    )),
    'succeeded', null
  );
  return pg_catalog.jsonb_build_object(
    'operationId', p_operation,
    'state', 'succeeded',
    'materialId', result_row.id,
    'reused', false
  );
end;
$function$

;
