-- Bind media leaf authority to the enrolled control in the same transaction.
-- Internal only: no public route/capability or generic-grant fallback.
begin;
create table private.restitch_control_screen_ranges (
 range_grant_id uuid primary key references private.restitch_screen_range_grants(id) on delete cascade,
 control_grant_id uuid not null references private.restitch_native_controls(id)
  on delete no action deferrable initially deferred
);
alter table private.restitch_control_screen_ranges enable row level security;
alter table private.restitch_control_screen_ranges force row level security;
revoke all on private.restitch_control_screen_ranges from public,anon,authenticated,service_role;
create function private.restitch_control_screen_scope(p_control uuid,p_hash bytea,p_active boolean)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare g private.restitch_native_controls%rowtype;c private.restitch_selection_executor_claims%rowtype;
begin
 g:=private.restitch_native_control_scope(p_control,p_hash,p_active);
 if g.claim_id is null then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into c from private.restitch_selection_executor_claims where root_operation_id=g.root_operation_id and claim_id=g.claim_id;
 if c.claim_id is null then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 if c.native_instance_id is distinct from g.native_instance_id then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
 if p_active then perform private.require_restitch_executor(g.root_operation_id,g.team_id,g.actor_id,c.executor_id,c.epoch);end if;
 return jsonb_build_object('controlGrantId',g.id,'rootOperationId',g.root_operation_id,'teamId',g.team_id,'actorId',g.actor_id,
  'executorId',c.executor_id,'epoch',c.epoch,'nativeInstanceId',c.native_instance_id);
end $fn$;
create function private.guard_restitch_control_screen_range() returns trigger
language plpgsql security definer set search_path='' as $fn$
declare g private.restitch_native_controls%rowtype;r private.restitch_screen_range_grants%rowtype;s jsonb;
begin
 if tg_op<>'INSERT' then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into g from private.restitch_native_controls where id=new.control_grant_id;
 if g.id is null then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 s:=private.restitch_control_screen_scope(g.id,g.token_hash,true);
 select * into r from private.restitch_screen_range_grants where id=new.range_grant_id;
 if r.id is null or r.state<>'issued' or
  (r.root_operation_id,r.team_id,r.actor_id,r.executor_id,r.epoch,r.native_instance_id) is distinct from
  ((s->>'rootOperationId')::uuid,(s->>'teamId')::uuid,(s->>'actorId')::uuid,(s->>'executorId')::uuid,(s->>'epoch')::bigint,(s->>'nativeInstanceId')::uuid) then
  raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
 return new;
end $fn$;
create trigger restitch_control_screen_range_immutable before insert or update on private.restitch_control_screen_ranges
 for each row execute function private.guard_restitch_control_screen_range();
create function private.restitch_control_screen_ticket(p_hash bytea,p_active boolean)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare r private.restitch_screen_range_grants%rowtype;g private.restitch_native_controls%rowtype;s jsonb;
begin
 select c.* into g from private.restitch_screen_range_grants x
  join private.restitch_control_screen_ranges b on b.range_grant_id=x.id
  join private.restitch_native_controls c on c.id=b.control_grant_id where x.token_hash=p_hash;
 if g.id is null then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 s:=private.restitch_control_screen_scope(g.id,g.token_hash,p_active);
 -- The owner helper has acquired the shared parent-first authority lock.
 select x.* into r from private.restitch_screen_range_grants x
  join private.restitch_control_screen_ranges b on b.range_grant_id=x.id and b.control_grant_id=g.id where x.token_hash=p_hash;
 if r.id is null or
  (r.root_operation_id,r.team_id,r.actor_id,r.executor_id,r.epoch,r.native_instance_id) is distinct from
  ((s->>'rootOperationId')::uuid,(s->>'teamId')::uuid,(s->>'actorId')::uuid,(s->>'executorId')::uuid,(s->>'epoch')::bigint,(s->>'nativeInstanceId')::uuid) then
  raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 return s||jsonb_build_object('rangeGrantId',r.id,'slot',r.slot,'requestId',r.request_id);
