-- Caller-safe preview reads and service-only transfer context. Provider
-- credentials stay behind the service role; transcript text is returned only
-- by this explicit caller-checked RPC and never enters Realtime rows/events.

create or replace function public.get_material_preview(
  p_team uuid,
  p_material uuid
)
returns table (
  team_id uuid,
  material_id uuid,
  drive_file_id text,
  resource_key text,
  name text,
  category text,
  mime_type text,
  file_extension text,
  size_bytes bigint,
  drive_version text,
  checksum text,
  preview_state text,
  preview_error_code text,
  transcript_text text,
  transcript_ingest_state text,
  transcript_truncated boolean,
  transcript_indexed_bytes integer,
  transcript_source_version text,
  can_download boolean,
  can_edit boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
  select material.team_id,
         material.id,
         material.drive_file_id,
         material.resource_key,
         material.name,
         material.category,
         material.mime_type,
         material.file_extension,
         material.size_bytes,
         material.drive_version,
         material.checksum,
         material.preview_state,
         material.preview_error_code,
         material.transcript_text,
         material.transcript_ingest_state,
         material.transcript_truncated,
         material.transcript_indexed_bytes,
         material.transcript_source_version,
         private.can(p_team, 'download', auth.uid()),
         private.can(p_team, 'edit', auth.uid())
  from public.team_materials as material
  where material.id = p_material
    and material.team_id = p_team
    and material.kind = 'file'
    and material.lifecycle = 'active'
  limit 1;
end;
$$;

revoke all on function public.get_material_preview(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.get_material_preview(uuid, uuid) to authenticated;

create or replace function public.service_get_material_transfer_context(
  p_team uuid,
  p_material uuid,
  p_actor uuid
)
returns table (
  team_id uuid,
  material_id uuid,
  actor_id uuid,
  connection_id uuid,
  credential_id uuid,
  root_folder_id text,
  root_resource_key text,
  drive_id text,
  drive_file_id text,
  resource_key text,
  name text,
  category text,
  mime_type text,
  size_bytes bigint,
  drive_version text,
  checksum text
)
language sql
stable
security definer
set search_path = ''
as $$
  select material.team_id,
         material.id,
         p_actor,
         connection.id,
         connection.credential_id,
         connection.root_folder_id,
         connection.root_resource_key,
         connection.drive_id,
         material.drive_file_id,
         material.resource_key,
         material.name,
         material.category,
         material.mime_type,
         material.size_bytes,
         material.drive_version,
         material.checksum
  from public.team_materials as material
  join public.team_drive_connections as connection
    on connection.id = material.connection_id
   and connection.team_id = material.team_id
  where material.id = p_material
    and material.team_id = p_team
    and material.kind = 'file'
    and material.lifecycle = 'active'
    and connection.state = 'connected'
    and private.can(p_team, 'view', p_actor)
  limit 1;
$$;

revoke all on function public.service_get_material_transfer_context(uuid, uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.service_get_material_transfer_context(uuid, uuid, uuid)
to service_role;

create or replace function public.service_commit_landing_preview_validation(
  p_team uuid,
  p_material uuid,
  p_actor uuid,
  p_expected_version text,
  p_expected_checksum text,
  p_fingerprint text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed boolean := false;
begin
  if p_fingerprint is null
     or p_fingerprint !~ '^[a-f0-9]{64}$'
     or not private.can(p_team, 'view', p_actor) then
    return false;
  end if;
  update public.team_materials as material
  set category = 'landing',
      classification_source = 'inspected_landing',
      landing_validation_state = 'validated',
      landing_validation_version = p_expected_version,
      landing_validation_fingerprint = p_fingerprint,
      preview_state = 'ready',
      preview_error_code = null,
      updated_at = clock_timestamp()
  where material.id = p_material
    and material.team_id = p_team
    and material.kind = 'file'
    and material.lifecycle = 'active'
    and material.category in ('archive', 'landing')
    and material.drive_version is not distinct from p_expected_version
    and material.checksum is not distinct from p_expected_checksum;
  changed := found;
  if changed then
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    values (p_team, p_material, 'upserted');
  end if;
  return changed;
end;
$$;

revoke all on function public.service_commit_landing_preview_validation(
  uuid, uuid, uuid, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.service_commit_landing_preview_validation(
  uuid, uuid, uuid, text, text, text
) to service_role;
