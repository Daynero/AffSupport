-- Versioned Edge execution scope. Never renew an issued provider PATCH by time.
-- A no-dispatch handoff fences every old write RPC before a new owner can act.
begin;
alter table private.team_material_group_intents
 add column execution_claim_protocol smallint not null default 1 check(execution_claim_protocol in(1,2)),
 add column execution_epoch bigint not null default 0 check(execution_epoch between 0 and 9007199254740991),
 add constraint material_group_claim_epoch_shape check((
  (execution_claim_protocol=1 and execution_epoch=0)
  or (execution_claim_protocol=2 and execution_protocol=1 and execution_epoch>0 and execution_owner is not null)) is true);
create function private.guard_material_group_claim_epoch() returns trigger
language plpgsql security definer set search_path='' as $fn$
begin
 if old.execution_claim_protocol=2 and (new.execution_claim_protocol<>2
  or new.execution_epoch<old.execution_epoch or new.execution_epoch>old.execution_epoch+1
  or (new.execution_epoch=old.execution_epoch and new.execution_owner is distinct from old.execution_owner)) then
  raise exception 'GROUP_RECONCILING' using errcode='55000';end if;
 if new.execution_claim_protocol=2 and (old.execution_claim_protocol=1 or new.execution_epoch<>old.execution_epoch) then
  if new.execution_epoch<>old.execution_epoch+1 or old.dispatch_member is not null
   or new.dispatch_member is not null or new.execution_owner is null or new.execution_closed is distinct from false then
   raise exception 'GROUP_RECONCILING' using errcode='55000';end if;
 end if;
 return new;
end $fn$;
create trigger material_group_claim_epoch before update on private.team_material_group_intents
 for each row execute function private.guard_material_group_claim_epoch();

create function private.lock_material_group_claim(p_intent uuid)
returns private.team_material_group_intents language plpgsql security definer set search_path='' as $fn$
declare g private.team_material_group_intents%rowtype;o public.team_operations%rowtype;
begin
 select * into g from private.team_material_group_intents where id=p_intent for update;
 if g.id is null then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 select * into o from public.team_operations where id=g.operation_id for update;
 if o.id is null or o.team_id is distinct from g.team_id or o.source_material_id is distinct from g.source_material_id
  or o.kind is distinct from g.action or not private.can(g.team_id,case when g.action='move' then 'edit' else 'delete' end,o.actor_id) then
  raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if g.execution_protocol is distinct from 1 or o.request_nonce!~'^group-v1:[0-9a-f]{64}$'
  or not ((o.state in('pending','running') and g.state in('pending','running','reconciling'))
   or(o.state='succeeded' and g.state='succeeded')) then
  raise exception 'GROUP_RECONCILING' using errcode='55000';end if;
 return g;
end $fn$;
create function private.material_group_claim_receipt(g private.team_material_group_intents,p_acquired boolean,p_executor uuid)
returns jsonb language sql immutable set search_path='' as $fn$
 select jsonb_build_object('intentId',(g).id,'teamId',(g).team_id,'operationId',(g).operation_id,
  'sourceMaterialId',(g).source_material_id,'epoch',(g).execution_epoch,
  'claimProtocol',(g).execution_claim_protocol,'executorId',p_executor,'acquired',p_acquired,
  'hasPendingDispatch',(g).dispatch_member is not null,
  'completed',(g).dispatch_member is null and cardinality((g).applied_member_ids)=jsonb_array_length((g).member_snapshot),
  'appliedMemberIds',to_jsonb((g).applied_member_ids));
