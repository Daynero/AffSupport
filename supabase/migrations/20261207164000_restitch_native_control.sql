-- Internal enrolled native control only. No public route or capability.
-- A new grant cannot adopt an existing native claim, even with its leaked UUID.
begin;
create table private.restitch_native_controls (
 id uuid primary key,
 root_operation_id uuid not null, team_id uuid not null, actor_id uuid not null,
 session_id uuid not null, enrollment_id uuid not null unique, native_instance_id uuid not null,
 proof_hash bytea not null unique check(octet_length(proof_hash)=32),
 token_hash bytea not null unique check(octet_length(token_hash)=32),
 created_at timestamptz not null default clock_timestamp(),
 challenge_until timestamptz not null, expires_at timestamptz not null,
 redeemed_at timestamptz, claim_id uuid,
 foreign key(root_operation_id,team_id,actor_id)
  references private.restitch_selection_roots(root_operation_id,team_id,actor_id) on delete cascade,
 unique(root_operation_id,claim_id),
 check(challenge_until>created_at and challenge_until<=created_at+interval '2 minutes'),
 check(expires_at>challenge_until and expires_at<=created_at+interval '24 hours'),
 check(claim_id is null or redeemed_at is not null)
);
alter table private.restitch_native_controls enable row level security;
alter table private.restitch_native_controls force row level security;
revoke all on private.restitch_native_controls from public,anon,authenticated,service_role;
create function private.guard_restitch_native_control() returns trigger
language plpgsql security definer set search_path='' as $fn$
begin
 if (to_jsonb(new)-'redeemed_at'-'claim_id') is distinct from (to_jsonb(old)-'redeemed_at'-'claim_id')
  or (old.redeemed_at is not null and new.redeemed_at is distinct from old.redeemed_at)
  or (old.claim_id is not null and new.claim_id is distinct from old.claim_id) then
  raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
 return new;
end $fn$;
create trigger restitch_native_control_immutable before update on private.restitch_native_controls
 for each row execute function private.guard_restitch_native_control();

create function private.require_restitch_control_session(p_session uuid,p_actor uuid)
returns void language plpgsql security definer set search_path='' as $fn$
begin
 -- No FK/cascade: logout must stop new I/O but preserve exact late bookkeeping.
 perform 1 from auth.sessions s where s.id=p_session and s.user_id=p_actor
  and (to_jsonb(s)->>'not_after' is null or (to_jsonb(s)->>'not_after')::timestamptz>clock_timestamp()) for share;
 if not found then raise exception 'AUTH_REQUIRED' using errcode='42501';end if;
end $fn$;
create function private.restitch_native_control_scope(p_grant uuid,p_hash bytea,p_active boolean)
returns private.restitch_native_controls language plpgsql security definer set search_path='' as $fn$
declare g private.restitch_native_controls%rowtype;
begin
 select * into g from private.restitch_native_controls where id=p_grant;
 if g.id is null then raise exception 'AUTH_REQUIRED' using errcode='42501';end if;
 -- Same parent-first lock order as claims, reservations, cancellation and closure.
 perform 1 from public.team_operations where id=g.root_operation_id for update;
 select * into g from private.restitch_native_controls where id=p_grant for update;
 if g.id is null or p_hash is null or g.token_hash is distinct from p_hash or g.redeemed_at is null then
  raise exception 'AUTH_REQUIRED' using errcode='42501';end if;
 if p_active then
  if g.expires_at<=clock_timestamp() then raise exception 'EXPIRED' using errcode='55000';end if;
  perform private.require_restitch_control_session(g.session_id,g.actor_id);
  perform private.require_restitch_executor(g.root_operation_id,g.team_id,g.actor_id,null,null,true);
 end if;
 return g;
end $fn$;
create function private.restitch_native_control_receipt(g private.restitch_native_controls)
returns jsonb language sql immutable set search_path='' as $fn$
 select jsonb_build_object('grantId',(g).id,'rootOperationId',(g).root_operation_id,
  'teamId',(g).team_id,'actorId',(g).actor_id,'nativeInstanceId',(g).native_instance_id,
  'enrollmentId',(g).enrollment_id,'expiresAt',(g).expires_at,
  'redeemed',(g).redeemed_at is not null);
