begin;
-- Accepted upload intent + successful service-owned upload receipt establish provenance.
-- A folder name, browser assertion or old attachment is never proof of ownership.
create table private.task_upload_intents (
 team_id uuid not null references public.teams(id) on delete cascade,
 actor_id uuid not null references auth.users(id) on delete cascade,
 task_id uuid not null references public.team_tasks(id) on delete cascade,
 request_key text not null, created_at timestamptz not null default now(),
 primary key(team_id,actor_id,request_key)
);
create table private.task_owned_uploads (
 material_id uuid primary key references public.team_materials(id) on delete cascade,
 team_id uuid not null references public.teams(id) on delete cascade,
 task_id uuid not null references public.team_tasks(id) on delete cascade,
 actor_id uuid not null, upload_operation_id uuid not null references public.team_operations(id),
 parent_folder_id text not null, drive_file_id text not null
);
create table private.task_attachment_cleanup (
 id uuid primary key default gen_random_uuid(), team_id uuid not null references public.teams(id) on delete cascade,
 task_id uuid not null references public.team_tasks(id) on delete cascade,
 material_id uuid not null references public.team_materials(id) on delete cascade,
 actor_id uuid not null, detached_at timestamptz not null default clock_timestamp(),
 not_before timestamptz not null default clock_timestamp()+interval '30 seconds',
 state text not null default 'waiting' check(state in ('waiting','claimed','retained','trashed','cancelled')),
 reason text, operation_id uuid references public.team_operations(id), lease_until timestamptz,
 attempts integer not null default 0, updated_at timestamptz not null default clock_timestamp()
);
create index task_cleanup_due on private.task_attachment_cleanup(not_before) where state in ('waiting','claimed');
create unique index task_cleanup_one_active on private.task_attachment_cleanup(material_id) where state in ('waiting','claimed');
alter table private.task_upload_intents enable row level security;
alter table private.task_upload_intents force row level security;
alter table private.task_owned_uploads enable row level security;
alter table private.task_owned_uploads force row level security;
alter table private.task_attachment_cleanup enable row level security;
alter table private.task_attachment_cleanup force row level security;
revoke all on private.task_upload_intents,private.task_owned_uploads,private.task_attachment_cleanup from public,anon,authenticated;
create function public.begin_task_upload(p_team uuid,p_task uuid,p_request text) returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.can(p_team,'edit',auth.uid()) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 if p_request is null or length(p_request) not between 8 and 128 or not exists(select 1 from public.team_tasks where id=p_task and team_id=p_team) then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 insert into private.task_upload_intents(team_id,actor_id,task_id,request_key) values(p_team,auth.uid(),p_task,p_request)
 on conflict(team_id,actor_id,request_key) do nothing;
 if not exists(select 1 from private.task_upload_intents where team_id=p_team and actor_id=auth.uid() and request_key=p_request and task_id=p_task) then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
end $$;
create function private.capture_task_upload() returns trigger language plpgsql set search_path='' as $$
begin
 if new.kind='upload' and new.state='succeeded' and new.source_material_id is null then
 insert into private.task_owned_uploads(material_id,team_id,task_id,actor_id,upload_operation_id,parent_folder_id,drive_file_id)
 select m.id,new.team_id,i.task_id,new.actor_id,new.id,m.parent_folder_id,m.drive_file_id
 from private.task_upload_intents i join public.team_materials m on m.id=new.result_material_id and m.team_id=new.team_id
 where i.team_id=new.team_id and i.actor_id=new.actor_id and i.request_key=new.idempotency_key
 and not exists(select 1 from private.team_operation_intents oi where oi.operation_id=new.id and (oi.replace_material_id is not null or oi.version_of_material_id is not null or oi.expected_source_drive_file_id is not null or oi.relation is not null))
 and i.created_at<=new.created_at and m.created_at>=new.created_at and m.kind='file' and m.parent_folder_id is not null
 on conflict(material_id) do nothing;
 end if;
 return new;
