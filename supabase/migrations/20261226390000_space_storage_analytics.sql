-- 057 T061: the storage of R2 spaces for the read-only analytics CLI (`space-storage`,
-- research.md R13). One row per R2 space, and one per deleted space whose tombstone is known:
-- the ledger, reservations, the purge queue and its delay, the last reconciliation (orphans,
-- missing), the derivative backfill queue and the commit → signal delay. Counts, sizes and times
-- only: no names, keys, paths or people. Drive spaces are not in it.

create view public.analytics_space_storage with (security_invoker = false) as
select
  'live'::text as space_state,
  team.id as team_id,
  team.storage_pilot as pilot,
  private.space_capacity_bytes(team.id) as capacity_bytes,
  coalesce(usage.bytes, 0)::bigint as used_bytes,
  coalesce(usage.objects, 0)::bigint as counted_objects,
  coalesce(usage.shared_bytes, 0)::bigint as shared_bytes,
  coalesce(usage.by_category, '{}'::jsonb) as used_by_category,
  coalesce(reservation.reserved_bytes, 0)::bigint as reserved_bytes,
  coalesce(reservation.uncertain, 0)::bigint as uncertain_reservations,
  coalesce(objects.live, 0)::bigint as live_objects,
  coalesce(purge.due, 0)::bigint as purges_due,
  coalesce(purge.in_flight, 0)::bigint as purges_in_flight,
  coalesce(purge.failed, 0)::bigint as purges_failed,
  purge.oldest_due_at,
  coalesce(purge.deleted_7d, 0)::bigint as purges_deleted_7d,
  purge.delete_delay_p95_s,
  purge.delete_delay_max_s,
  reconciliation.id as reconciliation_id,
  reconciliation.state as reconciliation_state,
  reconciliation.started_at as reconciliation_started_at,
  reconciliation.finished_at as reconciliation_finished_at,
  reconciliation.listed as reconciliation_listed,
  reconciliation.ledger as reconciliation_ledger,
  reconciliation.orphans_found,
  reconciliation.orphans_deleted,
  reconciliation.orphans_waiting,
  reconciliation.missing as missing_objects,
  reconciliation.foreign_keys,
  reconciliation.last_error as reconciliation_error,
  coalesce(derivative.pending, 0)::bigint as derivative_jobs_pending,
  coalesce(derivative.failed, 0)::bigint as derivative_jobs_failed,
  derivative.oldest_pending_at as derivative_oldest_pending_at,
  signal.commits_7d,
  signal.commit_signal_p95_ms,
  null::timestamptz as removed_queued_at,
  null::timestamptz as removed_finished_at,
  null::bigint as removed_deleted_objects,
  null::text as removed_error
from public.teams team
left join lateral (
  select sum(u.bytes) as bytes, sum(u.objects) as objects, sum(u.shared_bytes) as shared_bytes,
    jsonb_object_agg(u.category, u.bytes::text) filter (where u.bytes <> 0) as by_category
  from public.space_storage_usage u where u.team_id = team.id) usage on true
left join lateral (
  select sum(r.bytes) filter (where r.state in ('reserved', 'uncertain')) as reserved_bytes,
    count(*) filter (where r.state = 'uncertain') as uncertain
  from public.space_storage_reservations r where r.team_id = team.id and r.state in ('reserved', 'uncertain')) reservation on true
left join lateral (
  select count(*) as live from public.space_objects o where o.team_id = team.id and o.state = 'committed') objects on true
left join lateral (
  select count(*) filter (where p.state = 'due' and p.lease_until is null) as due,
    count(*) filter (where p.state = 'due' and p.lease_until is not null) as in_flight,
    count(*) filter (where p.state = 'failed') as failed,
    min(p.due_at) filter (where p.state = 'due') as oldest_due_at,
    count(*) filter (where p.state = 'deleted' and p.deleted_at > now() - interval '7 days') as deleted_7d,
    round(percentile_cont(0.95) within group (order by extract(epoch from p.deleted_at - p.due_at))
      filter (where p.state = 'deleted' and p.deleted_at > now() - interval '7 days')::numeric, 1) as delete_delay_p95_s,
    round(max(extract(epoch from p.deleted_at - p.due_at))
      filter (where p.state = 'deleted' and p.deleted_at > now() - interval '7 days')::numeric, 1) as delete_delay_max_s
  from public.space_object_purges p where p.team_id = team.id) purge on true
left join lateral (
  select r.* from public.space_storage_reconciliations r where r.team_id = team.id
  order by r.started_at desc limit 1) reconciliation on true
left join lateral (
  select count(*) filter (where j.state in ('pending_agent', 'claimed')) as pending,
    count(*) filter (where j.state = 'failed') as failed,
    min(j.created_at) filter (where j.state in ('pending_agent', 'claimed')) as oldest_pending_at
  from public.space_derivative_jobs j where j.team_id = team.id) derivative on true
left join lateral (
  -- The first signal at or after each commit of the last week: the server side of SC-013.
  select count(*) as commits_7d,
    round(percentile_cont(0.95) within group (order by extract(epoch from lag.signal_at - lag.committed_at) * 1000)::numeric, 0)
      as commit_signal_p95_ms
  from (
    select u.updated_at as committed_at,
      (select min(s.created_at) from public.team_space_storage_signals s
        where s.team_id = u.team_id and s.created_at >= u.updated_at) as signal_at
    from public.space_uploads u
    where u.team_id = team.id and u.state = 'committed' and u.updated_at > now() - interval '7 days'
  ) lag where lag.signal_at is not null) signal on true
where team.storage_backend = 'r2'
union all
select
  'deleted', removed.team_ref, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
  removed.queued_at, removed.finished_at, removed.deleted_objects, removed.last_error
from private.space_storage_removed_spaces removed;

revoke all on public.analytics_space_storage from public, anon, authenticated, service_role;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'wishly_analytics_ro') then
    grant select on public.analytics_space_storage to wishly_analytics_ro;
  end if;
end $$;