end $fn$;
create function public.service_issue_restitch_control_screen_range(p_control uuid,p_control_hash bytea,
 p_slot text,p_version uuid,p_acquisition integer,p_request uuid,p_expected_budget jsonb,p_next_budget jsonb,p_grant uuid,p_ticket_hash bytea)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare s jsonb;r jsonb;b uuid;
begin
 s:=private.restitch_control_screen_scope(p_control,p_control_hash,true);
 -- Never adopt an older unbound/internal grant, including a matching same-boot owner.
 if exists(select 1 from private.restitch_screen_range_grants where id=p_grant) and not exists(
  select 1 from private.restitch_control_screen_ranges where range_grant_id=p_grant and control_grant_id=p_control) then
  raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
 r:=public.service_issue_restitch_screen_range((s->>'rootOperationId')::uuid,(s->>'teamId')::uuid,(s->>'actorId')::uuid,
  p_slot,p_version,p_acquisition,p_request,p_expected_budget,p_next_budget,p_grant,p_ticket_hash,(s->>'executorId')::uuid,(s->>'epoch')::bigint);
 if not exists(select 1 from private.restitch_control_screen_ranges where range_grant_id=p_grant) then
  insert into private.restitch_control_screen_ranges(range_grant_id,control_grant_id) values(p_grant,p_control);
 end if;
 select control_grant_id into b from private.restitch_control_screen_ranges where range_grant_id=p_grant;
 if b is distinct from p_control then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
 return r; -- reservation, leaf grant and immutable control binding commit together
exception when unique_violation then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';
end $fn$;
create function public.service_read_restitch_control_screen_range_issue(p_control uuid,p_control_hash bytea,p_slot text,p_request uuid,p_grant uuid)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare s jsonb;
begin
 s:=private.restitch_control_screen_scope(p_control,p_control_hash,false);
 if not exists(select 1 from private.restitch_control_screen_ranges where range_grant_id=p_grant and control_grant_id=p_control) then return null;end if;
 return public.service_read_restitch_screen_range_issue((s->>'rootOperationId')::uuid,(s->>'teamId')::uuid,(s->>'actorId')::uuid,
  p_slot,p_request,p_grant,(s->>'executorId')::uuid,(s->>'epoch')::bigint);
end $fn$;
create function public.service_consume_restitch_control_screen_range(p_ticket_hash bytea,p_dispatch uuid,p_purpose text)
returns jsonb language plpgsql security definer set search_path='' as $fn$
begin
 if p_purpose is distinct from 'restitch_screen_range_v1' then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 perform private.restitch_control_screen_ticket(p_ticket_hash,true);
 return public.service_consume_restitch_screen_range(p_ticket_hash,p_dispatch,p_purpose);
end $fn$;
create function public.service_read_restitch_control_screen_range_consumption(p_ticket_hash bytea,p_dispatch uuid)
returns jsonb language plpgsql security definer set search_path='' as $fn$
begin
 -- Bookkeeping only: does not grant dispatch, refresh rights or current access.
 if not exists(select 1 from private.restitch_screen_range_grants r join private.restitch_control_screen_ranges b on b.range_grant_id=r.id where r.token_hash=p_ticket_hash) then return null;end if;
 perform private.restitch_control_screen_ticket(p_ticket_hash,false);
 return public.service_read_restitch_screen_range_consumption(p_ticket_hash,p_dispatch);
