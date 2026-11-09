-- Private frozen provider binding for measured selection ranges. No initializer,
-- public route, grant purpose or advertised executor capability is enabled here.
begin;
alter table private.restitch_selection_candidates
 add column connection_id uuid references public.team_drive_connections(id) on delete restrict,
 add column drive_file_id text,
 add column resource_key text,
 add column parent_folder_id text,
 add column root_folder_id text;

-- An old foundation row can only adopt context while its entire frozen identity
-- still agrees. Otherwise refuse migration rather than invent historical authority.
do $fn$
begin
 if exists(select 1 from private.restitch_selection_candidates c
  join private.restitch_selection_roots r using(root_operation_id)
  left join public.team_materials m on m.id=c.material_id and m.team_id=r.team_id
  left join public.team_drive_connections d on d.id=m.connection_id and d.team_id=r.team_id
  where m.id is null or d.id is null or m.kind<>'file' or m.category is distinct from 'image' or m.checksum is distinct from c.checksum
   or m.size_bytes is distinct from c.size_bytes or m.mime_type is distinct from c.mime_type
   or m.drive_version is distinct from c.drive_version or m.parent_folder_id is null) then
  raise exception 'RESTITCH_SOURCES_INVALID' using errcode='55000';
 end if;
end $fn$;
alter table private.restitch_selection_candidates disable trigger restitch_selection_candidate_binding;
update private.restitch_selection_candidates c set connection_id=m.connection_id,
 drive_file_id=m.drive_file_id,resource_key=m.resource_key,parent_folder_id=m.parent_folder_id,
 root_folder_id=d.root_folder_id
from public.team_materials m join public.team_drive_connections d on d.id=m.connection_id
where m.id=c.material_id;
alter table private.restitch_selection_candidates enable trigger restitch_selection_candidate_binding;
-- The table is new in this release (155000) and the BEFORE INSERT trigger
-- re-declared below assigns every one of these columns, so no insert can
-- reach the constraint empty.
alter table private.restitch_selection_candidates alter column connection_id set not null;
alter table private.restitch_selection_candidates alter column drive_file_id set not null;
alter table private.restitch_selection_candidates alter column parent_folder_id set not null;
alter table private.restitch_selection_candidates alter column root_folder_id set not null;

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
  or m.checksum is distinct from new.checksum or m.size_bytes is distinct from new.size_bytes
  or m.mime_type is distinct from new.mime_type or m.drive_version is distinct from new.drive_version then
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
 return new;
end $fn$;
create or replace trigger restitch_selection_candidate_binding before insert or update on private.restitch_selection_candidates
 for each row execute function private.restitch_selection_freeze_candidate();

create or replace function public.service_cas_restitch_selection_slot(
 p_root_operation uuid,p_team uuid,p_actor uuid,p_slot text,p_expected_budget jsonb,p_next_budget jsonb)
returns boolean language plpgsql security definer set search_path='' as $fn$
declare o public.team_operations%rowtype;r private.restitch_selection_roots%rowtype;
 s private.restitch_selection_slots%rowtype;m public.team_materials%rowtype;c private.restitch_selection_candidates%rowtype;
 step text;last_candidate jsonb;
begin
 select * into o from public.team_operations where id=p_root_operation for update;
 select * into r from private.restitch_selection_roots
  where root_operation_id=p_root_operation and team_id=p_team and actor_id=p_actor;
 if r.root_operation_id is null or o.team_id is distinct from p_team or o.actor_id is distinct from p_actor then
  raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if not private.can(p_team,'download',p_actor) or (o.kind='process' and not private.can(p_team,'process',p_actor)) then
  raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if o.kind not in('download','process') or o.state not in('pending','running')
  or o.source_material_id is distinct from r.source_material_id then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into m from public.team_materials where id=r.source_material_id and team_id=p_team for share;
 if m.id is null or m.lifecycle<>'active' or m.drive_version is distinct from r.source_version then
  raise exception 'RESTITCH_SOURCES_INVALID' using errcode='55000';end if;
 if p_slot is null or p_slot not in('start','end') or r.recipe->'defaults'->>'sourceMode' is distinct from 'drive'
  or r.recipe->'defaults'->>'configured' is distinct from 'true'
  or coalesce(r.recipe->'defaults'->>'operation','') not in('stitch','restitch')
  or coalesce(r.recipe->'defaults'->>(p_slot||'Enabled'),'true')<>'true' then
  raise exception 'RESTITCH_SOURCES_INVALID' using errcode='55000';end if;
 select * into s from private.restitch_selection_slots where root_operation_id=p_root_operation and slot=p_slot for update;
 if s.root_operation_id is null then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 if s.snapshot_complete is null then raise exception 'RESTITCH_SOURCES_INVALID' using errcode='55000';end if;
 if s.budget is distinct from p_expected_budget then return false;end if;
 step:=private.restitch_selection_step_kind(s.budget,p_next_budget);
 if step is null then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 last_candidate:=p_next_budget->'candidates'->(jsonb_array_length(p_next_budget->'candidates')-1);
 if step in('select','reserve') then
  select * into c from private.restitch_selection_candidates where root_operation_id=p_root_operation
   and slot=p_slot and version_id=(last_candidate->>'versionId')::uuid;
  if c.version_id is null or c.size_bytes is distinct from (last_candidate->>'sizeBytes')::bigint then
   raise exception 'RESTITCH_SOURCES_INVALID' using errcode='55000';end if;
  if step='reserve' then
   select * into m from public.team_materials where id=c.material_id and team_id=p_team for share;
   if m.id is null or m.lifecycle<>'active' or m.kind<>'file' or m.category is distinct from 'image' or m.checksum is distinct from c.checksum
    or m.size_bytes is distinct from c.size_bytes or m.mime_type is distinct from c.mime_type
    or m.connection_id is distinct from c.connection_id or m.drive_file_id is distinct from c.drive_file_id
    or m.parent_folder_id is distinct from c.parent_folder_id then
    raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
   if not exists(select 1 from public.team_drive_connections where id=c.connection_id and team_id=p_team and state='connected' and root_folder_id=c.root_folder_id) then
    raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
  end if;
 end if;
 update private.restitch_selection_slots set budget=p_next_budget where root_operation_id=p_root_operation and slot=p_slot;
 return true;
