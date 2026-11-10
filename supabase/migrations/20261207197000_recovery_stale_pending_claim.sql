-- A recovery claim inserts a 'pending' receipt, asks drive-ops for a job and
-- then registers the response. If the Edge invocation died in between (for
-- example while the database was saturated), the receipt stayed 'pending'
-- forever: every later claim for the delegation answered {pending:true}, the
-- agent parked background work as checkpoint_unavailable, and the space's
-- background re-stitching stopped until the person toggled it off and on.
--
-- A pending receipt can only ever be confirmed by the invocation that created
-- it. That invocation is bounded by the Edge wall clock (minutes), the claim
-- credential lives 5 minutes, and a job lease taken by the claim is at most
-- 600 s (service_claim_restitch_job clamps p_lease_seconds to 600). After
-- 15 minutes no confirmation can arrive and any job the lost claim leased is
-- reclaimable again, so the abandoned receipt is removed before the claim is
-- evaluated. A late register_claim for it answers NOT_FOUND, which the Edge
-- caller already treats as an uncertain result; nothing runs twice.
begin;
do $stale_pending$
declare d text;
begin
 select pg_get_functiondef('private.service_team_recovery_core(text,bytea,jsonb)'::regprocedure) into d;
 if strpos(d,$find$if p_action='claim' then$find$)=0 then raise exception 'RECOVERY_CLAIM_BRANCH_PATCH_MISSING';end if;
 if strpos(d,'team_recovery_abandoned_pending')>0 then return;end if;
 d:=replace(d,$find$if p_action='claim' then$find$,$replace$if p_action='claim' then
  -- team_recovery_abandoned_pending: a lost claim cannot be confirmed after 15 minutes.
  delete from private.team_recovery_claim_receipts where delegation_id=delegation.id and state='pending' and created_at<clock_timestamp()-interval '15 minutes';$replace$);
 execute d;
end $stale_pending$;
commit;
