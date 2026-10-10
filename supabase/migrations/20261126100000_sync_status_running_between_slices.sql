-- A sync that has started reads as running between its slices.
--
-- The worker takes a job in slices: it leases it, works for a while, and puts
-- it back as pending for the next slice. The status read "Queued" in every gap,
-- under counters that kept climbing — a job half done does not wait in a queue.
-- Pending with at least one run behind it is now "Running"; only a job that has
-- never run is queued.

begin;

create or replace function public.get_team_folder_sync_status(p_team uuid, p_job uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare job private.catalog_sync_jobs; connected_state text; phase text; projected text;
  feed private.catalog_sync_jobs; blocked_reason text; coverage text; req private.catalog_sync_requests;
  shared integer;
begin
  if auth.uid() is null or not coalesce(private.can(p_team, 'view', auth.uid()), false) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select j.* into job from private.catalog_sync_jobs j
    join public.team_drive_connections c on c.id = j.connection_id
    where j.id = p_job and c.team_id = p_team
      and (j.requested_folder_id is not null or j.job_kind in ('initial', 'reconcile'));
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select c.state into connected_state from public.team_drive_connections c where c.id = job.connection_id;
  select k.* into feed from private.catalog_sync_jobs k
    where k.connection_id = job.connection_id and k.job_kind = 'incremental'
    order by (k.state in ('pending', 'leased', 'retry')) desc, k.created_at desc limit 1;
  if job.replay_after is not null and job.state = 'pending' then
    if feed.id is null or feed.state not in ('pending', 'leased', 'retry') then
      blocked_reason := case when coalesce(feed.last_error_code, '') = 'NEEDS_REAUTH'
        or connected_state = 'needs_reauth' then 'needs_reauth' else 'canonical_failed' end;
    elsif feed.state = 'retry'
      and coalesce(job.scan_completed_at, job.updated_at) < clock_timestamp() - interval '10 minutes' then
      blocked_reason := 'canonical_retrying';
    end if;
  end if;
  projected := case when connected_state = 'detached' then 'canceled'
    when job.state in ('failed', 'succeeded', 'canceled') then job.state
    when job.cancel_requested_at is not null then 'canceling'
    when blocked_reason is not null then 'blocked'
    when job.state = 'retry' then 'retry_wait'
    when job.state = 'leased' or job.replay_after is not null
      or (job.state = 'pending' and job.run_count > 0) then 'running'
    else 'queued' end;
  phase := case when projected in ('failed', 'succeeded', 'canceled') then 'done'
    when job.replay_after is not null then 'replaying_changes'
    when exists (select 1 from private.catalog_scan_frontier f where f.job_id = p_job and f.state = 'reconciling')
      then 'reconciling' else 'listing' end;
  select case
    when bool_or(g.coverage = 'permission_limited') then 'permission_limited'
    when bool_or(g.coverage = 'partial') then 'partial'
    when bool_and(g.coverage = 'complete') and projected = 'succeeded' then 'complete'
    else 'unknown' end into coverage
    from private.catalog_scan_generations g where g.job_id = p_job;
  select r.* into req from private.catalog_sync_requests r
    where r.job_id = p_job and r.requested_by = auth.uid() and r.detached_at is null
    order by r.created_at desc limit 1;
  select count(*)::integer into shared from private.catalog_sync_requests r
    where r.job_id = p_job and r.detached_at is null;
  return jsonb_build_object('jobId', job.id, 'requestId', req.id,
    'scopeFolderId', coalesce(job.requested_folder_id, '__root__'), 'state', projected, 'phase', phase,
    'blockedReason', blocked_reason,
    'errorCode', job.last_error_code, 'errorDetail', job.error_detail,
    'nextAttemptAt', case when job.state = 'retry' then job.next_attempt_at else null end,
    'startedAt', job.created_at, 'lastProgressAt', job.last_progress_at,
    'scanCompletedAt', job.scan_completed_at, 'completedAt', job.completed_at,
    'filesListed', job.files_listed, 'filesAdded', job.files_added, 'filesUpdated', job.files_updated,
    'filesRemoved', job.files_removed, 'itemsUnavailable', job.items_unavailable, 'foldersDone', job.folders_done,
    'discoveredFiles', job.files_listed, 'completedFolders', job.folders_done,
    'pendingFolders', case when not job.scan_initialized then null else
      (select count(*) from private.catalog_scan_frontier f where f.job_id = p_job and f.state <> 'done') end,
    'coverage', coalesce(coverage, 'unknown'),
    'progressRevision', job.files_added + job.files_updated + job.files_removed,
    'cancelable', job.job_kind <> 'incremental' and job.state in ('pending', 'leased', 'retry')
      and job.cancel_requested_at is null and req.id is not null,
    'sharedWith', greatest(coalesce(shared, 0) - 1, 0));
end;
$$;


commit;
