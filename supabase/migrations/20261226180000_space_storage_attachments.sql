-- 057 M1 (T031): task attachments in an R2 space (tasks.md T030/T031).
--
-- Additive: two columns of private.task_owned_uploads become nullable and gain an R2 upload id,
-- two new triggers, and two existing functions redefined with an R2 branch whose Drive branch
-- is the previous body unchanged:
--
-- * The attachments folder of an R2 space is a folder material of the space ("Task
--   attachments", made by space-storage `create_folder ensure`); begin_task_upload and
--   attach_team_task_materials are backend-neutral already and stay as they are.
-- * A file a task upload brought in (begin_task_upload's key = the upload's idempotency key)
--   is captured as task-owned when its space upload commits, as capture_task_upload does for a
--   Drive upload operation; its object then counts as `attachments` (FR-047).
-- * Attaching an R2 file adds a `task_attachment` reference to its object, detaching removes
--   it; the explorer's own reference keeps the bytes, so detaching never deletes a material that
--   is still in the explorer.
-- * private.task_cleanup_has_reference (follow-up of T008): a row without drive_file_id is
--   matched by its material id only (coalesce of the Drive id test, which was null-unknown), and
--   the material's own space upload receipt is not a reference — the way team_operations is
--   skipped for a Drive upload. For a Drive material both changes are no-ops.
-- * service_claim_task_cleanup: an R2 task-owned upload whose task let it go is moved to the
--   space's trash in SQL (there is no Drive file to trash) and settled at once; the Drive branch
--   is unchanged.

alter table private.task_owned_uploads alter column upload_operation_id drop not null;
alter table private.task_owned_uploads alter column drive_file_id drop not null;
alter table private.task_owned_uploads add column space_upload_id uuid references public.space_uploads(id) on delete set null;
alter table private.task_owned_uploads add constraint task_owned_uploads_source_check
  check (upload_operation_id is not null or space_upload_id is not null) not valid;
alter table private.task_owned_uploads validate constraint task_owned_uploads_source_check;

-- 1. Task-owned R2 uploads ----------------------------------------------------------------

create function private.capture_space_task_upload() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.state <> 'committed' or new.result_material_id is null then return null; end if;
  insert into private.task_owned_uploads (material_id, team_id, task_id, actor_id, upload_operation_id,
    parent_folder_id, drive_file_id, space_upload_id)
  select m.id, new.team_id, i.task_id, new.actor_id, null, m.parent_folder_id, null, new.id
  from private.task_upload_intents i
  join public.team_materials m on m.id = new.result_material_id and m.team_id = new.team_id
  where i.team_id = new.team_id and i.actor_id = new.actor_id and i.request_key = new.idempotency_key
    and i.created_at <= new.created_at and m.created_at >= new.created_at
    and m.kind = 'file' and m.parent_folder_id is not null and m.connection_id is null
  on conflict (material_id) do nothing;
  if found then
    perform private.space_material_ref_sync(new.result_material_id);
  end if;
  return null;
end;
$$;
create trigger space_uploads_capture_task_upload after insert or update of state on public.space_uploads
  for each row when (new.state = 'committed') execute function private.capture_space_task_upload();

-- 2. Attachment references ----------------------------------------------------------------

create function private.space_task_attachment_refs() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_object uuid;
begin
  if tg_op = 'DELETE' then
    delete from public.space_object_refs where owner_kind = 'task_attachment' and owner_id = old.id;
    return null;
  end if;
  select m.space_object_id into v_object from public.team_materials m
   where m.id = new.material_id and m.connection_id is null and m.space_object_id is not null;
  if v_object is null then return null; end if;
  insert into public.space_object_refs (object_id, owner_kind, owner_id, team_id, category, counted)
  values (v_object, 'task_attachment', new.id, new.team_id, 'attachments', true)
  on conflict (object_id, owner_kind, owner_id) do nothing;
  return null;
end;
$$;
create trigger space_task_attachment_refs after insert or delete on public.team_task_attachments
  for each row execute function private.space_task_attachment_refs();

-- 3. Cleanup with rows that have no Drive id ----------------------------------------------

create or replace function private.task_cleanup_has_reference(p_material uuid,p_drive text) returns boolean
language plpgsql set search_path='' as $$
declare t record; used boolean;
begin
 for t in select * from private.task_cleanup_reference_tables() loop
  -- Any missing fence is a coverage gap; retain rather than guess after a schema change.
  if not exists(select 1 from pg_catalog.pg_trigger tr join pg_catalog.pg_class c on c.oid=tr.tgrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname=t.schema_name and c.relname=t.table_name and tr.tgname='task_cleanup_reference_fence' and tr.tgenabled<>'D') then return true; end if;
  if t.table_name in ('team_operations','team_transfer_grants') then continue; end if;
  execute pg_catalog.format('select exists(select 1 from %I.%I x where not ($3=''team_operation_intents'' and to_jsonb(x)->>''operation_id''=$4) and (to_jsonb(x)->>''id'' is distinct from $1::text or $3<>''team_materials'') and not ($3=''space_uploads'' and to_jsonb(x)->>''result_material_id''=$1::text and to_jsonb(x)->>''parent_material_id'' is distinct from $1::text) and (position($1::text in (to_jsonb(x)-''team_id''-''actor_id'')::text)>0 or coalesce(position($2 in (to_jsonb(x)-''team_id''-''actor_id'')::text)>0,false)))',t.schema_name,t.table_name) into used using p_material,p_drive,t.table_name,(select upload_operation_id::text from private.task_owned_uploads where material_id=p_material);
  if used then return true; end if;
 end loop;
 return exists(select 1 from private.team_transfer_grants g where g.material_id=p_material and g.revoked_at is null and g.expires_at>clock_timestamp() and not exists(select 1 from private.task_owned_uploads u where u.material_id=p_material and u.upload_operation_id=g.operation_id and g.purpose='finalize')) or exists(select 1 from public.team_operations o where state in ('pending','running') and not exists(select 1 from private.task_attachment_cleanup c where c.operation_id=o.id and c.state='claimed') and (source_material_id=p_material or destination_folder_id=p_material or result_material_id=p_material));
end $$;

-- 4. Claiming a cleanup of an R2 file -----------------------------------------------------

create or replace function public.service_claim_task_cleanup(p_limit integer default 3) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.task_attachment_cleanup%rowtype; u private.task_owned_uploads%rowtype; c public.team_drive_connections%rowtype; op uuid; why text; plans jsonb:='[]';
begin
 if p_limit not between 1 and 3 then raise exception 'INVALID_INPUT'; end if;
 for r in select * from private.task_attachment_cleanup where state in ('waiting','claimed') and not_before<=clock_timestamp() and (lease_until is null or lease_until<=clock_timestamp()) order by not_before limit p_limit loop
  perform 1 from public.team_materials where id=r.material_id for update;
  select * into r from private.task_attachment_cleanup where id=r.id and state in ('waiting','claimed') and (lease_until is null or lease_until<=clock_timestamp()) for update skip locked;
  if not found then continue; end if;
  select * into u from private.task_owned_uploads where material_id=r.material_id;
  if r.state='waiting' then
   why:=case when u.material_id is null then 'cleanup_unverified' when not private.can(r.team_id,'delete',r.actor_id) then 'cleanup_forbidden' when not private.task_cleanup_coverage_verified() then 'cleanup_unverified' when private.task_cleanup_has_reference(r.material_id,u.drive_file_id) then 'cleanup_referenced' else null end;
   if why is not null then
    update private.task_attachment_cleanup set state='retained',reason=why,updated_at=clock_timestamp() where id=r.id; continue;
   end if;
   insert into public.team_operations(team_id,actor_id,kind,state,stage,source_material_id,idempotency_key,request_nonce)
   values(r.team_id,r.actor_id,'trash','running','queued',r.material_id,'task-cleanup:'||r.id::text,'task-cleanup:'||r.id::text) returning id into op;
   update private.task_attachment_cleanup set state='claimed',operation_id=op where id=r.id;
  else op:=r.operation_id; end if;
  -- 057 T031: an R2 file has no Drive copy to trash; it goes to the space's trash right here.
  if exists(select 1 from public.team_materials m where m.id=r.material_id and m.connection_id is null) then
   update public.team_materials set lifecycle='trashed',trashed_at=clock_timestamp() where id=r.material_id and lifecycle='active';
   update public.team_operations set state='succeeded',stage='completed',progress=100,error_code=null,retryable=false,finished_at=clock_timestamp(),updated_at=clock_timestamp() where id=op;
   update private.task_attachment_cleanup set state='trashed',reason=null,lease_until=null,updated_at=clock_timestamp() where id=r.id;
   perform private.space_content_changed(r.team_id,null,true);
   continue;
  end if;
  select connection.* into c from public.team_drive_connections connection join public.team_materials m on m.connection_id=connection.id where m.id=r.material_id;
  if c.state<>'connected' then continue; end if;
  update private.task_attachment_cleanup set lease_until=clock_timestamp()+interval '60 seconds',attempts=attempts+1,updated_at=clock_timestamp() where id=r.id;
  plans:=plans||jsonb_build_array(jsonb_build_object('id',r.id,'operationId',op,'fileId',u.drive_file_id,'parentId',u.parent_folder_id,'credentialId',c.credential_id,'rootId',c.root_folder_id));
 end loop;
 return plans;
end $$;

revoke all on function private.capture_space_task_upload(), private.space_task_attachment_refs()
  from public, anon, authenticated;
revoke all on function private.task_cleanup_has_reference(uuid,text) from public, anon, authenticated;
