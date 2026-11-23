-- Production 2026-11-20/21: «Фонова робота очікує. У вас немає дозволу на цю дію.» on every page
-- of two spaces (NUTRA (RKS), КАТАЛОГИ), for good. The desktop rotated its recovery refresh, the
-- reply was lost while the database was slow, and the desktop retried the same rotation (same
-- rotation ID, persisted before the first send) 95 s and 17 min later. The cached reply is kept
-- for 60 s only, so the retry was taken for a stolen refresh handle and the delegation was
-- revoked; the desktop parks that verdict as "needs setup" and nothing ever sets it up again.
--
-- A retry of the SAME rotation within 30 minutes whose new credentials were never used (no
-- claim and no probe since that rotation) now rotates again from the handle the desktop still
-- holds: the lost credentials are dropped with the new rotation. A different rotation ID, or a
-- lost rotation whose credentials were already used, still revokes the family.

do $patch$
declare d text;
begin
 select pg_get_functiondef('private.service_team_recovery_core(text,bytea,jsonb)'::regprocedure) into d;
 if strpos(d,$find$   update private.team_recovery_delegations set revoked_at=clock_timestamp(),version=version+1 where id=delegation.id;
   return jsonb_build_object('error','AUTH_REQUIRED'); -- return rather than rollback the revocation
  end if;
  if delegation.last_rotation_at>clock_timestamp()-interval '4 minutes' then raise exception 'RATE_LIMITED'; end if;
$find$)=0
  or strpos(d,$find$set previous_hash=refresh_hash,refresh_hash=(p_input->>'refreshHash')::bytea,$find$)=0
 then raise exception 'RECOVERY_LOST_ROTATION_PATCH_MISSING';end if;
 d:=replace(d,$find$   update private.team_recovery_delegations set revoked_at=clock_timestamp(),version=version+1 where id=delegation.id;
   return jsonb_build_object('error','AUTH_REQUIRED'); -- return rather than rollback the revocation
  end if;
  if delegation.last_rotation_at>clock_timestamp()-interval '4 minutes' then raise exception 'RATE_LIMITED'; end if;
$find$,
  $replace$   -- The same rotation, retried after its reply was lost and its cached reply expired: the
   -- credentials it issued were never used, so rotate again from the handle still held.
   if not (delegation.rotation_id=(p_input->>'rotationId')::uuid
     and delegation.last_rotation_at>clock_timestamp()-interval '30 minutes'
     and (delegation.last_claim_at is null or delegation.last_claim_at<delegation.last_rotation_at)
     and (delegation.last_probe_at is null or delegation.last_probe_at<delegation.last_rotation_at)) then
    update private.team_recovery_delegations set revoked_at=clock_timestamp(),version=version+1 where id=delegation.id;
    return jsonb_build_object('error','AUTH_REQUIRED'); -- return rather than rollback the revocation
   end if;
   -- Nothing may use what the lost reply carried: its claim was issued after that rotation and
   -- expires 5 minutes after it (an earlier claim expires at least 4 minutes sooner).
   delete from private.team_recovery_credentials where delegation_id=delegation.id and audience='claim'
    and expires_at>=delegation.last_rotation_at+interval '5 minutes';
  elsif delegation.last_rotation_at>clock_timestamp()-interval '4 minutes' then raise exception 'RATE_LIMITED';
  end if;
$replace$);
 -- On that retry the handle still held stays the previous one; the lost handle is forgotten.
 d:=replace(d,$find$set previous_hash=refresh_hash,refresh_hash=(p_input->>'refreshHash')::bytea,$find$,
  $replace$set previous_hash=case when previous_hash=p_hash then previous_hash else refresh_hash end,refresh_hash=(p_input->>'refreshHash')::bytea,$replace$);
 execute d;
end $patch$;
