-- Desktop setup receives the server actor; a retained refresh can only retire its own delegation.
begin;
-- Serialize only setup/retirement for the same actor+installation, including an absent row.
-- One lock per request, never one per catalog item or operation.
create function private.lock_team_recovery_installation(p_actor uuid,p_installation uuid)
returns void language sql security definer set search_path='' as $$
 select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  'team-recovery-installation:'||p_actor::text||':'||p_installation::text,0));
$$;
revoke all on function private.lock_team_recovery_installation(uuid,uuid) from public,anon,authenticated,service_role;
-- One canonical cleanup path for refresh-bound desktop retirement and authenticated logout.
create function private.retire_team_recovery_delegation(p_delegation uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare delegation private.team_recovery_delegations; operation record; newly_revoked boolean;
begin
 select * into delegation from private.team_recovery_delegations where id=p_delegation for update;
 if delegation.id is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
 newly_revoked:=delegation.revoked_at is null;
  update private.team_recovery_delegations set revoked_at=clock_timestamp(),version=version+1
   where id=delegation.id and revoked_at is null;
  for operation in
   select candidate.id from public.team_operations candidate
   where candidate.team_id=delegation.team_id and candidate.actor_id=delegation.actor_id
    and candidate.kind='process' and candidate.state in ('pending','running')
    and candidate.id in (
     select operation_id from private.team_recovery_credentials where delegation_id=delegation.id
     union select operation_id from private.team_recovery_claim_receipts where delegation_id=delegation.id
    )
   order by candidate.id for update of candidate
  loop
   -- Match the canonical actor cancellation without depending on now-revoked member rights.
   update public.team_operations set state='canceled',stage='canceled',
    reservation_released_at=coalesce(reservation_released_at,clock_timestamp()),
    finished_at=clock_timestamp(),error_code=null,retryable=false,updated_at=clock_timestamp()
    where id=operation.id;
   update private.team_transfer_grants set revoked_at=clock_timestamp()
    where operation_id=operation.id and revoked_at is null;
   perform private.record_team_audit(delegation.team_id,delegation.actor_id,'operation.canceled',
    jsonb_build_object('operation_id',operation.id,'state','canceled'),'canceled',null);
  end loop;
 return newly_revoked;
end $$;
revoke all on function private.retire_team_recovery_delegation(uuid) from public,anon,authenticated,service_role;

create index recovery_actor_installation_retirement on private.team_recovery_delegations(actor_id,installation_id,id);
create index recovery_actor_installation_enrollment on private.team_recovery_enrollments(actor_id,installation_id);

-- The installation is a scope selector, never authority. The actor comes only from auth.uid().
create function public.retire_team_recovery_installation(p_installation uuid)
returns integer language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); delegation record; retired integer:=0;
begin
 if actor is null then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 if p_installation is null then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 perform private.lock_team_recovery_installation(actor,p_installation);
 -- Lock setup first so a redeem in flight cannot create a delegation after the snapshot.
 delete from private.team_recovery_enrollments where actor_id=actor and installation_id=p_installation;
 for delegation in
  select id from private.team_recovery_delegations
  where actor_id=actor and installation_id=p_installation order by id for update
 loop
  if private.retire_team_recovery_delegation(delegation.id) then retired:=retired+1; end if;
 end loop;
 return retired;
end $$;
revoke all on function public.retire_team_recovery_installation(uuid) from public,anon,authenticated,service_role;
grant execute on function public.retire_team_recovery_installation(uuid) to authenticated;

create or replace function public.service_team_recovery(p_action text,p_hash bytea,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare receipt jsonb; delegation private.team_recovery_delegations; enrollment private.team_recovery_enrollments;
begin
 -- Older Edge/desktop code cannot silently skip the actor-bound setup or execution protocol.
 if p_action in ('redeem','claim','checkpoint')
  and p_input->'protocolVersion' is distinct from '2'::jsonb then
  raise exception 'AGENT_UPDATE_REQUIRED' using errcode='55000';
 end if;
 if p_action='checkpoint' then
  receipt:=public.service_begin_team_recovery_execution(p_hash,p_input);
  if (receipt->>'executionAllowed')::boolean is distinct from true then
   raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';
  end if;
  return receipt;
 elsif p_action='disconnect' then
  if p_hash is null or octet_length(p_hash)<>32 then
   raise exception 'AUTH_REQUIRED' using errcode='42501';
  end if;
  -- A previous handle may be all the machine retained after a lost rotation reply.
  -- It can revoke this same delegation, never authorize or select new work.
  select * into delegation from private.team_recovery_delegations
   where refresh_hash=p_hash or previous_hash=p_hash
   order by (refresh_hash=p_hash) desc,id limit 1 for update;
  if delegation.id is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  perform private.retire_team_recovery_delegation(delegation.id);
  return jsonb_build_object('revoked',true);
 end if;
 if p_action='delegate' then
  perform private.lock_team_recovery_installation((p_input->>'actorId')::uuid,(p_input->>'installationId')::uuid);
 elsif p_action='redeem' then
  select * into enrollment from private.team_recovery_enrollments where id=(p_input->>'challengeId')::uuid;
  if enrollment.id is not null then
   perform private.lock_team_recovery_installation(enrollment.actor_id,enrollment.installation_id);
  end if;
 end if;
 receipt:=private.service_team_recovery_core(p_action,p_hash,p_input);
 if p_action='redeem' then
  select * into delegation from private.team_recovery_delegations where id=(receipt->>'delegationId')::uuid;
  return receipt||jsonb_build_object('actorId',delegation.actor_id);
 end if;
 return receipt;
end $$;
revoke all on function public.service_team_recovery(text,bytea,jsonb) from public,anon,authenticated;
grant execute on function public.service_team_recovery(text,bytea,jsonb) to service_role;
commit;
