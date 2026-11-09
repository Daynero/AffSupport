-- Internal ownership primitive only. No public route or installed capability.
-- A server callback may close an epoch only after its native work is stopped.
begin;
create table private.restitch_selection_executors (
 root_operation_id uuid primary key references private.restitch_selection_roots on delete cascade,
 epoch bigint not null default 0 check(epoch>=0),
 executor_id uuid,
 state text not null check(state in('unclaimed','owned','quiescent','unknown')),
 check((state='owned')=(executor_id is not null))
);
create table private.restitch_selection_executor_claims (
 root_operation_id uuid not null references private.restitch_selection_roots on delete cascade,
 claim_id uuid not null, native_instance_id uuid not null, executor_id uuid not null unique,
 epoch bigint not null check(epoch>0), quiescence_id uuid,
 primary key(root_operation_id,claim_id), unique(root_operation_id,epoch)
);
alter table private.restitch_selection_executors enable row level security;
alter table private.restitch_selection_executors force row level security;
alter table private.restitch_selection_executor_claims enable row level security;
alter table private.restitch_selection_executor_claims force row level security;
revoke all on private.restitch_selection_executors,private.restitch_selection_executor_claims from public,anon,authenticated,service_role;
-- Historical absence is not proof that nothing has dispatched.
insert into private.restitch_selection_executors(root_operation_id,state)
 select root_operation_id,'unknown' from private.restitch_selection_roots where recipe ? 'selectionProtocol';
create function private.initialize_restitch_executor() returns trigger
language plpgsql security definer set search_path='' as $fn$
begin
 if new.recipe ? 'selectionProtocol' then
  insert into private.restitch_selection_executors(root_operation_id,state) values(new.root_operation_id,'unclaimed');
 end if;
 return new;
end $fn$;
create trigger restitch_executor_initialize after insert on private.restitch_selection_roots
 for each row execute function private.initialize_restitch_executor();

create function private.require_restitch_executor(p_root uuid,p_team uuid,p_actor uuid,p_executor uuid,p_epoch bigint,p_claim boolean default false)
returns void language plpgsql security definer set search_path='' as $fn$
declare r private.restitch_selection_roots%rowtype;o public.team_operations%rowtype;
 m public.team_materials%rowtype;e private.restitch_selection_executors%rowtype;
begin
 -- All ownership changes and all range admission share this lock order.
 select * into o from public.team_operations where id=p_root for update;
 select * into r from private.restitch_selection_roots where root_operation_id=p_root and team_id=p_team and actor_id=p_actor;
 if r.root_operation_id is null or o.team_id is distinct from p_team or o.actor_id is distinct from p_actor
  or not private.can(p_team,'download',p_actor) or (o.kind='process' and not private.can(p_team,'process',p_actor)) then
  raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if o.kind not in('download','process') or o.state not in('pending','running') or o.source_material_id is distinct from r.source_material_id then
  raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into m from public.team_materials where id=r.source_material_id and team_id=p_team for share;
 if m.id is null or m.lifecycle<>'active' or not private.restitch_selection_source_matches(r.recipe,r.source_version,o.kind,m) then
  raise exception 'RESTITCH_SOURCES_INVALID' using errcode='55000';end if;
 if r.recipe ? 'selectionProtocol' then
  if r.recipe->>'selectionProtocol' is distinct from '1' then raise exception 'RESTITCH_CLIENT_OUTDATED' using errcode='55000';end if;
  select * into e from private.restitch_selection_executors where root_operation_id=p_root for update;
  if e.root_operation_id is null or e.state='unknown' then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
  if not p_claim and (p_executor is null or p_epoch is null) then raise exception 'RESTITCH_CLIENT_OUTDATED' using errcode='55000';end if;
  if not p_claim and (e.state<>'owned' or e.executor_id is distinct from p_executor or e.epoch is distinct from p_epoch) then
   raise exception 'WRONG_STATE' using errcode='55000';end if;
 elsif p_claim or p_executor is not null or p_epoch is not null then
  raise exception 'WRONG_STATE' using errcode='55000';
 end if;
end $fn$;

