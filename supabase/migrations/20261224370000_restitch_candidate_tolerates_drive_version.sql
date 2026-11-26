-- Incident 2026-11-26: a launch failed with SOURCE_CHANGED because its re-stitch pictures had
-- been uploaded a few minutes earlier.
--
-- Google Drive raises the version of a fresh upload by itself (1 -> 2, the thumbnail) without
-- touching a byte: checksum, size and MIME type stay what they were. A catalog video set freezes
-- its picture candidates at admission (private.catalog_video_restitch_candidates, drive_version
-- '1'); each variant copies them into private.restitch_selection_candidates when its process
-- alias is accepted. The copy goes through this trigger, which compared the frozen drive_version
-- with the material's current one — so every variant admitted after the bump was refused, for
-- good, because the set's snapshot is immutable.
--
-- A picture candidate's identity is its content. private.restitch_candidate_versions is keyed by
-- (connection, file, checksum, MIME type, size); the reservation step and the source read
-- (private.cas_restitch_selection_slot_core, private.read_restitch_selection_source_core) compare
-- the same fields and never the Drive version; the range function reads by file id and proves the
-- checksum; the agent caches a screen by material and checksum. This trigger was the only place
-- that held a picture to its Drive version.
--
-- Now: the same content under a newer Drive version is the same candidate, and the row records
-- the version it was frozen at. Content that cannot be proved (no checksum, size or MIME type on
-- the material) is refused as before, and so is a material without a version.
--
-- The VIDEO source keeps its strict raw-version policy (restitch_selection_source_matches,
-- service_accept_catalog_video_restitch_alias): nothing here touches it.
begin;
create or replace function private.restitch_selection_freeze_candidate() returns trigger
language plpgsql security definer set search_path='' as $fn$
declare r private.restitch_selection_roots%rowtype;s private.restitch_selection_slots%rowtype;
 m public.team_materials%rowtype;d public.team_drive_connections%rowtype;
begin
 if tg_op='UPDATE' then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into r from private.restitch_selection_roots where root_operation_id=new.root_operation_id for share;
 select * into s from private.restitch_selection_slots where root_operation_id=new.root_operation_id and slot=new.slot for update;
 if (s.budget->>'revision')::bigint<>0 then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into m from public.team_materials where id=new.material_id and team_id=r.team_id for share;
 if m.id is null or m.lifecycle<>'active' or m.kind<>'file' or m.category is distinct from 'image'
  or m.checksum is null or m.size_bytes is null or m.mime_type is null or m.drive_version is null
  or m.checksum is distinct from new.checksum or m.size_bytes is distinct from new.size_bytes
  or m.mime_type is distinct from new.mime_type then
  raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 select * into d from public.team_drive_connections where id=m.connection_id and team_id=r.team_id for share;
 if d.id is null or d.state<>'connected' or m.parent_folder_id is null then
  raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if (new.connection_id is not null and new.connection_id is distinct from m.connection_id)
  or (new.drive_file_id is not null and new.drive_file_id is distinct from m.drive_file_id)
  or (new.resource_key is not null and new.resource_key is distinct from m.resource_key)
  or (new.parent_folder_id is not null and new.parent_folder_id is distinct from m.parent_folder_id)
  or (new.root_folder_id is not null and new.root_folder_id is distinct from d.root_folder_id) then
  raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 new.connection_id:=m.connection_id;new.drive_file_id:=m.drive_file_id;
 new.resource_key:=m.resource_key;new.parent_folder_id:=m.parent_folder_id;new.root_folder_id:=d.root_folder_id;
 -- Proved identical above; the frozen row says which Drive version carried that content.
 new.drive_version:=m.drive_version;
 return new;
end $fn$;
commit;
