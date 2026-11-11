-- An idle space's Drive feed is polled less and less often (perf, owner request 2026-11-11).
--
-- Every connected space's incremental job was rescheduled 1 minute after each
-- pass, forever, whether or not anything had changed: on production 14 spaces
-- made ~20k passes a day (one space 37k in total), and the cost grew with the
-- number of spaces, not with what people did. Each pass is an edge invocation,
-- a Drive changes page and several RPCs.
--
-- A pass whose change token did not move found nothing new (the Drive token
-- only advances with a change; verified on production 2026-11-11). Each such
-- pass doubles the wait, 1 -> 2 -> 4 -> 8 -> 10 minutes at most; any pass that
-- moves the token returns it to 1 minute. A space someone has open is woken at
-- once by wake_team_catalog_sync (the web calls it when a space opens and when
-- its tab becomes visible, at most every 2 minutes), and the existing resync
-- nudge resets the backoff too, so a person never waits for an idle feed.
--
-- The completion function is redefined in full from the body 20261008100000
-- left; the redefinition refuses to run over any other body.

do $base$
declare expected constant jsonb:=jsonb_build_object(
 'public.service_complete_catalog_sync_job(uuid,text,text,text)','06771327c98fe20663c5289ebd1b8152',
 'private.nudge_catalog_sync_feed(uuid)','68959ed2efc171ed4f23121dfb63ef93');
 fn text;
begin
 for fn in select jsonb_object_keys(expected) loop
  if (select md5(prosrc) from pg_catalog.pg_proc where oid=fn::regprocedure) is distinct from expected->>fn then
   raise exception 'CATALOG_SYNC_BACKOFF_BASE_CHANGED' using detail=fn;
  end if;
 end loop;
end $base$;

alter table private.catalog_sync_jobs
  add column idle_polls smallint not null default 0 check (idle_polls between 0 and 4);

create or replace function public.service_complete_catalog_sync_job(
  p_job uuid, p_worker text, p_change_token text, p_next_phase text default 'incremental'
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare job private.catalog_sync_jobs; seq bigint; resolved_team uuid; previous_cursor text; idle smallint;
begin
  select * into job from private.catalog_sync_jobs where id = p_job;
  if not private.lock_catalog_sync_lease(p_job, p_worker, job.lease_epoch) then return false; end if;
  if p_next_phase not in ('incremental', 'reconcile') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select team_id into resolved_team from public.team_drive_connections where id = job.connection_id;
  if job.job_kind = 'incremental' then
    if nullif(p_change_token, '') is null then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
    -- The Drive feed did not move: nothing changed since the last poll.
    select a.confirmed_cursor into previous_cursor from private.catalog_sync_authority a
      where a.connection_id = job.connection_id;
    idle := case when previous_cursor is not distinct from p_change_token
      then least(coalesce(job.idle_polls, 0) + 1, 4) else 0 end;
    update private.catalog_sync_authority set confirmed_cursor = p_change_token, confirmed_job_id = p_job,
      confirmed_sequence = confirmed_sequence + 1, confirmed_at = clock_timestamp(), bootstrap_required = false
      where connection_id = job.connection_id returning confirmed_sequence into seq;
    update private.catalog_sync_jobs set phase = 'incremental', state = 'pending', attempts = 0,
      cursor = jsonb_build_object('pageToken', p_change_token, 'changePageToken', p_change_token),
      folder_queue = '[]', lease_owner = null, lease_expires_at = null,
      last_error_code = null, updated_at = clock_timestamp(), last_progress_at = clock_timestamp(),
      idle_polls = idle,
      next_attempt_at = clock_timestamp()
        + least(interval '10 minutes', interval '1 minute' * power(2, idle)::integer)
      where id = p_job;
    update private.catalog_sync_jobs set state = 'succeeded', completed_at = clock_timestamp(),
      updated_at = clock_timestamp(), last_error_code = null, error_detail = null
      where connection_id = job.connection_id and job_kind <> 'incremental'
        and state = 'pending' and replay_after <= seq;
    update public.team_drive_connections set change_page_token = p_change_token,
      initial_sync_state = case when exists (select 1 from private.catalog_sync_jobs
        where connection_id = job.connection_id and job_kind in ('initial', 'reconcile')
          and state in ('pending', 'leased', 'retry')) then 'scanning' else 'ready' end,
      last_synced_at = clock_timestamp(), last_error_code = null, updated_at = clock_timestamp()
      where id = job.connection_id;
  else
    select confirmed_sequence + 1 into seq from private.catalog_sync_authority where connection_id = job.connection_id;
    update private.catalog_sync_jobs set phase = 'change_replay', state = 'pending', replay_after = seq,
      attempts = 0, folder_queue = '[]', lease_owner = null, lease_expires_at = null,
      last_error_code = null, error_detail = null, updated_at = clock_timestamp(),
      last_progress_at = clock_timestamp(), scan_completed_at = clock_timestamp() where id = p_job;
    perform private.nudge_catalog_sync_feed(job.connection_id);
  end if;
  insert into public.team_catalog_events(team_id, material_id, event_kind) values (resolved_team, null, 'sync_state');
  return true;
end;
$$;

-- A resync request (or the completion of a scan) wants the feed now: no backoff.
create or replace function private.nudge_catalog_sync_feed(p_connection uuid)
returns void language sql security definer set search_path = '' as $$
  update private.catalog_sync_jobs
  set next_attempt_at = least(next_attempt_at, pg_catalog.clock_timestamp()), idle_polls = 0
  where connection_id = p_connection and job_kind = 'incremental' and state in ('pending', 'retry');
$$;
revoke all on function private.nudge_catalog_sync_feed(uuid) from public, anon, authenticated, service_role;

-- A member has the space open: poll an idle feed now. Writes only when the
-- feed is actually backed off, so repeated calls cost a read.
create function public.wake_team_catalog_sync(p_team uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); woke integer;
begin
  if actor is null or private.team_role(p_team, actor) is null then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if not private.team_workspace_allowed(p_team) then return false; end if;
  update private.catalog_sync_jobs as j
  set next_attempt_at = pg_catalog.clock_timestamp(), idle_polls = 0
  from public.team_drive_connections as c
  where c.id = j.connection_id and c.team_id = p_team and c.state = 'connected'
    and j.job_kind = 'incremental' and j.state = 'pending'
    and j.idle_polls > 0 and j.next_attempt_at > pg_catalog.clock_timestamp();
  get diagnostics woke = row_count;
  return woke > 0;
end $$;
revoke all on function public.wake_team_catalog_sync(uuid) from public, anon, service_role;
grant execute on function public.wake_team_catalog_sync(uuid) to authenticated;
