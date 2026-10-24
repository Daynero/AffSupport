begin;

-- A provider request may outlive its HTTP observer or cleanup lease. Once a
-- trash attempt begins, never make its file available for a new adoption merely
-- because a lease expires or a retry is exhausted. Retain explicit uncertainty.
alter table private.process_upload_ownership add column cleanup_mutation_started_at timestamptz;

-- Tuple locks do not consume one shared advisory-lock slot per catalog file.
-- The empty identity row also serializes first capture before a ledger exists.
create table private.process_output_identity_fences (
 file_id text primary key
);
revoke all on private.process_output_identity_fences from public,anon,authenticated,service_role;
alter table private.process_output_identity_fences enable row level security;
alter table private.process_output_identity_fences force row level security;


create or replace function public.service_prepare_process_upload(
 p_operation uuid,p_actor uuid,p_connection uuid,p_file text,p_checksum text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.team_operations%rowtype;i private.team_operation_intents%rowtype;
 c public.team_drive_connections%rowtype;s public.team_materials%rowtype;
 u private.process_upload_ownership%rowtype;parent text;handoff_expiry timestamptz;
begin
 if p_file is null or p_file !~ '^[A-Za-z0-9_-]{1,200}$'
  or p_checksum is null or p_checksum !~ '^[a-f0-9]{32}$' then
  raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select * into o from public.team_operations where id=p_operation and actor_id=p_actor for update;
 if o.id is null then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 select * into i from private.team_operation_intents where operation_id=o.id and team_id=o.team_id;
 if o.kind<>'process' or o.state<>'running' or o.result_material_id is not null
  or i.operation_id is null or i.version_of_material_id is not null or i.replace_material_id is not null
  or i.expected_size is null or i.expected_size<=0 or i.expected_name is null or i.mime_type is null
  or i.provider_result_id is not null then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if not private.can(o.team_id,'process',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select max(g.expires_at) into handoff_expiry from private.team_transfer_grants g
  where g.operation_id=o.id and g.team_id=o.team_id and g.actor_id=p_actor and g.purpose='finalize'
   and g.tool_id=i.tool_id and g.revoked_at is null and g.expires_at>clock_timestamp()+interval '5 seconds';
 if handoff_expiry is null then raise exception 'EXPIRED' using errcode='55000';end if;
 select * into c from public.team_drive_connections where id=p_connection and team_id=o.team_id and state='connected';
 select * into s from public.team_materials where id=o.source_material_id and team_id=o.team_id;
 if c.id is null or s.id is null or s.connection_id<>c.id then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 if o.destination_folder_id is null then parent:=c.root_folder_id;
 else select drive_file_id into parent from public.team_materials where id=o.destination_folder_id
  and team_id=o.team_id and connection_id=c.id and kind='folder' and lifecycle='active';end if;
 if parent is null then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 insert into private.process_output_identity_fences(file_id) values(p_file) on conflict do nothing;
 perform 1 from private.process_output_identity_fences where file_id=p_file for update;
 select * into u from private.process_upload_ownership where operation_id=o.id for update;
 if found then
  if u.actor_id<>p_actor or u.connection_id<>c.id or u.credential_id<>c.credential_id
   or u.root_id<>c.root_folder_id or u.parent_id<>parent or u.checksum<>p_checksum
   or u.expected_name<>i.expected_name or u.mime_type<>i.mime_type or u.size_bytes<>i.expected_size
   or u.source_file_id<>s.drive_file_id then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
  if handoff_expiry>u.handoff_expires_at then
   update private.process_upload_ownership set handoff_expires_at=handoff_expiry,updated_at=clock_timestamp()
    where operation_id=o.id returning * into u;
  end if;
  return private.process_upload_binding(u);
 end if;
 if exists(select 1 from public.team_materials where drive_file_id=p_file)
  or p_file=s.drive_file_id then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 insert into private.process_upload_ownership(operation_id,team_id,actor_id,connection_id,credential_id,
  root_id,parent_id,file_id,source_file_id,expected_name,mime_type,size_bytes,checksum,handoff_expires_at)
 values(o.id,o.team_id,p_actor,c.id,c.credential_id,c.root_folder_id,parent,p_file,s.drive_file_id,
  i.expected_name,i.mime_type,i.expected_size,p_checksum,handoff_expiry) returning * into u;
 return private.process_upload_binding(u);
exception when unique_violation then raise exception 'SOURCE_CHANGED' using errcode='55000';
end $$;


-- Share the same provider-ID tuple lock with first ownership preparation.
-- This closes prepare-vs-insert as well as begin-trash-vs-adoption races. Do not
-- acquire the operation row here: cleanup takes operation before ownership.
create function private.fence_process_output_adoption() returns trigger
language plpgsql security definer set search_path='' as $$
declare u private.process_upload_ownership%rowtype;
begin
 if tg_op='UPDATE' and old.drive_file_id is not distinct from new.drive_file_id then return new;end if;
 insert into private.process_output_identity_fences(file_id) values(new.drive_file_id) on conflict do nothing;
 perform 1 from private.process_output_identity_fences where file_id=new.drive_file_id for update;
 select * into u from private.process_upload_ownership where file_id=new.drive_file_id for update;
 if found and u.cleanup_mutation_started_at is not null then
  raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';
 end if;
 return new;
end $$;
revoke all on function private.fence_process_output_adoption() from public,anon,authenticated,service_role;
create trigger process_output_adoption_fence before insert or update of drive_file_id on public.team_materials
 for each row execute function private.fence_process_output_adoption();

create function public.service_begin_process_output_trash(p_operation uuid,p_owner uuid,p_fence text)
returns boolean language plpgsql security definer set search_path='' as $$
declare o public.team_operations%rowtype;u private.process_upload_ownership%rowtype;target text;
begin
 select * into o from public.team_operations where id=p_operation for update;
 select file_id into target from private.process_upload_ownership where operation_id=o.id;
 if target is null then return false;end if;
 insert into private.process_output_identity_fences(file_id) values(target) on conflict do nothing;
 perform 1 from private.process_output_identity_fences where file_id=target for update;
 select * into u from private.process_upload_ownership where operation_id=o.id for update;
 if not public.service_authorize_process_output_cleanup(p_operation,p_owner,p_fence) then return false;end if;
 update private.process_upload_ownership set cleanup_mutation_started_at=coalesce(cleanup_mutation_started_at,clock_timestamp()),
  updated_at=clock_timestamp() where operation_id=o.id;
 return true;
end $$;
revoke all on function public.service_begin_process_output_trash(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.service_begin_process_output_trash(uuid,uuid,text) to service_role;

commit;
