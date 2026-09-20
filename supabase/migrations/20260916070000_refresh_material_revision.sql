-- A source whose Drive version moved without its bytes moving (found with feature 023).
--
-- Sharing a file by link — 022 does it to every catalog's video — moves the file's Drive version and
-- nothing else, and the catalog does not always hear of it. A process then binds the live version at
-- start, and `service_finalize_uploaded_material` compares it with the stale row: SOURCE_CHANGED for a
-- file nobody changed. drive-ops has just proved the file live at process start; when its checksum is
-- the one on record, the row takes the live version. Different bytes are left for catalog sync.
-- Additive; reverse steps in ROLLBACK.md.

create or replace function public.service_refresh_material_revision(
  p_material uuid, p_drive_file_id text, p_drive_version text, p_checksum text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  refreshed uuid;
begin
  if p_drive_version is null or p_drive_version = '' or p_checksum is null or p_checksum = '' then
    return false;
  end if;
  update public.team_materials as material
     set drive_version = p_drive_version
   where material.id = p_material
     and material.drive_file_id = p_drive_file_id
     and material.checksum = p_checksum
     and material.drive_version is distinct from p_drive_version
  returning material.id into refreshed;
  return refreshed is not null;
end;
$$;

revoke all on function public.service_refresh_material_revision(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.service_refresh_material_revision(uuid, text, text, text)
  to service_role;
