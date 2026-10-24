begin;

-- Both baseline scans and incremental replay must hide captured unpublished
-- outputs. Initial filtering alone cannot cover a concurrent first capture.
create function private.filter_process_output_catalog_files(p_files jsonb)
returns jsonb language sql stable set search_path='' as $$
 select coalesce(jsonb_agg(item),'[]'::jsonb) from jsonb_array_elements(p_files) item
 where not exists(select 1 from private.process_upload_ownership u
  where u.file_id=item->>'drive_file_id' and u.upload_state<>'published'
  and not exists(select 1 from public.team_materials m where m.drive_file_id=u.file_id))
$$;
revoke all on function private.filter_process_output_catalog_files(jsonb) from public,anon,authenticated,service_role;

create or replace function private.fence_process_output_adoption() returns trigger
language plpgsql security definer set search_path='' as $$
declare u private.process_upload_ownership%rowtype;
begin
 if tg_op='UPDATE' and old.drive_file_id is not distinct from new.drive_file_id then return new;end if;
 insert into private.process_output_identity_fences(file_id) values(new.drive_file_id) on conflict do nothing;
 perform 1 from private.process_output_identity_fences where file_id=new.drive_file_id for update;
 select * into u from private.process_upload_ownership where file_id=new.drive_file_id for update;
 if not found then return new;end if;
 if pg_catalog.current_setting('soty.process_output_catalog_ingest',true)='on' and u.upload_state<>'published'
  and not exists(select 1 from public.team_materials m where m.drive_file_id=new.drive_file_id) then
  return null;
 end if;
 if u.cleanup_mutation_started_at is not null then
  raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';
 end if;
 return new;
end $$;

