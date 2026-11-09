-- Private transfer authority only. No route/capability is exposed by this migration.
begin;
create table private.restitch_screen_range_grants (
 id uuid primary key,
 root_operation_id uuid not null, team_id uuid not null, actor_id uuid not null,
 slot text not null check(slot in('start','end')), version_id uuid not null,
 acquisition integer not null check(acquisition between 0 and 2), request_id uuid not null,
 executor_id uuid not null references private.restitch_selection_executor_claims(executor_id)
  on delete no action deferrable initially deferred,
 epoch bigint not null check(epoch between 1 and 9007199254740991),
 native_instance_id uuid not null,
 token_hash bytea not null unique check(octet_length(token_hash)=32),
 reservation jsonb not null check(jsonb_typeof(reservation)='object' and octet_length(reservation::text)<=4096),
 state text not null default 'issued' check(state in('issued','consumed','abandoned')),
 consumption_id uuid unique, refresh_request_id uuid unique,
 issued_at timestamptz not null default clock_timestamp(), expires_at timestamptz not null,
 updated_at timestamptz not null default clock_timestamp(),
 unique(root_operation_id,slot,request_id),
 foreign key(root_operation_id,team_id,actor_id) references private.restitch_selection_roots(root_operation_id,team_id,actor_id) on delete cascade,
 foreign key(root_operation_id,slot,version_id) references private.restitch_selection_candidates(root_operation_id,slot,version_id)
  on delete no action deferrable initially deferred,
 check(expires_at>issued_at and expires_at<=issued_at+interval '5 minutes'),
 check((state='consumed')=(consumption_id is not null)),
 check(refresh_request_id is null or state='abandoned')
);
alter table private.restitch_screen_range_grants enable row level security;
alter table private.restitch_screen_range_grants force row level security;
revoke all on private.restitch_screen_range_grants from public,anon,authenticated,service_role;
-- The reservation JSON is a conservative material-reference consumer.
create trigger task_cleanup_reference_fence before insert or update on private.restitch_screen_range_grants
 for each row execute function private.guard_task_cleanup_reference();
create function private.guard_restitch_screen_range_grant() returns trigger
language plpgsql security definer set search_path='' as $fn$
declare b jsonb;t jsonb;
begin
 if tg_op='INSERT' then
  perform private.require_restitch_executor(new.root_operation_id,new.team_id,new.actor_id,new.executor_id,new.epoch);
  if new.state<>'issued' or new.consumption_id is not null or new.refresh_request_id is not null
   or not exists(select 1 from private.restitch_selection_executor_claims c where c.root_operation_id=new.root_operation_id
    and c.executor_id=new.executor_id and c.epoch=new.epoch and c.native_instance_id=new.native_instance_id) then
   raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
  select budget into b from private.restitch_selection_slots where root_operation_id=new.root_operation_id and slot=new.slot for update;
  select value into t from jsonb_array_elements(b->'transfers') where value->>'requestId'=new.request_id::text;
  if t is distinct from new.reservation or t->'settlement' is distinct from 'null'::jsonb
   or t->>'candidateVersionId' is distinct from new.version_id::text
   or t->>'acquisition' is distinct from new.acquisition::text then
   raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
  perform public.service_read_restitch_selection_source_owned(new.root_operation_id,new.team_id,new.actor_id,new.slot,new.version_id,new.acquisition,new.executor_id,new.epoch);
  return new;
 end if;
 if (to_jsonb(new)-'state'-'consumption_id'-'refresh_request_id'-'updated_at') is distinct from (to_jsonb(old)-'state'-'consumption_id'-'refresh_request_id'-'updated_at')
  or (new.state is distinct from old.state and old.state<>'issued')
  or (old.state='consumed' and new.consumption_id is distinct from old.consumption_id) then
  raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
 if new.refresh_request_id is distinct from old.refresh_request_id then
  if old.refresh_request_id is not null or old.state<>'abandoned' or new.state<>'abandoned'
   or old.expires_at>clock_timestamp() or not exists(
    select 1 from private.restitch_selection_slots s,lateral jsonb_array_elements(s.budget->'refreshes') r
    where s.root_operation_id=old.root_operation_id and s.slot=old.slot
     and r->>'requestId'=new.refresh_request_id::text and r->>'candidateVersionId'=old.version_id::text) then
   raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
 end if;
 new.updated_at:=case when (new.state,new.refresh_request_id) is distinct from (old.state,old.refresh_request_id) then clock_timestamp() else old.updated_at end;
 return new;