create function public.service_claim_restitch_executor(p_root_operation uuid,p_team uuid,p_actor uuid,p_claim uuid,p_native_instance uuid,p_contract integer)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare e private.restitch_selection_executors%rowtype;c private.restitch_selection_executor_claims%rowtype;
begin
 if p_claim is null or p_native_instance is null or p_contract is distinct from 1 then
  raise exception 'RESTITCH_CLIENT_OUTDATED' using errcode='55000';end if;
 perform private.require_restitch_executor(p_root_operation,p_team,p_actor,null,null,true);
 select * into e from private.restitch_selection_executors where root_operation_id=p_root_operation for update;
 select * into c from private.restitch_selection_executor_claims where root_operation_id=p_root_operation and claim_id=p_claim;
 if c.claim_id is not null then
  if c.native_instance_id<>p_native_instance then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
 else
  if e.state not in('unclaimed','quiescent') then raise exception 'WRONG_STATE' using errcode='55000';end if;
  if exists(select 1 from private.restitch_selection_slots s,lateral jsonb_array_elements(s.budget->'transfers') t
   where s.root_operation_id=p_root_operation and t->'settlement'='null'::jsonb) then
   raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
  insert into private.restitch_selection_executor_claims(root_operation_id,claim_id,native_instance_id,executor_id,epoch)
   values(p_root_operation,p_claim,p_native_instance,gen_random_uuid(),e.epoch+1) returning * into c;
  update private.restitch_selection_executors set epoch=c.epoch,executor_id=c.executor_id,state='owned' where root_operation_id=p_root_operation returning * into e;
 end if;
 return jsonb_build_object('rootOperationId',p_root_operation,'executorId',c.executor_id,'epoch',c.epoch,
  'claimId',c.claim_id,'nativeInstanceId',c.native_instance_id,
  'active',e.state='owned' and e.executor_id=c.executor_id and e.epoch=c.epoch);
end $fn$;

-- Exact readback after lost claim acknowledgement; never initializes an epoch.
create function public.service_read_restitch_executor_claim(p_root_operation uuid,p_team uuid,p_actor uuid,p_claim uuid,p_native_instance uuid)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare e private.restitch_selection_executors%rowtype;c private.restitch_selection_executor_claims%rowtype;
begin
 if not exists(select 1 from private.restitch_selection_roots where root_operation_id=p_root_operation and team_id=p_team and actor_id=p_actor) then return null;end if;
 -- Keep the active flag consistent with a simultaneous ownership transition.
 perform 1 from public.team_operations where id=p_root_operation for share;
 select * into e from private.restitch_selection_executors where root_operation_id=p_root_operation;
 select * into c from private.restitch_selection_executor_claims where root_operation_id=p_root_operation and claim_id=p_claim;
 if c.claim_id is null then return null;end if;
 if c.native_instance_id is distinct from p_native_instance then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
 if e.root_operation_id is null or e.state='unknown' then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 return jsonb_build_object('rootOperationId',p_root_operation,'executorId',c.executor_id,'epoch',c.epoch,
  'claimId',c.claim_id,'nativeInstanceId',c.native_instance_id,
  'active',e.state='owned' and e.executor_id=c.executor_id and e.epoch=c.epoch);