$fn$;

-- The trusted browser-auth factory supplies actor and verified Auth session;
-- proof hash comes from the local agent, token hash from the private server MAC.
create function public.service_issue_restitch_native_control(p_root uuid,p_team uuid,p_actor uuid,
 p_session uuid,p_grant uuid,p_enrollment uuid,p_native uuid,p_proof_hash bytea,p_ticket_hash bytea)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare g private.restitch_native_controls%rowtype;t timestamptz;
begin
 if p_session is null or p_grant is null or p_enrollment is null or p_native is null
  or p_proof_hash is null or octet_length(p_proof_hash)<>32
  or p_ticket_hash is null or octet_length(p_ticket_hash)<>32 then
  raise exception 'INVALID_INPUT' using errcode='22023';end if;
 perform 1 from public.team_operations where id=p_root for update;
 perform private.require_restitch_executor(p_root,p_team,p_actor,null,null,true);
 perform private.require_restitch_control_session(p_session,p_actor);
 select * into g from private.restitch_native_controls where id=p_grant or enrollment_id=p_enrollment for update;
 if g.id is not null then
  if (g.id,g.root_operation_id,g.team_id,g.actor_id,g.session_id,g.enrollment_id,g.native_instance_id,g.proof_hash,g.token_hash)
   is distinct from (p_grant,p_root,p_team,p_actor,p_session,p_enrollment,p_native,p_proof_hash,p_ticket_hash) then
   raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
  return private.restitch_native_control_receipt(g);
 end if;
 if (select count(*) from private.restitch_native_controls where root_operation_id=p_root)>=8 then
  raise exception 'RATE_LIMITED' using errcode='55000';end if;
 t:=clock_timestamp();
 insert into private.restitch_native_controls(id,root_operation_id,team_id,actor_id,session_id,
  enrollment_id,native_instance_id,proof_hash,token_hash,created_at,challenge_until,expires_at)
 values(p_grant,p_root,p_team,p_actor,p_session,p_enrollment,p_native,p_proof_hash,p_ticket_hash,t,t+interval '2 minutes',t+interval '24 hours') returning * into g;
 return private.restitch_native_control_receipt(g);
exception when unique_violation then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';
end $fn$;

-- No token is returned by SQL. Only the origin-free native Edge handler may
-- reconstruct its purpose-bound token after this exact proof is acknowledged.
create function public.service_redeem_restitch_native_control(p_grant uuid,p_proof_hash bytea)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare g private.restitch_native_controls%rowtype;
begin
 select * into g from private.restitch_native_controls where id=p_grant;
 if g.id is null then raise exception 'AUTH_REQUIRED' using errcode='42501';end if;
 perform 1 from public.team_operations where id=g.root_operation_id for update;
 select * into g from private.restitch_native_controls where id=p_grant for update;
 if g.id is null or p_proof_hash is null or g.proof_hash is distinct from p_proof_hash then
  raise exception 'AUTH_REQUIRED' using errcode='42501';end if;
 if g.expires_at<=clock_timestamp() or (g.redeemed_at is null and g.challenge_until<=clock_timestamp()) then
  raise exception 'EXPIRED' using errcode='55000';end if;
 perform private.require_restitch_control_session(g.session_id,g.actor_id);
 perform private.require_restitch_executor(g.root_operation_id,g.team_id,g.actor_id,null,null,true);
 if g.redeemed_at is null then
  update private.restitch_native_controls set redeemed_at=clock_timestamp() where id=g.id returning * into g;
 end if;
 return private.restitch_native_control_receipt(g);
end $fn$;

