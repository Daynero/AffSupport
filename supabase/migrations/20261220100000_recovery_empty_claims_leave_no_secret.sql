-- Backend audit 2026-11-20: every background-recovery poll left a Vault secret behind.
--
-- An agent asks «is there work for me?» every 30 seconds per delegation. register_claim stored
-- each answer in Vault so that a lost response could be replayed, and the sweep kept the receipt
-- and its secret for 30 days. Measured on the shared database: 15 686 receipts and secrets in one
-- day for 31 delegations, 59 438 confirmed receipts in all — and 59 424 of them said «no job»,
-- the constant {"job": null, "operationCredential": null}. vault.secrets had grown to 59 333 rows,
-- service_team_recovery was the third largest writer of WAL (527 MB in eight days), and the
-- steady state of a 30-day horizon is ~86 000 rows per running agent.
--
-- Two changes, neither of which alters an answer:
--
--  * The empty answer is one constant and carries no credential, so it is no longer encrypted
--    into Vault at all: a confirmed receipt without a secret IS the empty answer, and a replay
--    gives the constant back. Anything else — a job, a credential, a shape this migration does
--    not know — still goes to Vault exactly as before.
--  * A receipt that handed out no job is pruned after one hour instead of thirty days, together
--    with its Vault secret if it has one — the secrets older builds wrote, and the secret of a
--    jobless answer in any other shape. A receipt is keyed by delegation and request id, and the
--    agent keeps the request id of an unanswered poll, so a replay can arrive later than that
--    under a newer claim credential. It is then a new poll, which may hand out a job where the
--    lost answer said there was none — exactly what the agent polls for; nothing runs twice,
--    because the pruned receipt never handed anything out. Receipts that did hand out a job
--    (operation_id is not null) keep the 30-day horizon; retire_team_recovery_delegation reads
--    them.
begin;

-- No column is added for this. A receipt's row already says everything: state 'confirmed'
-- with no response_secret_id can only have been written by the branch below. (A jsonb column
-- would also have put the table into private.task_cleanup_reference_tables(), which lists
-- every table that can hold a material reference; these receipts hold none.)

do $empty_claims$
declare
 d text;
 replay constant text := $find$select decrypted_secret::jsonb into response from vault.decrypted_secrets where id=receipt.response_secret_id;$find$;
 store constant text := $find$resolved:=vault.create_secret(response::text,'soty-recovery-claim-'||gen_random_uuid()::text,'Scoped recovery claim');$find$;
begin
 select pg_get_functiondef('private.service_team_recovery_core(text,bytea,jsonb)'::regprocedure) into d;
 if strpos(d,'team_recovery_empty_claim')>0 then return; end if;
 -- Both replay sites (claim and register_claim) and the one place a claim answer is stored.
 if (length(d)-length(replace(d,replay,'')))/length(replay)<>2 then raise exception 'RECOVERY_CLAIM_REPLAY_PATCH_MISSING'; end if;
 if (length(d)-length(replace(d,store,'')))/length(store)<>1 then raise exception 'RECOVERY_CLAIM_STORE_PATCH_MISSING'; end if;
 d:=replace(d,replay,$replace$if receipt.response_secret_id is null then response:='{"job":null,"operationCredential":null}'::jsonb; else select decrypted_secret::jsonb into response from vault.decrypted_secrets where id=receipt.response_secret_id; end if;$replace$);
 d:=replace(d,store,$replace$-- team_recovery_empty_claim: the empty answer is a constant without a credential. Its
  -- receipt is confirmed with no secret, and a replay answers the same constant.
  if response='{"job":null,"operationCredential":null}'::jsonb then
   update private.team_recovery_claim_receipts set state='confirmed'
    where delegation_id=delegation.id and request_id=receipt.request_id;
   return response;
  end if;
  resolved:=vault.create_secret(response::text,'soty-recovery-claim-'||gen_random_uuid()::text,'Scoped recovery claim');$replace$);
 execute d;
end $empty_claims$;

-- Oldest first along recovery_claim_retention (created_at, delegation_id, request_id). The
-- batch is bounded so one sweep never holds a long transaction; at 1 000 a minute the backlog
-- of the 30-day horizon drains within the hour.
create or replace function private.prune_empty_recovery_claims(p_limit integer default 1000)
returns integer language plpgsql security definer set search_path='' as $$
declare
 removed integer;
 -- Read once: a variable can bound the index scan, a volatile call in the query cannot.
 cutoff constant timestamptz := clock_timestamp()-interval '1 hour';
begin
 with doomed as (
  select delegation_id,request_id from private.team_recovery_claim_receipts
  where created_at<cutoff and state='confirmed' and operation_id is null
  order by created_at,delegation_id,request_id
  limit least(greatest(coalesce(p_limit,1000),1),5000) for update skip locked
 ), gone as (
  delete from private.team_recovery_claim_receipts receipt using doomed
  where receipt.delegation_id=doomed.delegation_id and receipt.request_id=doomed.request_id
  returning receipt.response_secret_id
 ), secrets as (
  delete from vault.secrets where id in (select response_secret_id from gone where response_secret_id is not null)
  returning 1
 )
 select count(*)::integer into removed from gone;
 return removed;
end $$;
revoke all on function private.prune_empty_recovery_claims(integer) from public,anon,authenticated,service_role;

create or replace function private.sweep_workspace_recovery()
returns void language plpgsql security definer set search_path='' as $$
begin
 perform private.sweep_workspace_recovery_before_retirement_receipts();
 perform private.sweep_recovery_retirement_receipts();
 perform private.prune_empty_recovery_claims();
end $$;
revoke all on function private.sweep_workspace_recovery() from public,anon,authenticated,service_role;

commit;
