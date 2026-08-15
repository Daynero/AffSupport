-- catalog-sync now treats incomplete Drive change metadata as unavailable
-- rather than a permanent parser failure.  Requeue only jobs that were
-- terminally failed by that former behavior and report the truthful replaying
-- state until the worker commits a new change token.

with requeued as (
  update private.catalog_sync_jobs as job
  set state = 'pending',
      last_error_code = null,
      next_attempt_at = clock_timestamp(),
      lease_owner = null,
      lease_expires_at = null,
      completed_at = null,
      updated_at = clock_timestamp()
  where job.state = 'failed'
    and job.last_error_code = 'INVALID_RESPONSE'
  returning job.connection_id
)
update public.team_drive_connections as connection
set initial_sync_state = 'replaying',
    last_error_code = null,
    updated_at = clock_timestamp()
where connection.id in (select connection_id from requeued)
  and connection.state <> 'detached';