create function public.service_claim_restitch_native_control(p_grant uuid,p_ticket_hash bytea,p_claim uuid,p_contract integer)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare g private.restitch_native_controls%rowtype;r jsonb;
begin
 if p_claim is null or p_contract is distinct from 1 then raise exception 'RESTITCH_CLIENT_OUTDATED' using errcode='55000';end if;
 g:=private.restitch_native_control_scope(p_grant,p_ticket_hash,true);
 if g.claim_id is not null then
  if g.claim_id<>p_claim then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
  return public.service_read_restitch_executor_claim(g.root_operation_id,g.team_id,g.actor_id,g.claim_id,g.native_instance_id);
 end if;
 -- Existing claims, including internal legacy claims and another control grant,
 -- cannot be adopted merely by presenting their UUID or matching native instance.
 if exists(select 1 from private.restitch_selection_executor_claims where root_operation_id=g.root_operation_id and claim_id=p_claim) then
  raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
 r:=public.service_claim_restitch_executor(g.root_operation_id,g.team_id,g.actor_id,p_claim,g.native_instance_id,p_contract);
 if r->>'active' is distinct from 'true' then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 update private.restitch_native_controls set claim_id=p_claim where id=g.id;
 return r; -- claim and immutable control binding commit in one transaction
exception when unique_violation then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';
end $fn$;
create function public.service_read_restitch_native_control_claim(p_grant uuid,p_ticket_hash bytea,p_claim uuid)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare g private.restitch_native_controls%rowtype;
begin
 g:=private.restitch_native_control_scope(p_grant,p_ticket_hash,false);
 if p_claim is null or g.claim_id is distinct from p_claim then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
 return public.service_read_restitch_executor_claim(g.root_operation_id,g.team_id,g.actor_id,g.claim_id,g.native_instance_id);
end $fn$;
create function public.service_quiesce_restitch_native_control(p_grant uuid,p_ticket_hash bytea,p_claim uuid,p_quiescence uuid)
returns boolean language plpgsql security definer set search_path='' as $fn$
declare g private.restitch_native_controls%rowtype;r jsonb;
begin
 g:=private.restitch_native_control_scope(p_grant,p_ticket_hash,false);
 if p_claim is null or g.claim_id is distinct from p_claim then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
 r:=public.service_read_restitch_executor_claim(g.root_operation_id,g.team_id,g.actor_id,g.claim_id,g.native_instance_id);
 if r is null then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 return public.service_quiesce_restitch_executor(g.root_operation_id,g.team_id,g.actor_id,(r->>'executorId')::uuid,(r->>'epoch')::bigint,p_quiescence);
end $fn$;
create function public.service_authorize_restitch_native_control(p_grant uuid,p_ticket_hash bytea)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare g private.restitch_native_controls%rowtype;r jsonb;
begin
 g:=private.restitch_native_control_scope(p_grant,p_ticket_hash,true);
 if g.claim_id is null then raise exception 'WRONG_STATE' using errcode='55000';end if;
 r:=public.service_read_restitch_executor_claim(g.root_operation_id,g.team_id,g.actor_id,g.claim_id,g.native_instance_id);
 if r is null or r->>'active' is distinct from 'true' then raise exception 'WRONG_STATE' using errcode='55000';end if;
 perform private.require_restitch_executor(g.root_operation_id,g.team_id,g.actor_id,(r->>'executorId')::uuid,(r->>'epoch')::bigint);
 return private.restitch_native_control_receipt(g)||r;
end $fn$;
revoke all on function private.guard_restitch_native_control(),
 private.require_restitch_control_session(uuid,uuid),private.restitch_native_control_scope(uuid,bytea,boolean),
 private.restitch_native_control_receipt(private.restitch_native_controls) from public,anon,authenticated,service_role;
revoke all on function public.service_issue_restitch_native_control(uuid,uuid,uuid,uuid,uuid,uuid,uuid,bytea,bytea),
 public.service_redeem_restitch_native_control(uuid,bytea),public.service_claim_restitch_native_control(uuid,bytea,uuid,integer),
 public.service_read_restitch_native_control_claim(uuid,bytea,uuid),public.service_quiesce_restitch_native_control(uuid,bytea,uuid,uuid),
 public.service_authorize_restitch_native_control(uuid,bytea) from public,anon,authenticated,service_role;
grant execute on function public.service_issue_restitch_native_control(uuid,uuid,uuid,uuid,uuid,uuid,uuid,bytea,bytea),
 public.service_redeem_restitch_native_control(uuid,bytea),public.service_claim_restitch_native_control(uuid,bytea,uuid,integer),
 public.service_read_restitch_native_control_claim(uuid,bytea,uuid),public.service_quiesce_restitch_native_control(uuid,bytea,uuid,uuid),
 public.service_authorize_restitch_native_control(uuid,bytea) to service_role;
commit;