end $fn$;
create trigger restitch_screen_range_grant_immutable before insert or update on private.restitch_screen_range_grants
 for each row execute function private.guard_restitch_screen_range_grant();
create function private.restitch_screen_range_receipt(g private.restitch_screen_range_grants)
returns jsonb language sql immutable set search_path='' as $fn$
 select jsonb_build_object('grantId',(g).id,'rootOperationId',(g).root_operation_id,
  'teamId',(g).team_id,'actorId',(g).actor_id,'slot',(g).slot,'versionId',(g).version_id,
  'acquisition',(g).acquisition,'requestId',(g).request_id,'executorId',(g).executor_id,
  'epoch',(g).epoch,'nativeInstanceId',(g).native_instance_id,'state',(g).state,
  'expiresAt',(g).expires_at,'reservation',(g).reservation,'refreshRequestId',(g).refresh_request_id);
$fn$;
create function public.service_issue_restitch_screen_range(
 p_root_operation uuid,p_team uuid,p_actor uuid,p_slot text,p_version uuid,p_acquisition integer,p_request uuid,
 p_expected_budget jsonb,p_next_budget jsonb,p_grant uuid,p_ticket_hash bytea,p_executor uuid,p_epoch bigint)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare g private.restitch_screen_range_grants%rowtype;c private.restitch_selection_executor_claims%rowtype;
 reservation jsonb;issued timestamptz;
begin
 if p_grant is null or p_request is null or p_version is null or p_ticket_hash is null or octet_length(p_ticket_hash)<>32
  or p_slot is null or p_slot not in('start','end') or p_acquisition is null or p_acquisition not between 0 and 2 then
  raise exception 'INVALID_INPUT' using errcode='22023';end if;
 perform private.require_restitch_executor(p_root_operation,p_team,p_actor,p_executor,p_epoch);
 reservation:=p_next_budget->'transfers'->-1;
 if reservation is null or reservation->>'requestId' is distinct from p_request::text
  or reservation->>'candidateVersionId' is distinct from p_version::text
  or reservation->>'acquisition' is distinct from p_acquisition::text
  or reservation->'settlement' is distinct from 'null'::jsonb then
  raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 select * into g from private.restitch_screen_range_grants
  where root_operation_id=p_root_operation and slot=p_slot and request_id=p_request for update;
 if g.id is not null then
  if g.id is distinct from p_grant or g.team_id is distinct from p_team or g.actor_id is distinct from p_actor
   or g.version_id is distinct from p_version or g.acquisition is distinct from p_acquisition
   or g.executor_id is distinct from p_executor or g.epoch is distinct from p_epoch
   or g.token_hash is distinct from p_ticket_hash or g.reservation is distinct from reservation then
   raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
  return private.restitch_screen_range_receipt(g); -- same issued row, never another reservation
 end if;
 if exists(select 1 from private.restitch_screen_range_grants prior
  where prior.root_operation_id=p_root_operation and prior.slot=p_slot and prior.version_id=p_version
   and prior.state='abandoned' and prior.expires_at<=clock_timestamp() and prior.refresh_request_id is null) then
  raise exception 'EXPIRED' using errcode='55000';end if;
 if private.restitch_selection_step_kind(p_expected_budget,p_next_budget) is distinct from 'reserve' then
  raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 perform public.service_read_restitch_selection_source_owned(p_root_operation,p_team,p_actor,p_slot,p_version,p_acquisition,p_executor,p_epoch);
 if public.service_cas_restitch_selection_slot_owned(p_root_operation,p_team,p_actor,p_slot,p_expected_budget,p_next_budget,p_executor,p_epoch) is distinct from true then
  raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 select * into c from private.restitch_selection_executor_claims where root_operation_id=p_root_operation
  and executor_id=p_executor and epoch=p_epoch;
 if c.claim_id is null then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 issued:=clock_timestamp();
 insert into private.restitch_screen_range_grants(id,root_operation_id,team_id,actor_id,slot,version_id,acquisition,
  request_id,executor_id,epoch,native_instance_id,token_hash,reservation,issued_at,expires_at)
 values(p_grant,p_root_operation,p_team,p_actor,p_slot,p_version,p_acquisition,p_request,p_executor,p_epoch,
  c.native_instance_id,p_ticket_hash,reservation,issued,issued+interval '5 minutes') returning * into g;
 return private.restitch_screen_range_receipt(g);
