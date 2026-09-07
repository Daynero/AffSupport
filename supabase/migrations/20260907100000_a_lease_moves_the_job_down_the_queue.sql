-- 011 (follow-up to 20260829150000): a job whose worker never reported back
-- held the front of the queue for ever.
--
-- Candidates are ordered by `next_attempt_at` and exactly one is taken per
-- scheduler tick, but the claim never wrote that column. Both ways a worker
-- ends its turn do write it: `checkpoint_catalog_sync_job` sets it to now, and
-- `service_retry_catalog_sync_job` sets the backoff. A worker that died inside
-- its lease wrote neither, so the job kept the `next_attempt_at` it came in
-- with, went back to being claimable the moment its lease expired, and — being
-- the oldest candidate — took the single slot again the next minute, and every
-- minute after that.
--
-- Nothing about it looked broken: state `leased`, no error code, attempts
-- climbing by one a minute. What it starved was every other connection in
-- every other space, including a root that had just been connected, whose
-- catalogue then sat empty while the space reported that it was scanning.
--
-- Leasing now moves `next_attempt_at` to the end of the lease it just granted.
-- A worker that reports back overwrites it exactly as before, so a healthy job
-- is unaffected; one that dies silently rejoins the queue behind whatever was
-- waiting instead of ahead of it.

create or replace function private.claim_catalog_sync_jobs(
  p_worker text,
  p_limit integer default 5,
  p_lease_seconds integer default 60
)
returns setof private.catalog_sync_jobs
language sql
security definer
set search_path = ''
as $$
  with candidates as (
    select job.id
    from private.catalog_sync_jobs as job
    join public.team_drive_connections as connection
      on connection.id = job.connection_id
    where (
        job.state in ('pending', 'retry')
        or (job.state = 'leased' and job.lease_expires_at <= clock_timestamp())
      )
      and job.next_attempt_at <= clock_timestamp()
      and connection.state <> 'detached'
    order by job.next_attempt_at, job.created_at
    for update of job skip locked
    limit least(greatest(p_limit, 1), 20)
  )
  update private.catalog_sync_jobs as job
  set state = 'leased',
      lease_owner = p_worker,
      lease_expires_at = clock_timestamp() + make_interval(secs => least(greatest(p_lease_seconds, 10), 300)),
      next_attempt_at = clock_timestamp() + make_interval(secs => least(greatest(p_lease_seconds, 10), 300)),
      attempts = job.attempts + 1,
      updated_at = clock_timestamp()
  from candidates
  where job.id = candidates.id
  returning job.*;
$$;