end $fn$;
create function public.service_check_restitch_control_screen_range(p_ticket_hash bytea,p_dispatch uuid)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare r jsonb;
begin
 -- Recheck immediately before protected upstream I/O. The reader still owns its
 -- single payload-dispatch seam; this read cannot allocate another reservation.
 perform private.restitch_control_screen_ticket(p_ticket_hash,true);
 r:=public.service_read_restitch_screen_range_consumption(p_ticket_hash,p_dispatch);
 if r is null or r->>'consumedByInvocation' is distinct from 'true' then
  raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if not exists(select 1 from private.restitch_selection_slots s,lateral jsonb_array_elements(s.budget->'transfers') t
  where s.root_operation_id=(r->'grant'->>'rootOperationId')::uuid and s.slot=r->'grant'->>'slot'
   and t=r->'grant'->'reservation') then
  raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 return r; -- only an original still-unsettled reservation can precede I/O
end $fn$;
create function public.service_abandon_restitch_control_screen_range(p_control uuid,p_control_hash bytea,p_slot text,p_request uuid,p_grant uuid)
returns boolean language plpgsql security definer set search_path='' as $fn$
declare s jsonb;
begin
 s:=private.restitch_control_screen_scope(p_control,p_control_hash,false);
 if not exists(select 1 from private.restitch_control_screen_ranges where range_grant_id=p_grant and control_grant_id=p_control) then return false;end if;
 return public.service_abandon_restitch_screen_range((s->>'rootOperationId')::uuid,(s->>'teamId')::uuid,(s->>'actorId')::uuid,
  p_slot,p_request,p_grant,(s->>'executorId')::uuid,(s->>'epoch')::bigint);
end $fn$;
create function public.service_refresh_restitch_control_screen_range(p_control uuid,p_control_hash bytea,p_slot text,p_request uuid,p_grant uuid,
 p_acquisition integer,p_refresh uuid,p_expected_budget jsonb,p_next_budget jsonb)
returns boolean language plpgsql security definer set search_path='' as $fn$
declare s jsonb;
begin
 s:=private.restitch_control_screen_scope(p_control,p_control_hash,true);
 if not exists(select 1 from private.restitch_control_screen_ranges where range_grant_id=p_grant and control_grant_id=p_control) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 return public.service_refresh_restitch_screen_range((s->>'rootOperationId')::uuid,(s->>'teamId')::uuid,(s->>'actorId')::uuid,
  p_slot,p_request,p_grant,(s->>'executorId')::uuid,(s->>'epoch')::bigint,p_acquisition,p_refresh,p_expected_budget,p_next_budget);
end $fn$;
revoke all on function private.restitch_control_screen_scope(uuid,bytea,boolean),private.guard_restitch_control_screen_range(),
 private.restitch_control_screen_ticket(bytea,boolean) from public,anon,authenticated,service_role;
revoke all on function public.service_issue_restitch_control_screen_range(uuid,bytea,text,uuid,integer,uuid,jsonb,jsonb,uuid,bytea),
 public.service_read_restitch_control_screen_range_issue(uuid,bytea,text,uuid,uuid),
 public.service_consume_restitch_control_screen_range(bytea,uuid,text),public.service_read_restitch_control_screen_range_consumption(bytea,uuid),
 public.service_check_restitch_control_screen_range(bytea,uuid),public.service_abandon_restitch_control_screen_range(uuid,bytea,text,uuid,uuid),
 public.service_refresh_restitch_control_screen_range(uuid,bytea,text,uuid,uuid,integer,uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.service_issue_restitch_control_screen_range(uuid,bytea,text,uuid,integer,uuid,jsonb,jsonb,uuid,bytea),
 public.service_read_restitch_control_screen_range_issue(uuid,bytea,text,uuid,uuid),
 public.service_consume_restitch_control_screen_range(bytea,uuid,text),public.service_read_restitch_control_screen_range_consumption(bytea,uuid),
 public.service_check_restitch_control_screen_range(bytea,uuid),public.service_abandon_restitch_control_screen_range(uuid,bytea,text,uuid,uuid),
 public.service_refresh_restitch_control_screen_range(uuid,bytea,text,uuid,uuid,integer,uuid,jsonb,jsonb) to service_role;
commit;
