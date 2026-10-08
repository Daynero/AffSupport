-- 028 — read-only diagnostics for manual sync (release A).
--
-- The analytics CLI connects as `wishly_analytics_ro`, which can see three
-- analytics tables and nothing in `private`. When a space says "sync is
-- stuck" there was no sanctioned way to look at its jobs. This view is that
-- way: a whitelist of lifecycle columns, no cursors, no page tokens, no lease
-- owners, no file or folder names. The requested folder is a 12-character
-- hash, enough to match a worker log line, not enough to name a Drive item.
-- Columns that later releases fill (requests, counters) are present as
-- nulls/zeros so the CLI contract does not move under the operator.

create view public.analytics_catalog_sync_jobs
with (security_invoker = false) as
select
  j.id as job_id,
  c.team_id,
  (select u.email_normalized from public.teams t
     join public.analytics_users u on u.id = t.owner_id
    where t.id = c.team_id) as owner_email_normalized,
  j.connection_id,
  c.state as connection_state,
  j.job_kind,
  j.phase,
  j.state,
  case when j.requested_folder_id is null then null
    else left(encode(extensions.digest(j.requested_folder_id, 'sha256'), 'hex'), 12) end as scope_hash,
  null::uuid as requested_by,
  null::uuid as request_id,
  null::text as request_key_hash,
  null::text as request_outcome,
  null::timestamptz as detached_at,
  j.created_at,
  j.updated_at,
  j.completed_at,
  j.scan_completed_at,
  j.last_progress_at,
  j.lease_expires_at,
  j.lease_epoch,
  j.run_count,
  j.attempts,
  j.lease_lost_count,
  null::integer as no_progress_runs,
  j.next_attempt_at,
  j.replay_after,
  a.confirmed_sequence,
  a.confirmed_at,
  a.recovery_count,
  a.last_recovery_at,
  k.id as canonical_job_id,
  k.state as canonical_state,
  k.last_error_code as canonical_error_code,
  k.next_attempt_at as canonical_next_attempt_at,
  j.last_error_code,
  j.error_detail,
  null::timestamptz as cancel_requested_at,
  0::bigint as files_listed,
  0::bigint as files_added,
  0::bigint as files_updated,
  0::bigint as files_removed,
  0::bigint as items_unavailable,
  0::bigint as folders_done
from private.catalog_sync_jobs j
join public.team_drive_connections c on c.id = j.connection_id
left join private.catalog_sync_authority a on a.connection_id = j.connection_id
left join lateral (
  select k.id, k.state, k.last_error_code, k.next_attempt_at
  from private.catalog_sync_jobs k
  where k.connection_id = j.connection_id and k.job_kind = 'incremental'
  order by (k.state in ('pending', 'leased', 'retry')) desc, k.created_at desc
  limit 1
) k on true;

revoke all on public.analytics_catalog_sync_jobs from public, anon, authenticated, service_role;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'wishly_analytics_ro') then
    grant select on public.analytics_catalog_sync_jobs to wishly_analytics_ro;
  end if;
end $$;

notify pgrst, 'reload schema';
