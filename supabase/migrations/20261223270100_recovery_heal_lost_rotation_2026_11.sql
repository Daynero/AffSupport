-- One-time repair for the two delegations 20261223270000 explains (production 2026-11-20 NUTRA
-- (RKS), 2026-11-21 КАТАЛОГИ): revoked only because the desktop retried a rotation whose reply
-- it never got. Each desktop still holds the handle it rotated from (the delegation's previous
-- handle), so that handle becomes current again and the family is live; the desktop's next
-- rotation (after Soty restarts and re-asks its parked verdict) continues from there.
-- Every guard of the new retry rule must still hold, and nothing newer may exist for the same
-- person, space and computer; a row that no longer matches is left as it is.
update private.team_recovery_delegations d
set refresh_hash=d.previous_hash,previous_hash=null,rotation_id=null,rotation_replay_until=null,revoked_at=null
where d.id in ('3df94e9b-dfbf-45bd-947a-eb5e616946e6','b612180e-4367-47be-af21-48ed1664f434')
 and d.revoked_at is not null and d.previous_hash is not null
 and d.revoked_at between d.last_rotation_at+interval '60 seconds' and d.last_rotation_at+interval '30 minutes'
 and (d.last_claim_at is null or d.last_claim_at<d.last_rotation_at)
 and (d.last_probe_at is null or d.last_probe_at<d.last_rotation_at)
 and d.expires_at>clock_timestamp()
 and private.recovery_actor_allowed(d.team_id,d.actor_id)
 and not exists(select 1 from private.team_recovery_delegations n
  where n.team_id=d.team_id and n.actor_id=d.actor_id and n.installation_id=d.installation_id and n.created_at>d.created_at);
