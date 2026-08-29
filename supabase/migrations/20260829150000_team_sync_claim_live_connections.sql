-- 011 (findings I1): the scheduler leased catalog-sync jobs before asking
-- whether their connection was still attached. The public wrapper filtered
-- detached connections out *after* the lease, so a replaced root's old job —
-- first in the queue by next_attempt_at — took the worker's single slot every
-- minute, and the new root's initial scan starved behind it.
--
-- The claim now skips jobs whose connection is detached, and jobs already
-- orphaned that way are closed as failed so they stop being candidates.

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
      attempts = job.attempts + 1,
      updated_at = clock_timestamp()
  from candidates
  where job.id = candidates.id
  returning job.*;
$$;

update private.catalog_sync_jobs as job
   set state = 'failed',
       last_error_code = 'CONNECTION_DETACHED',
       lease_owner = null,
       lease_expires_at = null,
       completed_at = clock_timestamp(),
       updated_at = clock_timestamp()
  from public.team_drive_connections as connection
 where connection.id = job.connection_id
   and connection.state = 'detached'
   and job.state in ('pending', 'retry', 'leased');