create or replace function public.service_upsert_catalog_page(
  p_connection uuid,
  p_parent_folder_id text,
  p_files jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_team uuid;
  affected integer;
  prior_ingest text;
begin
  prior_ingest := pg_catalog.current_setting('soty.process_output_catalog_ingest',true);
  if pg_catalog.jsonb_typeof(p_files) <> 'array' or pg_catalog.jsonb_array_length(p_files) > 1000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select connection.team_id into resolved_team
  from public.team_drive_connections as connection
  where connection.id = p_connection and connection.state <> 'detached';
  if resolved_team is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  p_files := private.filter_process_output_catalog_files(p_files);
  perform pg_catalog.set_config('soty.process_output_catalog_ingest','on',true);

  insert into public.team_materials (
    team_id, connection_id, drive_file_id, drive_id, resource_key,
    parent_folder_id, name, mime_type, file_extension, kind,
    shortcut_target_id, shortcut_target_resource_key, category,
    classification_version, classification_source, size_bytes, modified_at,
    drive_version, checksum, lifecycle, transcript_ingest_state
  )
  select resolved_team, p_connection, item.drive_file_id, item.drive_id, item.resource_key,
         coalesce(item.parent_folder_id, p_parent_folder_id), item.name, item.mime_type,
         item.file_extension, item.kind, item.shortcut_target_id,
         item.shortcut_target_resource_key, item.category,
         coalesce(item.classification_version, 1),
         coalesce(item.classification_source, 'fallback'), item.size_bytes,
         nullif(item.modified_at, '')::timestamptz, item.drive_version, item.checksum,
         'active', case when item.category = 'transcript' then 'pending' else 'not_applicable' end
  from pg_catalog.jsonb_to_recordset(p_files) as item(
    drive_file_id text, drive_id text, resource_key text, parent_folder_id text,
    name text, mime_type text, file_extension text, kind text,
    shortcut_target_id text, shortcut_target_resource_key text, category text,
    classification_version integer, classification_source text, size_bytes bigint,
    modified_at text, drive_version text, checksum text
  )
  where char_length(item.drive_file_id) between 1 and 1024
    and char_length(item.name) between 1 and 1024
    and item.kind in ('file', 'folder', 'shortcut')
  on conflict (team_id, drive_file_id) do update
  set connection_id = excluded.connection_id,
      drive_id = excluded.drive_id,
      resource_key = excluded.resource_key,
      parent_folder_id = excluded.parent_folder_id,
      name = excluded.name,
      mime_type = excluded.mime_type,
      file_extension = excluded.file_extension,
      kind = excluded.kind,
      shortcut_target_id = excluded.shortcut_target_id,
      shortcut_target_resource_key = excluded.shortcut_target_resource_key,
      category = case
        when public.team_materials.landing_validation_state = 'validated'
          and public.team_materials.landing_validation_version is not distinct from excluded.drive_version
          and excluded.category = 'archive' then 'landing'
        else excluded.category end,
      classification_version = excluded.classification_version,
      classification_source = case
        when public.team_materials.landing_validation_state = 'validated'
          and public.team_materials.landing_validation_version is not distinct from excluded.drive_version
          and excluded.category = 'archive' then 'inspected_landing'
        else excluded.classification_source end,
      size_bytes = excluded.size_bytes,
      modified_at = excluded.modified_at,
      landing_validation_state = case
        when public.team_materials.drive_version is distinct from excluded.drive_version then null
        else public.team_materials.landing_validation_state end,
      landing_validation_version = case
        when public.team_materials.drive_version is distinct from excluded.drive_version then null
        else public.team_materials.landing_validation_version end,
      landing_validation_fingerprint = case
        when public.team_materials.drive_version is distinct from excluded.drive_version then null
        else public.team_materials.landing_validation_fingerprint end,
      transcript_text = case
        when public.team_materials.drive_version is distinct from excluded.drive_version
          or public.team_materials.checksum is distinct from excluded.checksum
          or public.team_materials.mime_type is distinct from excluded.mime_type
          or public.team_materials.file_extension is distinct from excluded.file_extension
          or excluded.category <> 'transcript' then null
        else public.team_materials.transcript_text end,
      transcript_ingest_state = case
        when excluded.category <> 'transcript' then 'not_applicable'
        when public.team_materials.drive_version is distinct from excluded.drive_version
          or public.team_materials.checksum is distinct from excluded.checksum
          or public.team_materials.mime_type is distinct from excluded.mime_type
          or public.team_materials.file_extension is distinct from excluded.file_extension then 'pending'
        else public.team_materials.transcript_ingest_state end,
      transcript_truncated = case
        when public.team_materials.drive_version is distinct from excluded.drive_version
          or public.team_materials.checksum is distinct from excluded.checksum
          or public.team_materials.mime_type is distinct from excluded.mime_type
          or public.team_materials.file_extension is distinct from excluded.file_extension
          or excluded.category <> 'transcript' then false
        else public.team_materials.transcript_truncated end,
      transcript_indexed_bytes = case
        when public.team_materials.drive_version is distinct from excluded.drive_version
          or public.team_materials.checksum is distinct from excluded.checksum
          or public.team_materials.mime_type is distinct from excluded.mime_type
          or public.team_materials.file_extension is distinct from excluded.file_extension
          or excluded.category <> 'transcript' then 0
        else public.team_materials.transcript_indexed_bytes end,
      transcript_error_code = case
        when public.team_materials.drive_version is distinct from excluded.drive_version
          or public.team_materials.checksum is distinct from excluded.checksum
          or public.team_materials.mime_type is distinct from excluded.mime_type
          or public.team_materials.file_extension is distinct from excluded.file_extension then null
        else public.team_materials.transcript_error_code end,
      drive_version = excluded.drive_version,
      checksum = excluded.checksum,
      lifecycle = 'active',
      trashed_at = null,
      missing_at = null,
      updated_at = clock_timestamp();
  get diagnostics affected = row_count;
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (resolved_team, null, 'upserted');
  perform pg_catalog.set_config('soty.process_output_catalog_ingest',coalesce(prior_ingest,''),true);
  return affected;
exception when others then
  perform pg_catalog.set_config('soty.process_output_catalog_ingest',coalesce(prior_ingest,''),true);
  raise;
end;
$$;


create or replace function private.upsert_catalog_snapshot(
  p_connection uuid,
  p_parent_folder_id text,
  p_files jsonb,
  p_snapshot pg_snapshot
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_team uuid;
  affected integer;
  prior_ingest text;
begin
  prior_ingest := pg_catalog.current_setting('soty.process_output_catalog_ingest',true);
  if pg_catalog.jsonb_typeof(p_files) <> 'array' or pg_catalog.jsonb_array_length(p_files) > 1000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select connection.team_id into resolved_team
  from public.team_drive_connections as connection
  where connection.id = p_connection and connection.state <> 'detached';
  if resolved_team is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  select coalesce(jsonb_agg(item), '[]'::jsonb) into p_files
  from jsonb_array_elements(p_files) item where item ->> 'name' <> '.soty'
    and not exists(select 1 from private.process_upload_ownership own
      where own.file_id=item->>'drive_file_id' and own.upload_state<>'published'
        -- A separate explicit publication may have adopted the file. Existing
        -- materials fence cleanup and must retain ordinary catalog readback.
        and not exists(select 1 from public.team_materials registered where registered.drive_file_id=own.file_id));

  p_files := private.filter_process_output_catalog_files(p_files);
  perform pg_catalog.set_config('soty.process_output_catalog_ingest','on',true);

  insert into public.team_materials (
    team_id, connection_id, drive_file_id, drive_id, resource_key,
    parent_folder_id, name, mime_type, file_extension, kind,
    shortcut_target_id, shortcut_target_resource_key, category,
    classification_version, classification_source, size_bytes, modified_at,
    drive_version, checksum, lifecycle, transcript_ingest_state
  )
  select resolved_team, p_connection, item.drive_file_id, item.drive_id, item.resource_key,
         coalesce(item.parent_folder_id, p_parent_folder_id), item.name, item.mime_type,
         item.file_extension, item.kind, item.shortcut_target_id,
         item.shortcut_target_resource_key, item.category,
         coalesce(item.classification_version, 1),
         coalesce(item.classification_source, 'fallback'), item.size_bytes,
         nullif(item.modified_at, '')::timestamptz, item.drive_version, item.checksum,
         'active', case when item.category = 'transcript' then 'pending' else 'not_applicable' end
  from pg_catalog.jsonb_to_recordset(p_files) as item(
    drive_file_id text, drive_id text, resource_key text, parent_folder_id text,
    name text, mime_type text, file_extension text, kind text,
    shortcut_target_id text, shortcut_target_resource_key text, category text,
    classification_version integer, classification_source text, size_bytes bigint,
    modified_at text, drive_version text, checksum text
  )
  where char_length(item.drive_file_id) between 1 and 1024
    and char_length(item.name) between 1 and 1024
    and item.kind in ('file', 'folder', 'shortcut')
  on conflict (team_id, drive_file_id) do update
  set connection_id = excluded.connection_id,
      drive_id = excluded.drive_id,
      resource_key = excluded.resource_key,
      parent_folder_id = excluded.parent_folder_id,
      name = excluded.name,
      mime_type = excluded.mime_type,
      file_extension = excluded.file_extension,
      kind = excluded.kind,
      shortcut_target_id = excluded.shortcut_target_id,
      shortcut_target_resource_key = excluded.shortcut_target_resource_key,
      category = case
        when public.team_materials.landing_validation_state = 'validated'
          and public.team_materials.landing_validation_version is not distinct from excluded.drive_version
          and excluded.category = 'archive' then 'landing'
        else excluded.category end,
      classification_version = excluded.classification_version,
      classification_source = case
        when public.team_materials.landing_validation_state = 'validated'
          and public.team_materials.landing_validation_version is not distinct from excluded.drive_version
          and excluded.category = 'archive' then 'inspected_landing'
        else excluded.classification_source end,
      size_bytes = excluded.size_bytes,
      modified_at = excluded.modified_at,
      landing_validation_state = case
        when public.team_materials.drive_version is distinct from excluded.drive_version then null
        else public.team_materials.landing_validation_state end,
      landing_validation_version = case
        when public.team_materials.drive_version is distinct from excluded.drive_version then null
        else public.team_materials.landing_validation_version end,
      landing_validation_fingerprint = case
        when public.team_materials.drive_version is distinct from excluded.drive_version then null
        else public.team_materials.landing_validation_fingerprint end,
      transcript_text = case
        when public.team_materials.drive_version is distinct from excluded.drive_version
          or public.team_materials.checksum is distinct from excluded.checksum
          or public.team_materials.mime_type is distinct from excluded.mime_type
          or public.team_materials.file_extension is distinct from excluded.file_extension
          or excluded.category <> 'transcript' then null
        else public.team_materials.transcript_text end,
      transcript_ingest_state = case
        when excluded.category <> 'transcript' then 'not_applicable'
        when public.team_materials.drive_version is distinct from excluded.drive_version
          or public.team_materials.checksum is distinct from excluded.checksum
          or public.team_materials.mime_type is distinct from excluded.mime_type
          or public.team_materials.file_extension is distinct from excluded.file_extension then 'pending'
        else public.team_materials.transcript_ingest_state end,
      transcript_truncated = case
        when public.team_materials.drive_version is distinct from excluded.drive_version
          or public.team_materials.checksum is distinct from excluded.checksum
          or public.team_materials.mime_type is distinct from excluded.mime_type
          or public.team_materials.file_extension is distinct from excluded.file_extension
          or excluded.category <> 'transcript' then false
        else public.team_materials.transcript_truncated end,
      transcript_indexed_bytes = case
        when public.team_materials.drive_version is distinct from excluded.drive_version
          or public.team_materials.checksum is distinct from excluded.checksum
          or public.team_materials.mime_type is distinct from excluded.mime_type
          or public.team_materials.file_extension is distinct from excluded.file_extension
          or excluded.category <> 'transcript' then 0
        else public.team_materials.transcript_indexed_bytes end,
      transcript_error_code = case
        when public.team_materials.drive_version is distinct from excluded.drive_version
          or public.team_materials.checksum is distinct from excluded.checksum
          or public.team_materials.mime_type is distinct from excluded.mime_type
          or public.team_materials.file_extension is distinct from excluded.file_extension then null
        else public.team_materials.transcript_error_code end,
      drive_version = excluded.drive_version,
      checksum = excluded.checksum,
      lifecycle = 'active',
      trashed_at = null,
      missing_at = null,
      missing_reason = null,
      updated_at = clock_timestamp()
  where pg_visible_in_snapshot(public.team_materials.catalog_mutation_xid::text::xid8, p_snapshot)
    and (public.team_materials.connection_id, public.team_materials.parent_folder_id,
      public.team_materials.name, public.team_materials.mime_type, public.team_materials.kind,
      public.team_materials.drive_version, public.team_materials.checksum, public.team_materials.lifecycle,
      public.team_materials.drive_id, public.team_materials.resource_key, public.team_materials.file_extension,
      public.team_materials.shortcut_target_id, public.team_materials.shortcut_target_resource_key,
      public.team_materials.size_bytes, public.team_materials.modified_at)
      is distinct from (excluded.connection_id, excluded.parent_folder_id, excluded.name, excluded.mime_type,
        excluded.kind, excluded.drive_version, excluded.checksum, 'active'::text, excluded.drive_id,
        excluded.resource_key, excluded.file_extension, excluded.shortcut_target_id,
        excluded.shortcut_target_resource_key, excluded.size_bytes, excluded.modified_at);
  get diagnostics affected = row_count;
  if affected > 0 then
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    values (resolved_team, null, 'upserted');
  end if;
  perform pg_catalog.set_config('soty.process_output_catalog_ingest',coalesce(prior_ingest,''),true);
  return affected;
exception when others then
  perform pg_catalog.set_config('soty.process_output_catalog_ingest',coalesce(prior_ingest,''),true);
  raise;
end;
$$;


create or replace function public.service_upsert_catalog_page(
  p_job uuid, p_worker text, p_epoch bigint, p_connection uuid, p_parent_folder_id text, p_files jsonb
) returns integer language plpgsql security definer set search_path = '' as $$
declare existing_ids text[]; added bigint; affected integer;
begin
  if not private.lock_catalog_sync_lease(p_job, p_worker, p_epoch) then
    raise exception 'LEASE_LOST' using errcode = 'P0001';
  end if;
  p_files := private.filter_process_output_catalog_files(p_files);
  select coalesce(array_agg(m.drive_file_id),array[]::text[]) into existing_ids
    from jsonb_array_elements(p_files) item join public.team_materials m
    on m.connection_id=p_connection and m.drive_file_id=item->>'drive_file_id';
  affected := public.service_upsert_catalog_page(p_connection, p_parent_folder_id, p_files);
  -- Count actual accepted material identities, including a trigger-side skip
  -- when first ownership capture committed after the prefilter snapshot.
  select least(affected,count(*)) into added from jsonb_array_elements(p_files) item
    join public.team_materials m on m.connection_id=p_connection and m.drive_file_id=item->>'drive_file_id'
    where not(m.drive_file_id=any(existing_ids));
  update private.catalog_sync_jobs set
    files_added = files_added + added,
    files_updated = files_updated + greatest(affected - added, 0),
    last_progress_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = p_job;
  return affected;
end;
$$;

-- Explain why the reference fence refused cleanup, without exposing its target.
create or replace view public.analytics_process_output_cleanup as
 select u.operation_id as id,u.actor_id,u.upload_state,u.cleanup_state,u.attempts,24::integer as max_attempts,
 u.handoff_expires_at as captured_handoff_expires_at,u.next_attempt_at,u.lease_expires_at,u.created_at,u.updated_at,
 u.cleanup_mutation_started_at is not null as provider_mutation_reserved,
 exists(select 1 from public.team_materials m where m.drive_file_id=u.file_id) as provider_material_registered,
 exists(select 1 from private.team_operation_intents i where i.operation_id=u.operation_id and i.provider_result_id is not null) as provider_result_recorded
 from private.process_upload_ownership u;
revoke all on public.analytics_process_output_cleanup from public,anon,authenticated;
grant select on public.analytics_process_output_cleanup to service_role;
do $$ begin if exists(select 1 from pg_catalog.pg_roles where rolname='wishly_analytics_ro') then grant select on public.analytics_process_output_cleanup to wishly_analytics_ro; end if;end $$;

commit;