$fn$;
create function public.service_read_material_group_execution(p_intent uuid,p_executor uuid default null,p_epoch bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare g private.team_material_group_intents%rowtype;owned boolean;
begin
 g:=private.lock_material_group_claim(p_intent);
 owned:=p_executor is not null and p_epoch is not null and g.execution_claim_protocol=2
  and g.execution_owner=p_executor and g.execution_epoch=p_epoch and g.execution_closed is false and g.dispatch_member is null;
 return private.material_group_claim_receipt(g,owned,case when owned then p_executor else null end);
end $fn$;
create function public.service_claim_material_group_execution_v2(p_intent uuid,p_executor uuid,p_expected_epoch bigint)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare g private.team_material_group_intents%rowtype;
begin
 if p_executor is null or p_expected_epoch is null or p_expected_epoch not between 0 and 9007199254740990 then
  raise exception 'INVALID_INPUT' using errcode='22023';end if;
 g:=private.lock_material_group_claim(p_intent);
 if g.execution_epoch<>p_expected_epoch or g.dispatch_member is not null
  or cardinality(g.applied_member_ids)=jsonb_array_length(g.member_snapshot) or g.state='succeeded' then
  return private.material_group_claim_receipt(g,false,null);end if;
 -- No provider permit is outstanding. This transaction changes the epoch and
 -- disables old-protocol RPCs. Metadata callbacks may finish, but neither they
 -- nor delayed old begin/close/checkpoint calls can write in the new scope.
 -- This is an admission fence, not an assertion of native/process quiescence.
 update private.team_material_group_intents set execution_claim_protocol=2,
  execution_epoch=execution_epoch+1,execution_owner=p_executor,execution_closed=false where id=g.id returning * into g;
 return private.material_group_claim_receipt(g,true,p_executor);
end $fn$;

-- Old clients may finish their original scope, but may never reactivate a
-- historical UUID. A modern handoff uses the versioned epoch CAS instead.
alter function public.service_claim_material_group_execution(uuid,uuid) set schema private;
alter function private.service_claim_material_group_execution(uuid,uuid) rename to claim_material_group_execution_legacy_core;
revoke all on function private.claim_material_group_execution_legacy_core(uuid,uuid) from public,anon,authenticated,service_role;
create function public.service_claim_material_group_execution(p_intent uuid,p_executor uuid)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare g private.team_material_group_intents%rowtype;
begin
 select * into g from private.team_material_group_intents where id=p_intent for update;
 if g.id is null then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 if g.execution_claim_protocol=2 or g.execution_owner is not null then
  return private.material_group_claim_receipt(g,false,null);end if;
 return private.claim_material_group_execution_legacy_core(p_intent,p_executor);
end $fn$;
create function private.material_group_epoch_matches(p_intent uuid,p_executor uuid,p_epoch bigint)
returns boolean language plpgsql security definer set search_path='' as $fn$
declare g private.team_material_group_intents%rowtype;
begin
 select * into g from private.team_material_group_intents where id=p_intent for update;
 return coalesce(g.execution_claim_protocol=2 and g.execution_owner=p_executor and g.execution_epoch=p_epoch,false);
end $fn$;

alter function public.service_begin_material_group_dispatch(uuid,uuid,uuid) set schema private;
alter function private.service_begin_material_group_dispatch(uuid,uuid,uuid) rename to begin_material_group_dispatch_epoch_core;
revoke all on function private.begin_material_group_dispatch_epoch_core(uuid,uuid,uuid) from public,anon,authenticated,service_role;
create function public.service_begin_material_group_dispatch(p_intent uuid,p_executor uuid,p_material uuid)
returns boolean language plpgsql security definer set search_path='' as $fn$
begin
 perform 1 from private.team_material_group_intents where id=p_intent and execution_claim_protocol=1 for update;
 if not found then return false;end if;
 return private.begin_material_group_dispatch_epoch_core(p_intent,p_executor,p_material);
end $fn$;
create function public.service_begin_material_group_dispatch_v2(p_intent uuid,p_executor uuid,p_epoch bigint,p_material uuid)
returns boolean language plpgsql security definer set search_path='' as $fn$
begin
 if not private.material_group_epoch_matches(p_intent,p_executor,p_epoch) then return false;end if;
 -- Same group -> operation order as ownership CAS and completion. A cancellation
 -- that commits while admission waits must be seen before issuing provider I/O.
 perform 1 from public.team_operations where id=(select operation_id from private.team_material_group_intents where id=p_intent)
  and state in('pending','running') for update;
 if not found then return false;end if;
 return private.begin_material_group_dispatch_epoch_core(p_intent,p_executor,p_material);
end $fn$;
revoke all on function public.service_begin_material_group_dispatch(uuid,uuid,uuid),public.service_begin_material_group_dispatch_v2(uuid,uuid,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function public.service_begin_material_group_dispatch(uuid,uuid,uuid),public.service_begin_material_group_dispatch_v2(uuid,uuid,bigint,uuid) to service_role;

alter function public.service_checkpoint_material_group_execution(uuid,uuid,uuid) set schema private;
alter function private.service_checkpoint_material_group_execution(uuid,uuid,uuid) rename to checkpoint_material_group_execution_epoch_core;
revoke all on function private.checkpoint_material_group_execution_epoch_core(uuid,uuid,uuid) from public,anon,authenticated,service_role;
create function public.service_checkpoint_material_group_execution(p_intent uuid,p_executor uuid,p_material uuid)
returns boolean language plpgsql security definer set search_path='' as $fn$
begin
 perform 1 from private.team_material_group_intents where id=p_intent and execution_claim_protocol=1 for update;
 if not found then return false;end if;
 return private.checkpoint_material_group_execution_epoch_core(p_intent,p_executor,p_material);
end $fn$;
create function public.service_checkpoint_material_group_execution_v2(p_intent uuid,p_executor uuid,p_epoch bigint,p_material uuid)
returns boolean language plpgsql security definer set search_path='' as $fn$
begin
 if not private.material_group_epoch_matches(p_intent,p_executor,p_epoch) then return false;end if;
 return private.checkpoint_material_group_execution_epoch_core(p_intent,p_executor,p_material);
end $fn$;
revoke all on function public.service_checkpoint_material_group_execution(uuid,uuid,uuid),public.service_checkpoint_material_group_execution_v2(uuid,uuid,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function public.service_checkpoint_material_group_execution(uuid,uuid,uuid),public.service_checkpoint_material_group_execution_v2(uuid,uuid,bigint,uuid) to service_role;

alter function public.service_mark_material_group_execution_reconciling(uuid,uuid,text) set schema private;
alter function private.service_mark_material_group_execution_reconciling(uuid,uuid,text) rename to mark_material_group_execution_reconciling_epoch_core;
revoke all on function private.mark_material_group_execution_reconciling_epoch_core(uuid,uuid,text) from public,anon,authenticated,service_role;
create function public.service_mark_material_group_execution_reconciling(p_intent uuid,p_executor uuid,p_error_code text)
returns boolean language plpgsql security definer set search_path='' as $fn$
begin
 perform 1 from private.team_material_group_intents where id=p_intent and execution_claim_protocol=1 for update;
 if not found then return false;end if;
 return private.mark_material_group_execution_reconciling_epoch_core(p_intent,p_executor,p_error_code);
end $fn$;
create function public.service_mark_material_group_execution_reconciling_v2(p_intent uuid,p_executor uuid,p_epoch bigint,p_error_code text)
returns boolean language plpgsql security definer set search_path='' as $fn$
begin
 if not private.material_group_epoch_matches(p_intent,p_executor,p_epoch) then return false;end if;
 return private.mark_material_group_execution_reconciling_epoch_core(p_intent,p_executor,p_error_code);
end $fn$;
revoke all on function public.service_mark_material_group_execution_reconciling(uuid,uuid,text),public.service_mark_material_group_execution_reconciling_v2(uuid,uuid,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.service_mark_material_group_execution_reconciling(uuid,uuid,text),public.service_mark_material_group_execution_reconciling_v2(uuid,uuid,bigint,text) to service_role;

alter function public.service_end_material_group_execution(uuid,uuid,uuid,uuid) set schema private;
alter function private.service_end_material_group_execution(uuid,uuid,uuid,uuid) rename to end_material_group_execution_epoch_core;
revoke all on function private.end_material_group_execution_epoch_core(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
create function public.service_end_material_group_execution(p_intent uuid,p_executor uuid,p_not_dispatched uuid default null,p_acknowledged uuid default null)
returns boolean language plpgsql security definer set search_path='' as $fn$
begin
 perform 1 from private.team_material_group_intents where id=p_intent and execution_claim_protocol=1 for update;
 if not found then return false;end if;
 return private.end_material_group_execution_epoch_core(p_intent,p_executor,p_not_dispatched,p_acknowledged);
end $fn$;
create function public.service_end_material_group_execution_v2(p_intent uuid,p_executor uuid,p_epoch bigint,p_not_dispatched uuid default null,p_acknowledged uuid default null)
returns boolean language plpgsql security definer set search_path='' as $fn$
begin
 if not private.material_group_epoch_matches(p_intent,p_executor,p_epoch) then return false;end if;
 return private.end_material_group_execution_epoch_core(p_intent,p_executor,p_not_dispatched,p_acknowledged);
end $fn$;
revoke all on function public.service_end_material_group_execution(uuid,uuid,uuid,uuid),public.service_end_material_group_execution_v2(uuid,uuid,bigint,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.service_end_material_group_execution(uuid,uuid,uuid,uuid),public.service_end_material_group_execution_v2(uuid,uuid,bigint,uuid,uuid) to service_role;

revoke all on function private.guard_material_group_claim_epoch(),private.lock_material_group_claim(uuid),
 private.material_group_claim_receipt(private.team_material_group_intents,boolean,uuid),private.material_group_epoch_matches(uuid,uuid,bigint)
 from public,anon,authenticated,service_role;
revoke all on function public.service_read_material_group_execution(uuid,uuid,bigint),
 public.service_claim_material_group_execution_v2(uuid,uuid,bigint),public.service_claim_material_group_execution(uuid,uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.service_read_material_group_execution(uuid,uuid,bigint),
 public.service_claim_material_group_execution_v2(uuid,uuid,bigint),public.service_claim_material_group_execution(uuid,uuid)
 to service_role;
create or replace view public.analytics_material_group_execution with(security_barrier=true) as
select g.id,g.operation_id,g.team_id,o.actor_id,g.action,
 case
  when g.state='succeeded' then 'registered'
  when g.execution_protocol is null then 'legacy_unknown'
  when g.dispatch_member is not null then 'dispatch_unconfirmed'
  when cardinality(g.applied_member_ids)=jsonb_array_length(g.member_snapshot) then 'provider_confirmed'
  when g.execution_owner is null then 'accepted'
  when g.execution_closed is true then 'retryable_no_pending'
  else 'executor_reserved'
 end as state,
 case when coalesce(g.error_code,o.error_code) is null then null
      when exists(select 1 from public.team_error_codes c where c.code=coalesce(g.error_code,o.error_code))
      then coalesce(g.error_code,o.error_code) else 'UNKNOWN' end as code,
 jsonb_array_length(g.member_snapshot)::integer as member_count,
 cardinality(g.applied_member_ids)::integer as confirmed_count,
 (g.dispatch_member is not null) as has_unconfirmed_dispatch,
 g.created_at,greatest(g.updated_at,o.updated_at) as updated_at,
 case when g.execution_protocol=1 then g.execution_claim_protocol else null end as claim_protocol,
 case when g.execution_claim_protocol=2 then g.execution_epoch else null end as execution_epoch
from private.team_material_group_intents g
join public.team_operations o on o.id=g.operation_id and o.team_id=g.team_id
 and o.source_material_id=g.source_material_id and o.kind=g.action;
commit;