end $fn$;


create function public.service_read_restitch_selection_source(
 p_root_operation uuid,p_team uuid,p_actor uuid,p_slot text,p_version uuid,p_acquisition integer)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare r private.restitch_selection_roots%rowtype;o public.team_operations%rowtype;
 s private.restitch_selection_slots%rowtype;c private.restitch_selection_candidates%rowtype;
 m public.team_materials%rowtype;d public.team_drive_connections%rowtype;active jsonb;
begin
 if p_slot is null or p_slot not in('start','end') or p_acquisition is null or p_acquisition not between 0 and 2 then
  raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select * into r from private.restitch_selection_roots
  where root_operation_id=p_root_operation and team_id=p_team and actor_id=p_actor;
 select * into o from public.team_operations where id=p_root_operation;
 if r.root_operation_id is null or o.team_id is distinct from p_team or o.actor_id is distinct from p_actor
  or not private.can(p_team,'download',p_actor)
  or (o.kind='process' and not private.can(p_team,'process',p_actor)) then
  raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if o.kind not in('download','process') or o.state not in('pending','running')
  or o.source_material_id is distinct from r.source_material_id then
  raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into s from private.restitch_selection_slots where root_operation_id=p_root_operation and slot=p_slot;
 active:=s.budget->'candidates'->(jsonb_array_length(s.budget->'candidates')-1);
 if s.root_operation_id is null or s.snapshot_complete is null or active->>'versionId' is distinct from p_version::text
  or (active->>'acquisition')::integer is distinct from p_acquisition or active->>'rejected' is distinct from 'false' then
  raise exception 'RESTITCH_SOURCES_INVALID' using errcode='55000';end if;
 select * into c from private.restitch_selection_candidates where root_operation_id=p_root_operation and slot=p_slot and version_id=p_version;
 select * into m from public.team_materials where id=c.material_id and team_id=p_team;
 select * into d from public.team_drive_connections where id=c.connection_id and team_id=p_team;
 if c.version_id is null or m.id is null or m.lifecycle<>'active' or m.kind<>'file' or m.category is distinct from 'image'
  or m.connection_id is distinct from c.connection_id or m.drive_file_id is distinct from c.drive_file_id
  or m.checksum is distinct from c.checksum or m.size_bytes is distinct from c.size_bytes
  or m.mime_type is distinct from c.mime_type or m.parent_folder_id is distinct from c.parent_folder_id
  or d.id is null or d.state<>'connected' or d.root_folder_id is distinct from c.root_folder_id then
  raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 return jsonb_build_object('rootOperationId',p_root_operation,'teamId',p_team,'actorId',p_actor,
  'slot',p_slot,'versionId',p_version,'acquisition',p_acquisition,
  'credentialId',d.credential_id,'source',jsonb_build_object('fileId',c.drive_file_id,
   'resourceKey',c.resource_key,'parentFolderId',c.parent_folder_id,'rootFolderId',c.root_folder_id,
   'sizeBytes',c.size_bytes,'mimeType',c.mime_type,'checksum',c.checksum));
end $fn$;
revoke all on function public.service_read_restitch_selection_source(uuid,uuid,uuid,text,uuid,integer)
 from public,anon,authenticated,service_role;
grant execute on function public.service_read_restitch_selection_source(uuid,uuid,uuid,text,uuid,integer) to service_role;
commit;