exception when unique_violation then
 raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';
end $fn$;
create function public.service_read_restitch_screen_range_issue(
 p_root_operation uuid,p_team uuid,p_actor uuid,p_slot text,p_request uuid,p_grant uuid,p_executor uuid,p_epoch bigint)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare g private.restitch_screen_range_grants%rowtype;
begin
 -- Bookkeeping can confirm this exact original issuance after cancellation.
 perform 1 from public.team_operations where id=p_root_operation for share;
 select * into g from private.restitch_screen_range_grants where id=p_grant and root_operation_id=p_root_operation
  and team_id=p_team and actor_id=p_actor and slot=p_slot and request_id=p_request
  and executor_id=p_executor and epoch=p_epoch;
 if g.id is null then return null;end if;
 return private.restitch_screen_range_receipt(g);
end $fn$;
create function public.service_consume_restitch_screen_range(p_ticket_hash bytea,p_dispatch uuid,p_purpose text)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare g private.restitch_screen_range_grants%rowtype;s private.restitch_selection_slots%rowtype;t jsonb;
begin
 if p_purpose is distinct from 'restitch_screen_range_v1' then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if p_dispatch is null then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select * into g from private.restitch_screen_range_grants where token_hash=p_ticket_hash;
 if g.id is null then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 -- Same operation -> executor -> row order as issuance, cancellation and abandonment.
 perform private.require_restitch_executor(g.root_operation_id,g.team_id,g.actor_id,g.executor_id,g.epoch);
 select * into g from private.restitch_screen_range_grants where token_hash=p_ticket_hash for update;
 if g.state<>'issued' then return jsonb_build_object('dispatch',false,'grant',private.restitch_screen_range_receipt(g));end if;
 if g.expires_at<=clock_timestamp() then raise exception 'EXPIRED' using errcode='55000';end if;
 select * into s from private.restitch_selection_slots where root_operation_id=g.root_operation_id and slot=g.slot for update;
 select value into t from jsonb_array_elements(s.budget->'transfers') where value->>'requestId'=g.request_id::text;
 if t is distinct from g.reservation then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 perform public.service_read_restitch_selection_source_owned(g.root_operation_id,g.team_id,g.actor_id,g.slot,g.version_id,g.acquisition,g.executor_id,g.epoch);
 update private.restitch_screen_range_grants set state='consumed',consumption_id=p_dispatch where id=g.id returning * into g;
 return jsonb_build_object('dispatch',true,'grant',private.restitch_screen_range_receipt(g));
exception when unique_violation then
 raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';
end $fn$;
create function public.service_read_restitch_screen_range_consumption(p_ticket_hash bytea,p_dispatch uuid)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare g private.restitch_screen_range_grants%rowtype;
begin
 if p_dispatch is null then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select * into g from private.restitch_screen_range_grants where token_hash=p_ticket_hash;
 if g.id is null then return null;end if;
 perform 1 from public.team_operations where id=g.root_operation_id for share;
 select * into g from private.restitch_screen_range_grants where token_hash=p_ticket_hash;
 return jsonb_build_object('consumedByInvocation',g.state='consumed' and g.consumption_id=p_dispatch,
  'grant',private.restitch_screen_range_receipt(g)); -- fact only, never dispatch=true
