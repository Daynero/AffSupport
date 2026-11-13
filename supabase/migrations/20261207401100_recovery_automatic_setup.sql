-- Automatic setup shares one native ticket across tabs. Replaying that ticket
-- must never revoke the delegation it just created. Redeem replies stay in
-- Vault for the short enrollment lifetime so a lost native response is safe.
begin;
alter table private.team_recovery_enrollments
 add column delegation_id uuid,
 add column response_secret_id uuid;
-- A durable native ticket proves which unacknowledged delegation it created,
-- even after the short Vault receipt has been cleaned up. A different ticket
-- cannot displace live work.
alter table private.team_recovery_delegations add column enrollment_hash bytea;

create function private.cleanup_recovery_enrollment_response()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.response_secret_id is not null then
  delete from vault.secrets where id=old.response_secret_id;
 end if;
 return old;
end $$;
create trigger recovery_enrollment_response_cleanup
 after delete on private.team_recovery_enrollments
 for each row execute function private.cleanup_recovery_enrollment_response();
revoke all on function private.cleanup_recovery_enrollment_response()
 from public,anon,authenticated,service_role;

alter function public.service_team_recovery(text,bytea,jsonb) rename to service_team_recovery_before_automatic;
alter function public.service_team_recovery_before_automatic(text,bytea,jsonb) set schema private;
revoke all on function private.service_team_recovery_before_automatic(text,bytea,jsonb)
 from public,anon,authenticated,service_role;

create function public.service_team_recovery(p_action text,p_hash bytea,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare enrollment private.team_recovery_enrollments; delegation private.team_recovery_delegations;
 actor uuid; team uuid; installation uuid; receipt jsonb; secret uuid;
begin
 if p_action not in ('delegate','redeem') then
  return private.service_team_recovery_before_automatic(p_action,p_hash,p_input);
 end if;
 if p_input is null or jsonb_typeof(p_input)<>'object' or pg_column_size(p_input)>262144
  or p_hash is null or octet_length(p_hash)<>32 then
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;
 if p_input->>'protocolVersion' is distinct from '2' then
  raise exception 'AGENT_UPDATE_REQUIRED' using errcode='42501';
 end if;
 if p_action='delegate' then
  actor:=(p_input->>'actorId')::uuid; team:=(p_input->>'teamId')::uuid;
  installation:=(p_input->>'installationId')::uuid;
  if actor is null or team is null or installation is null then raise exception 'INVALID_INPUT'; end if;
  perform private.lock_team_recovery_installation(actor,installation);
  if not private.recovery_actor_allowed(team,actor) then
   raise exception 'PERMISSION_DENIED' using errcode='42501';
  end if;
  select * into enrollment from private.team_recovery_enrollments
   where actor_id=actor and team_id=team and installation_id=installation and ticket_hash=p_hash
   order by expires_at desc limit 1 for update;
  if enrollment.id is not null and enrollment.expires_at>clock_timestamp() then
   if enrollment.consumed_at is not null and not exists(
    select 1 from private.team_recovery_delegations d where d.id=enrollment.delegation_id
     and d.actor_id=actor and d.team_id=team and d.installation_id=installation
     and d.revoked_at is null and d.expires_at>clock_timestamp()
   ) then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
   return jsonb_build_object('challengeId',enrollment.id);
  end if;
  select * into delegation from private.team_recovery_delegations d
   where d.actor_id=actor and d.team_id=team and d.installation_id=installation
    and d.enrollment_hash=p_hash order by d.created_at desc limit 1;
  if p_input->'automatic'='true'::jsonb and delegation.id is not null and delegation.revoked_at is not null
   then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
  if p_input ? 'renewalDelegationId' and delegation.id is null and not exists(
   select 1 from private.team_recovery_delegations d
    where d.id=(p_input->>'renewalDelegationId')::uuid and d.actor_id=actor
     and d.team_id=team and d.installation_id=installation
     and d.revoked_at is null and d.expires_at<=clock_timestamp()
  ) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
  -- Automatic setup cannot replace a live credential, including a different
  -- tab/old native process whose ownership is not yet known to this caller.
  if p_input->'automatic'='true'::jsonb and exists(
   select 1 from private.team_recovery_delegations d
    where d.actor_id=actor and d.team_id=team and d.installation_id=installation
     and d.revoked_at is null and d.expires_at>clock_timestamp()
     and d.enrollment_hash is distinct from p_hash
  ) then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  return private.service_team_recovery_before_automatic(p_action,p_hash,p_input);
 end if;

 select * into enrollment from private.team_recovery_enrollments
  where id=(p_input->>'challengeId')::uuid;
 if enrollment.id is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
 perform private.lock_team_recovery_installation(enrollment.actor_id,enrollment.installation_id);
 select * into enrollment from private.team_recovery_enrollments where id=enrollment.id for update;
 if enrollment.id is null or enrollment.ticket_hash is distinct from p_hash
  or enrollment.expires_at<=clock_timestamp() then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
 if not private.recovery_actor_allowed(enrollment.team_id,enrollment.actor_id) then
  raise exception 'PERMISSION_DENIED' using errcode='42501';
 end if;
 if enrollment.consumed_at is not null then
  select * into delegation from private.team_recovery_delegations where id=enrollment.delegation_id;
  if delegation.id is null or delegation.revoked_at is not null or delegation.expires_at<=clock_timestamp()
   or delegation.actor_id<>enrollment.actor_id or delegation.team_id<>enrollment.team_id
   or delegation.installation_id<>enrollment.installation_id then
   raise exception 'AUTH_REQUIRED' using errcode='42501';
  end if;
  select decrypted_secret::jsonb into receipt from vault.decrypted_secrets where id=enrollment.response_secret_id;
  if receipt is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  return receipt;
 end if;
 receipt:=private.service_team_recovery_before_automatic(p_action,p_hash,p_input);
 update private.team_recovery_delegations set enrollment_hash=p_hash
  where id=(receipt->>'delegationId')::uuid;
 secret:=vault.create_secret(receipt::text,'soty-recovery-enrollment-'||enrollment.id::text,'Short-lived native enrollment receipt');
 update private.team_recovery_enrollments set delegation_id=(receipt->>'delegationId')::uuid,response_secret_id=secret
  where id=enrollment.id;
 return receipt;
end $$;
revoke all on function public.service_team_recovery(text,bytea,jsonb) from public,anon,authenticated;
grant execute on function public.service_team_recovery(text,bytea,jsonb) to service_role;
commit;