end $fn$;
revoke all on function public.service_read_restitch_executor_claim(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.service_read_restitch_executor_claim(uuid,uuid,uuid,uuid,uuid) to service_role;

-- This trusted service primitive is NOT a client assertion of native quiescence.
-- The future controller must observe stopped requests/children before invoking it.
create function public.service_quiesce_restitch_executor(p_root_operation uuid,p_team uuid,p_actor uuid,p_executor uuid,p_epoch bigint,p_quiescence uuid)
returns boolean language plpgsql security definer set search_path='' as $fn$
declare r private.restitch_selection_roots%rowtype;e private.restitch_selection_executors%rowtype;
 c private.restitch_selection_executor_claims%rowtype;
begin
 if p_quiescence is null or p_executor is null or p_epoch is null then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 perform 1 from public.team_operations where id=p_root_operation for update;
 select * into r from private.restitch_selection_roots where root_operation_id=p_root_operation and team_id=p_team and actor_id=p_actor;
 if r.root_operation_id is null then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into e from private.restitch_selection_executors where root_operation_id=p_root_operation for update;
 select * into c from private.restitch_selection_executor_claims where root_operation_id=p_root_operation and executor_id=p_executor and epoch=p_epoch;
 if c.claim_id is null then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 if c.quiescence_id is not null then
  if c.quiescence_id<>p_quiescence then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
  return true; -- historical acknowledgement, never closes a later owner
 end if;
 if e.state<>'owned' or e.executor_id is distinct from p_executor or e.epoch is distinct from p_epoch then return false;end if;
 perform 1 from private.restitch_selection_slots where root_operation_id=p_root_operation order by slot for update;
 if exists(select 1 from private.restitch_selection_slots s,lateral jsonb_array_elements(s.budget->'transfers') t
  where s.root_operation_id=p_root_operation and t->'settlement'='null'::jsonb) then
  raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 update private.restitch_selection_executor_claims set quiescence_id=p_quiescence where root_operation_id=p_root_operation and claim_id=c.claim_id;
 update private.restitch_selection_executors set state='quiescent',executor_id=null where root_operation_id=p_root_operation;
 return true;
end $fn$;

alter function public.service_cas_restitch_selection_slot(uuid,uuid,uuid,text,jsonb,jsonb) set schema private;
alter function private.service_cas_restitch_selection_slot(uuid,uuid,uuid,text,jsonb,jsonb) rename to cas_restitch_selection_slot_core;
revoke all on function private.cas_restitch_selection_slot_core(uuid,uuid,uuid,text,jsonb,jsonb) from public,anon,authenticated,service_role;
create function public.service_cas_restitch_selection_slot(p_root_operation uuid,p_team uuid,p_actor uuid,p_slot text,p_expected_budget jsonb,p_next_budget jsonb)
returns boolean language plpgsql security definer set search_path='' as $fn$
begin
 perform private.require_restitch_executor(p_root_operation,p_team,p_actor,null,null);
 return private.cas_restitch_selection_slot_core(p_root_operation,p_team,p_actor,p_slot,p_expected_budget,p_next_budget);
end $fn$;
create function public.service_cas_restitch_selection_slot_owned(p_root_operation uuid,p_team uuid,p_actor uuid,p_slot text,p_expected_budget jsonb,p_next_budget jsonb,p_executor uuid,p_epoch bigint)
returns boolean language plpgsql security definer set search_path='' as $fn$
begin
 perform private.require_restitch_executor(p_root_operation,p_team,p_actor,p_executor,p_epoch);
 return private.cas_restitch_selection_slot_core(p_root_operation,p_team,p_actor,p_slot,p_expected_budget,p_next_budget);
end $fn$;
create function public.service_read_active_restitch_selection_slot(p_root_operation uuid,p_team uuid,p_actor uuid,p_slot text,p_executor uuid,p_epoch bigint)
returns jsonb language plpgsql security definer set search_path='' as $fn$
begin
 perform private.require_restitch_executor(p_root_operation,p_team,p_actor,p_executor,p_epoch);
 return public.service_read_restitch_selection_slot(p_root_operation,p_team,p_actor,p_slot)
  ||case when p_executor is not null then jsonb_build_object('executorId',p_executor,'epoch',p_epoch) else '{}'::jsonb end;
end $fn$;
alter function public.service_read_restitch_selection_source(uuid,uuid,uuid,text,uuid,integer) set schema private;
alter function private.service_read_restitch_selection_source(uuid,uuid,uuid,text,uuid,integer) rename to read_restitch_selection_source_core;
revoke all on function private.read_restitch_selection_source_core(uuid,uuid,uuid,text,uuid,integer) from public,anon,authenticated,service_role;
create function public.service_read_restitch_selection_source(p_root_operation uuid,p_team uuid,p_actor uuid,p_slot text,p_version uuid,p_acquisition integer)
returns jsonb language plpgsql security definer set search_path='' as $fn$
begin
 perform private.require_restitch_executor(p_root_operation,p_team,p_actor,null,null);
 return private.read_restitch_selection_source_core(p_root_operation,p_team,p_actor,p_slot,p_version,p_acquisition);
end $fn$;
create function public.service_read_restitch_selection_source_owned(p_root_operation uuid,p_team uuid,p_actor uuid,p_slot text,p_version uuid,p_acquisition integer,p_executor uuid,p_epoch bigint)
returns jsonb language plpgsql security definer set search_path='' as $fn$
begin
 perform private.require_restitch_executor(p_root_operation,p_team,p_actor,p_executor,p_epoch);
 return private.read_restitch_selection_source_core(p_root_operation,p_team,p_actor,p_slot,p_version,p_acquisition)
  ||jsonb_build_object('executorId',p_executor,'epoch',p_epoch);
end $fn$;
revoke all on function private.initialize_restitch_executor(),private.require_restitch_executor(uuid,uuid,uuid,uuid,bigint,boolean) from public,anon,authenticated,service_role;
revoke all on function public.service_claim_restitch_executor(uuid,uuid,uuid,uuid,uuid,integer),
 public.service_quiesce_restitch_executor(uuid,uuid,uuid,uuid,bigint,uuid),
 public.service_cas_restitch_selection_slot(uuid,uuid,uuid,text,jsonb,jsonb),
 public.service_cas_restitch_selection_slot_owned(uuid,uuid,uuid,text,jsonb,jsonb,uuid,bigint),
 public.service_read_active_restitch_selection_slot(uuid,uuid,uuid,text,uuid,bigint),
 public.service_read_restitch_selection_source(uuid,uuid,uuid,text,uuid,integer),
 public.service_read_restitch_selection_source_owned(uuid,uuid,uuid,text,uuid,integer,uuid,bigint)
 from public,anon,authenticated,service_role;
grant execute on function public.service_claim_restitch_executor(uuid,uuid,uuid,uuid,uuid,integer),
 public.service_quiesce_restitch_executor(uuid,uuid,uuid,uuid,bigint,uuid),
 public.service_cas_restitch_selection_slot(uuid,uuid,uuid,text,jsonb,jsonb),
 public.service_cas_restitch_selection_slot_owned(uuid,uuid,uuid,text,jsonb,jsonb,uuid,bigint),
 public.service_read_active_restitch_selection_slot(uuid,uuid,uuid,text,uuid,bigint),
 public.service_read_restitch_selection_source(uuid,uuid,uuid,text,uuid,integer),
 public.service_read_restitch_selection_source_owned(uuid,uuid,uuid,text,uuid,integer,uuid,bigint)
 to service_role;
commit;