end $fn$;
create function public.service_abandon_restitch_screen_range(
 p_root_operation uuid,p_team uuid,p_actor uuid,p_slot text,p_request uuid,p_grant uuid,p_executor uuid,p_epoch bigint)
returns boolean language plpgsql security definer set search_path='' as $fn$
declare g private.restitch_screen_range_grants%rowtype;
begin
 -- Current access/state cannot prevent recording known-zero cost of an unconsumed permit.
 perform 1 from public.team_operations where id=p_root_operation for update;
 select * into g from private.restitch_screen_range_grants where id=p_grant and root_operation_id=p_root_operation
  and team_id=p_team and actor_id=p_actor and slot=p_slot and request_id=p_request
  and executor_id=p_executor and epoch=p_epoch for update;
 if g.id is null then return false;end if;
 if g.state='abandoned' then return true;end if;
 if g.state='consumed' then return false;end if;
 if public.service_settle_restitch_selection_range(p_root_operation,p_team,p_actor,p_slot,p_request,g.reservation,
  jsonb_build_object('bytes',0,'ioMs',0,'complete',false)) is distinct from true then return false;end if;
 update private.restitch_screen_range_grants set state='abandoned' where id=g.id;
 return true;
end $fn$;
create function public.service_refresh_restitch_screen_range(
 p_root_operation uuid,p_team uuid,p_actor uuid,p_slot text,p_request uuid,p_grant uuid,p_executor uuid,p_epoch bigint,
 p_acquisition integer,p_refresh uuid,p_expected_budget jsonb,p_next_budget jsonb)
returns boolean language plpgsql security definer set search_path='' as $fn$
declare g private.restitch_screen_range_grants%rowtype;entry jsonb;
begin
 if p_refresh is null or p_acquisition is null or p_acquisition not between 0 and 2 then
  raise exception 'INVALID_INPUT' using errcode='22023';end if;
 perform private.require_restitch_executor(p_root_operation,p_team,p_actor,p_executor,p_epoch);
 select * into g from private.restitch_screen_range_grants where id=p_grant and root_operation_id=p_root_operation
  and team_id=p_team and actor_id=p_actor and slot=p_slot and request_id=p_request for update;
 if g.id is null then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if g.refresh_request_id is not null then
  if g.refresh_request_id<>p_refresh then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
  return true; -- exact historical refresh, never another budget entry
 end if;
 if g.state<>'abandoned' or g.expires_at>clock_timestamp() then raise exception 'WRONG_STATE' using errcode='55000';end if;
 entry:=p_next_budget->'refreshes'->-1;
 if private.restitch_selection_step_kind(p_expected_budget,p_next_budget) is distinct from 'refresh'
  or entry->>'requestId' is distinct from p_refresh::text
  or entry->>'candidateVersionId' is distinct from g.version_id::text then
  raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 perform public.service_read_restitch_selection_source_owned(p_root_operation,p_team,p_actor,p_slot,g.version_id,p_acquisition,p_executor,p_epoch);
 if public.service_cas_restitch_selection_slot_owned(p_root_operation,p_team,p_actor,p_slot,p_expected_budget,p_next_budget,p_executor,p_epoch) is distinct from true then
  raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 update private.restitch_screen_range_grants set refresh_request_id=p_refresh where id=g.id;
 return true;
exception when unique_violation then
 raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';
end $fn$;
revoke all on function private.guard_restitch_screen_range_grant(),
 private.restitch_screen_range_receipt(private.restitch_screen_range_grants) from public,anon,authenticated,service_role;