end $$;
create trigger capture_task_upload after insert or update of state on public.team_operations for each row execute function private.capture_task_upload();
create function private.task_cleanup_receipt(p_id uuid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',id,'materialId',material_id,'undoUntil',not_before,'state',state,'reason',reason)
 from private.task_attachment_cleanup where id=p_id
$$;
create function public.detach_task_material_safely(p_team uuid,p_task uuid,p_material uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare receipt uuid;
begin
 if auth.uid() is null or not private.can(p_team,'edit',auth.uid()) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 perform 1 from public.team_tasks where id=p_task and team_id=p_team for update;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
 perform 1 from public.team_materials where id=p_material and team_id=p_team for update;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
 if not exists(select 1 from public.team_task_attachments where task_id=p_task and team_id=p_team and material_id=p_material) then
  select id into receipt from private.task_attachment_cleanup where team_id=p_team and task_id=p_task and material_id=p_material and state<>'cancelled' order by detached_at desc limit 1;
  if receipt is not null then return private.task_cleanup_receipt(receipt); end if;
  raise exception 'NOT_FOUND' using errcode='P0002';
 end if;
 if exists(select 1 from private.task_attachment_cleanup where material_id=p_material and state='claimed') then raise exception 'WRONG_STATE' using errcode='55000'; end if;
 update private.task_attachment_cleanup set state='cancelled',updated_at=clock_timestamp() where material_id=p_material and state='waiting';
 delete from public.team_task_attachments where task_id=p_task and team_id=p_team and material_id=p_material;
 insert into private.task_attachment_cleanup(team_id,task_id,material_id,actor_id,state,reason)
 values(p_team,p_task,p_material,auth.uid(),
 case when exists(select 1 from private.task_owned_uploads where material_id=p_material and team_id=p_team) then 'waiting' else 'retained' end,
 case when exists(select 1 from private.task_owned_uploads where material_id=p_material and team_id=p_team) then null else 'cleanup_unverified' end) returning id into receipt;
 return private.task_cleanup_receipt(receipt);
end $$;
create function public.undo_task_material_detach(p_team uuid,p_receipt uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.task_attachment_cleanup%rowtype; attached jsonb;
begin
 if auth.uid() is null or not private.can(p_team,'edit',auth.uid()) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 select * into r from private.task_attachment_cleanup where id=p_receipt and team_id=p_team;
 if r.id is null then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
 -- Same task → material ordering as attachment writes.
 perform 1 from public.team_tasks where id=r.task_id for update;
 perform 1 from public.team_materials where id=r.material_id for update;
 select * into r from private.task_attachment_cleanup where id=p_receipt for update;
 if r.state='cancelled' and exists(select 1 from public.team_task_attachments where team_id=p_team and task_id=r.task_id and material_id=r.material_id) then return private.task_cleanup_receipt(r.id); end if;
 if r.state not in ('waiting','retained','cancelled') or clock_timestamp()>=r.not_before then raise exception 'WRONG_STATE' using errcode='55000'; end if;
 update private.task_attachment_cleanup set state='cancelled',reason=null,updated_at=clock_timestamp() where id=r.id;
 attached:=public.attach_team_task_materials(p_team,r.task_id,array[r.material_id]);
 if jsonb_array_length(attached->'rejected')>0 then raise exception 'WRONG_STATE' using errcode='55000'; end if;
 return private.task_cleanup_receipt(r.id);
end $$;
create function public.list_task_attachment_cleanup(p_team uuid,p_task uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.can(p_team,'view',auth.uid()) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(private.task_cleanup_receipt(id) order by detached_at desc) from
 (select id,detached_at from private.task_attachment_cleanup where team_id=p_team and task_id=p_task order by detached_at desc limit 50) r),'[]'::jsonb);
end $$;
-- Coverage is intentionally conservative: references in JSON, retained revisions and
-- unknown team records keep the file. No content leaves the database. Table names
-- come only from pg_catalog in two closed schemas, never from user input.
create function private.task_cleanup_reference_tables() returns table(schema_name text,table_name text)
language sql stable set search_path='' as $$
 select n.nspname::text,c.relname::text from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
 where n.nspname in ('public','private') and c.relkind='r' and (c.relname like 'team_%' or c.relname like 'launch_%' or c.relname like 'catalog_%'
 or exists(select 1 from pg_catalog.pg_constraint f where f.conrelid=c.oid and f.contype='f' and f.confrelid='public.team_materials'::regclass)
 or exists(select 1 from pg_catalog.pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped and a.atttypid in ('json'::regtype,'jsonb'::regtype)))
 and not (c.relname in ('team_recovery_enrollments','team_recovery_delegations','team_recovery_credentials','team_recovery_claim_receipts','team_recovery_rate_buckets')
   and not exists(select 1 from pg_catalog.pg_constraint f where f.conrelid=c.oid and f.contype='f' and f.confrelid='public.team_materials'::regclass)
   and not exists(select 1 from pg_catalog.pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped and a.atttypid in ('json'::regtype,'jsonb'::regtype)))
 and c.relname not in ('team_catalog_events','team_audit_events','team_bulk_trash_groups','team_bulk_trash_items','task_attachment_cleanup','task_owned_uploads')

$$;
create function private.task_cleanup_coverage_verified() returns boolean language sql stable set search_path='' as $$
 select not exists(select 1 from private.task_cleanup_reference_tables() t where not exists(
 select 1 from pg_catalog.pg_trigger tr join pg_catalog.pg_class c on c.oid=tr.tgrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace
 where n.nspname=t.schema_name and c.relname=t.table_name and tr.tgname='task_cleanup_reference_fence' and tr.tgenabled<>'D'))
$$;
create function private.task_cleanup_has_reference(p_material uuid,p_drive text) returns boolean
language plpgsql set search_path='' as $$
declare t record; used boolean;
begin
 for t in select * from private.task_cleanup_reference_tables() loop
  -- Any missing fence is a coverage gap; retain rather than guess after a schema change.
  if not exists(select 1 from pg_catalog.pg_trigger tr join pg_catalog.pg_class c on c.oid=tr.tgrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname=t.schema_name and c.relname=t.table_name and tr.tgname='task_cleanup_reference_fence' and tr.tgenabled<>'D') then return true; end if;
  if t.table_name in ('team_operations','team_transfer_grants') then continue; end if;
  execute pg_catalog.format('select exists(select 1 from %I.%I x where not ($3=''team_operation_intents'' and to_jsonb(x)->>''operation_id''=$4) and (to_jsonb(x)->>''id'' is distinct from $1::text or $3<>''team_materials'') and (position($1::text in (to_jsonb(x)-''team_id''-''actor_id'')::text)>0 or position($2 in (to_jsonb(x)-''team_id''-''actor_id'')::text)>0))',t.schema_name,t.table_name) into used using p_material,p_drive,t.table_name,(select upload_operation_id::text from private.task_owned_uploads where material_id=p_material);
  if used then return true; end if;
 end loop;
 return exists(select 1 from private.team_transfer_grants g where g.material_id=p_material and g.revoked_at is null and g.expires_at>clock_timestamp() and not exists(select 1 from private.task_owned_uploads u where u.material_id=p_material and u.upload_operation_id=g.operation_id and g.purpose='finalize')) or exists(select 1 from public.team_operations o where state in ('pending','running') and not exists(select 1 from private.task_attachment_cleanup c where c.operation_id=o.id and c.state='claimed') and (source_material_id=p_material or destination_folder_id=p_material or result_material_id=p_material));
end $$;
create function private.guard_task_cleanup_reference() returns trigger language plpgsql security definer set search_path='' as $$
declare candidate record; payload text:=(to_jsonb(new)-'team_id'-'actor_id')::text;
begin
 if tg_table_name='team_materials' then payload:=(to_jsonb(new)-'id'-'team_id'-'actor_id'-'drive_file_id')::text; end if;
 -- Lock all matches in deterministic order, including waiting candidates: a reference
 -- racing the claim either commits first and is detected, or meets the durable fence.
 for candidate in select c.id,c.material_id,c.operation_id,u.upload_operation_id,u.drive_file_id from private.task_attachment_cleanup c join private.task_owned_uploads u on u.material_id=c.material_id where c.state in ('waiting','claimed') and
 (position(c.material_id::text in payload)>0 or position(u.drive_file_id in payload)>0) order by c.material_id loop
  perform 1 from public.team_materials where id=candidate.material_id for update;
  if tg_table_name='team_operations' and candidate.operation_id::text=to_jsonb(new)->>'id'
    and to_jsonb(new)->>'source_material_id'=candidate.material_id::text
    and to_jsonb(new)->>'destination_folder_id' is null and to_jsonb(new)->>'result_material_id' is null then continue; end if;
  if tg_table_name='team_transfer_grants' then
    if (to_jsonb(new)->>'revoked_at') is not null or (to_jsonb(new)->>'expires_at')::timestamptz<=clock_timestamp()
      or (to_jsonb(new)->>'purpose'='finalize' and to_jsonb(new)->>'operation_id'=candidate.upload_operation_id::text) then continue; end if;
  end if;
  if exists(select 1 from private.task_attachment_cleanup where id=candidate.id and state='claimed') then raise exception 'WRONG_STATE' using errcode='55000'; end if;
 end loop;
 return new;
end $$;
do $$ declare t record; begin
 for t in select * from private.task_cleanup_reference_tables() loop
 execute pg_catalog.format('create trigger task_cleanup_reference_fence before insert or update on %I.%I for each row execute function private.guard_task_cleanup_reference()',t.schema_name,t.table_name);
 end loop;
end $$;
create function public.service_claim_task_cleanup(p_limit integer default 3) returns jsonb
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
  select connection.* into c from public.team_drive_connections connection join public.team_materials m on m.connection_id=connection.id where m.id=r.material_id;
  if c.state<>'connected' then continue; end if;
  update private.task_attachment_cleanup set lease_until=clock_timestamp()+interval '60 seconds',attempts=attempts+1,updated_at=clock_timestamp() where id=r.id;
  plans:=plans||jsonb_build_array(jsonb_build_object('id',r.id,'operationId',op,'fileId',u.drive_file_id,'parentId',u.parent_folder_id,'credentialId',c.credential_id,'rootId',c.root_folder_id));
 end loop;
 return plans;
end $$;
create function public.service_settle_task_cleanup(p_id uuid,p_result text) returns void
language plpgsql security definer set search_path='' as $$
declare r private.task_attachment_cleanup%rowtype;
begin
 select * into r from private.task_attachment_cleanup where id=p_id;
 perform 1 from public.team_materials where id=r.material_id for update;
 select * into r from private.task_attachment_cleanup where id=p_id for update;
 if r.state<>'claimed' then return; end if;
 if p_result='trashed' then
  update public.team_materials set lifecycle='trashed',trashed_at=clock_timestamp(),updated_at=clock_timestamp() where id=r.material_id;
  update public.team_operations set state='succeeded',stage='completed',progress=100,error_code=null,retryable=false,finished_at=clock_timestamp(),updated_at=clock_timestamp() where id=r.operation_id;
  update private.task_attachment_cleanup set state='trashed',reason=null,lease_until=null,updated_at=clock_timestamp() where id=r.id;
  insert into public.team_catalog_events(team_id,material_id,event_kind) values(r.team_id,r.material_id,'tombstoned');
 elsif p_result='retained' then
  update private.task_attachment_cleanup set state='retained',reason='cleanup_unverified',lease_until=null,updated_at=clock_timestamp() where id=r.id;
  update public.team_operations set state='failed',stage='failed',error_code='WRONG_STATE',finished_at=clock_timestamp(),updated_at=clock_timestamp() where id=r.operation_id;
 elsif p_result in ('unknown','permission_denied','unavailable') then
  update private.task_attachment_cleanup set reason='cleanup_pending',updated_at=clock_timestamp() where id=r.id;
  update public.team_operations set stage='reconciling',error_code=case when p_result='permission_denied' then 'PERMISSION_DENIED' when p_result='unavailable' then 'DRIVE_UNAVAILABLE' else null end,retryable=true,updated_at=clock_timestamp() where id=r.operation_id;
 else raise exception 'INVALID_INPUT'; end if;
end $$;
revoke all on function private.task_cleanup_coverage_verified(),private.capture_task_upload(),private.task_cleanup_receipt(uuid),private.task_cleanup_reference_tables(),private.task_cleanup_has_reference(uuid,text),private.guard_task_cleanup_reference() from public,anon,authenticated;
revoke all on function public.begin_task_upload(uuid,uuid,text),public.detach_task_material_safely(uuid,uuid,uuid),public.undo_task_material_detach(uuid,uuid),public.list_task_attachment_cleanup(uuid,uuid) from public,anon;
grant execute on function public.begin_task_upload(uuid,uuid,text),public.detach_task_material_safely(uuid,uuid,uuid),public.undo_task_material_detach(uuid,uuid),public.list_task_attachment_cleanup(uuid,uuid) to authenticated;
revoke all on function public.service_claim_task_cleanup(integer),public.service_settle_task_cleanup(uuid,text) from public,anon,authenticated;
grant execute on function public.service_claim_task_cleanup(integer),public.service_settle_task_cleanup(uuid,text) to service_role;
commit;
