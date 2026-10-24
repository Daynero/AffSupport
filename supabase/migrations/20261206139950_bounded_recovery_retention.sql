-- Bound each retention class independently; unresolved lifecycle evidence stays intact.
begin;
create index recovery_rotation_retention on private.team_recovery_delegations(rotation_replay_until,id)
 where rotation_secret_id is not null;
create index recovery_claim_retention on private.team_recovery_claim_receipts(created_at,delegation_id,request_id);
create index recovery_credential_retention on private.team_recovery_credentials(expires_at,hash);
create index recovery_enrollment_retention on private.team_recovery_enrollments(expires_at,id);
create index recovery_rate_retention on private.team_recovery_rate_buckets(minute,installation_id,kind);
create index recovery_terminal_retention on private.workspace_recoveries(last_progress_at,pause_id)
 where state in ('completed','superseded');

create or replace function private.sweep_workspace_recovery()
returns void language plpgsql security definer set search_path='' as $$
declare candidate record;
begin
 perform private.apply_tariff_pauses(null);
 for candidate in select distinct team_id from private.workspace_recoveries where state not in ('completed','superseded') loop
  perform private.dispatch_workspace_recovery(candidate.team_id);
  perform private.observe_workspace_dependencies(candidate.team_id);
 end loop;

 -- Detach and delete each owned Vault response in the same transaction.
 with doomed as (
  select id,rotation_secret_id from private.team_recovery_delegations
  where rotation_replay_until<clock_timestamp() and rotation_secret_id is not null
  order by rotation_replay_until,id limit 100 for update skip locked
 ), detached as (
  update private.team_recovery_delegations delegation set rotation_secret_id=null
  from doomed where delegation.id=doomed.id returning doomed.rotation_secret_id
 )
 delete from vault.secrets where id in (select rotation_secret_id from detached);

 with doomed as (
  select delegation_id,request_id from private.team_recovery_claim_receipts
  where created_at<clock_timestamp()-interval '30 days'
  order by created_at,delegation_id,request_id limit 100 for update skip locked
 ), removed as (
  delete from private.team_recovery_claim_receipts receipt using doomed
  where receipt.delegation_id=doomed.delegation_id and receipt.request_id=doomed.request_id
  returning receipt.response_secret_id
 )
 delete from vault.secrets where id in (select response_secret_id from removed);

 with doomed as (
  select hash from private.team_recovery_credentials where expires_at<clock_timestamp()
  order by expires_at,hash limit 100 for update skip locked
 ) delete from private.team_recovery_credentials credential using doomed where credential.hash=doomed.hash;
 with doomed as (
  select id from private.team_recovery_enrollments where expires_at<clock_timestamp()
  order by expires_at,id limit 100 for update skip locked
 ) delete from private.team_recovery_enrollments enrollment using doomed where enrollment.id=doomed.id;
 with doomed as (
  select installation_id,minute,kind from private.team_recovery_rate_buckets
  where minute<clock_timestamp()-interval '2 minutes'
  order by minute,installation_id,kind limit 100 for update skip locked
 ) delete from private.team_recovery_rate_buckets bucket using doomed
  where bucket.installation_id=doomed.installation_id and bucket.minute=doomed.minute and bucket.kind=doomed.kind;

 -- The bound is on lifecycle roots; cascaded child rows belong to those roots.
 with doomed as (
  select paused.id from private.workspace_pauses paused join private.workspace_recoveries recovery
   on recovery.pause_id=paused.id
  where recovery.state in ('completed','superseded')
   and recovery.last_progress_at<clock_timestamp()-interval '30 days'
   and not exists(select 1 from private.workspace_recovery_items where recovery_id=recovery.id
    and state not in ('completed','skipped_manual','superseded'))
   and not exists(select 1 from public.team_catalog_updater_items where tariff_pause_id=paused.id)
  order by recovery.last_progress_at,paused.id limit 100 for update of paused skip locked
 ) delete from private.workspace_pauses paused using doomed where paused.id=doomed.id;
end $$;
commit;