revoke all on function public.service_issue_restitch_screen_range(uuid,uuid,uuid,text,uuid,integer,uuid,jsonb,jsonb,uuid,bytea,uuid,bigint),
 public.service_read_restitch_screen_range_issue(uuid,uuid,uuid,text,uuid,uuid,uuid,bigint),
 public.service_consume_restitch_screen_range(bytea,uuid,text),
 public.service_read_restitch_screen_range_consumption(bytea,uuid),
 public.service_abandon_restitch_screen_range(uuid,uuid,uuid,text,uuid,uuid,uuid,bigint),
 public.service_refresh_restitch_screen_range(uuid,uuid,uuid,text,uuid,uuid,uuid,bigint,integer,uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.service_issue_restitch_screen_range(uuid,uuid,uuid,text,uuid,integer,uuid,jsonb,jsonb,uuid,bytea,uuid,bigint),
 public.service_read_restitch_screen_range_issue(uuid,uuid,uuid,text,uuid,uuid,uuid,bigint),
 public.service_consume_restitch_screen_range(bytea,uuid,text),
 public.service_read_restitch_screen_range_consumption(bytea,uuid),
 public.service_abandon_restitch_screen_range(uuid,uuid,uuid,text,uuid,uuid,uuid,bigint),
 public.service_refresh_restitch_screen_range(uuid,uuid,uuid,text,uuid,uuid,uuid,bigint,integer,uuid,jsonb,jsonb) to service_role;
-- Counts are current authority bookkeeping, never proof of upstream I/O or delivery.
create or replace view public.analytics_restitch_selection_slots with(security_barrier=true) as
select r.root_operation_id as operation_id,r.team_id,r.actor_id,s.slot,r.pool_namespace_id,
 r.created_at,greatest(s.updated_at,g.updated_at) as updated_at,s.snapshot_complete,
 case when exists(select 1 from jsonb_array_elements(s.budget->'transfers')a where a->'settlement'='null'::jsonb) then 'range_unconfirmed'
  when s.budget->'acceptedVersionId'<>'null'::jsonb and exists(
   select 1 from jsonb_array_elements(s.budget->'candidates')a where a->>'versionId'=s.budget->>'acceptedVersionId'
    and a->'validatedAcquisition'=a->'acquisition' and a->>'rejected'='false') then 'screen_validated'
  when jsonb_array_length(s.budget->'candidates')=0 and r.recipe->'defaults'->(s.slot||'Enabled')='false'::jsonb then 'disabled'
  when jsonb_array_length(s.budget->'candidates')=0 then 'awaiting_selection'
  when s.budget->'candidates'->(jsonb_array_length(s.budget->'candidates')-1)->>'rejected'='true' then 'candidate_rejected'
  else 'candidate_selected' end as state,
 jsonb_array_length(s.budget->'candidates') as candidate_count,
 coalesce((select jsonb_agg(x.value->>'versionId' order by x.ordinality) from jsonb_array_elements(s.budget->'candidates')with ordinality x(value,ordinality)),'[]'::jsonb) as candidate_versions,
 jsonb_array_length(s.budget->'transfers') as range_count,
 (select count(*)::integer from jsonb_array_elements(s.budget->'transfers')a where a->'settlement'='null'::jsonb) as unconfirmed_range_count,
 coalesce((select sum((a->'settlement'->>'bytes')::bigint) from jsonb_array_elements(s.budget->'transfers')a where a->'settlement'<>'null'::jsonb),0)::bigint as confirmed_bytes,
 coalesce((select sum((a->'settlement'->>'ioMs')::bigint) from jsonb_array_elements(s.budget->'transfers')a where a->'settlement'<>'null'::jsonb),0)::bigint as confirmed_io_ms,
 coalesce((select sum((a->>'acquisition')::integer) from jsonb_array_elements(s.budget->'candidates')a),0)::integer+
 (select count(*)::integer from jsonb_array_elements(s.budget->'transfers')a where a->>'retry'='true') as retry_count,
 jsonb_array_length(s.budget->'refreshes') as refresh_count,
 (s.budget->>'revision')::integer as budget_revision,
 g.total as grant_count,g.issued as issued_grant_count,g.consumed as consumed_grant_count,g.abandoned as abandoned_grant_count
from private.restitch_selection_roots r join private.restitch_selection_slots s using(root_operation_id)
 cross join lateral (select count(*)::integer as total,
 count(*) filter(where state='issued')::integer as issued,
 count(*) filter(where state='consumed')::integer as consumed,
 count(*) filter(where state='abandoned')::integer as abandoned,max(updated_at) as updated_at
 from private.restitch_screen_range_grants g where g.root_operation_id=r.root_operation_id and g.slot=s.slot)g;
commit;
