-- 028 — manual sync lifecycle, release A.
--
-- A finished finite scan parks itself as a replay waiter and can only be
-- finished by the connection's canonical incremental job. When that job died
-- (a Drive shortcut among the changes, a 400, a rate-limit 403) or sat in
-- retry backoff, every manual scan of the space stayed "running" until a
-- second person's click happened to insert a new canonical job. This
-- migration gives waiters a terminal state with a reason, lets a manual
-- request pull a retrying canonical forward, counts expired leases as
-- failures, sweeps orphans from the existing retention cron, and repairs the
-- rows that are already stuck. Everything is additive; the older web reads
-- the new error codes as an ordinary failure.

alter table private.catalog_sync_jobs
  add column error_detail text,
  add column scan_completed_at timestamptz,
  add column lease_lost_count bigint not null default 0;
alter table private.catalog_sync_authority
  add column recovery_count bigint not null default 0,
  add column last_recovery_at timestamptz;

-- ---------------------------------------------------------------------------
-- A human is waiting: the feed may not sit out its backoff.
-- ---------------------------------------------------------------------------
create function private.nudge_catalog_sync_feed(p_connection uuid)
returns void language sql security definer set search_path = '' as $$
  update private.catalog_sync_jobs
  set next_attempt_at = least(next_attempt_at, pg_catalog.clock_timestamp())
  where connection_id = p_connection and job_kind = 'incremental' and state in ('pending', 'retry');
$$;
revoke all on function private.nudge_catalog_sync_feed(uuid) from public, anon, authenticated, service_role;

-- A new canonical job from the last confirmed position. With nothing confirmed
-- yet the worker bootstraps a fresh start token on its first claim.
create function private.recover_catalog_sync_feed(p_connection uuid, p_delay interval)
returns uuid language plpgsql security definer set search_path = '' as $$
declare confirmed text; fallback text; created uuid;
begin
  select a.confirmed_cursor into confirmed from private.catalog_sync_authority a
    where a.connection_id = p_connection;
  select c.change_page_token into fallback from public.team_drive_connections c
    where c.id = p_connection and c.state <> 'detached';
  if not found then return null; end if;
  insert into private.catalog_sync_jobs(connection_id, job_kind, phase, cursor, next_attempt_at)
  values (p_connection, 'incremental', 'incremental',
    case when coalesce(confirmed, fallback) is null then '{}'::jsonb
      else jsonb_build_object('pageToken', coalesce(confirmed, fallback),
        'changePageToken', coalesce(confirmed, fallback)) end,
    clock_timestamp() + coalesce(p_delay, interval '0'))
  on conflict (connection_id) where job_kind = 'incremental' and state in ('pending', 'leased', 'retry')
    do nothing
  returning id into created;
  return created;
end;
$$;
revoke all on function private.recover_catalog_sync_feed(uuid, interval) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- When the canonical job dies, its waiters learn why — or get a new feed.
-- ---------------------------------------------------------------------------
create or replace function public.service_retry_catalog_sync_job(
  p_job uuid, p_worker text, p_error_code text, p_next_attempt_at timestamptz, p_permanent boolean default false
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  job private.catalog_sync_jobs;
  terminal boolean;
  code text := left(coalesce(p_error_code, 'DRIVE_UNAVAILABLE'), 96);
  recoveries bigint;
  last_recovery timestamptz;
  recover boolean := false;
begin
  select * into job from private.catalog_sync_jobs where id = p_job;
  if not private.lock_catalog_sync_lease(p_job, p_worker, job.lease_epoch) then return false; end if;
  terminal := p_permanent or job.attempts + 1 >= 10;
  update private.catalog_sync_jobs set state = case when terminal then 'failed' else 'retry' end,
    attempts = least(attempts + 1, 1000), last_error_code = code,
    next_attempt_at = coalesce(p_next_attempt_at, clock_timestamp() + interval '1 minute'),
    lease_owner = null, lease_expires_at = null,
    completed_at = case when terminal then clock_timestamp() else null end, updated_at = clock_timestamp()
    where id = p_job;
  if terminal and job.job_kind = 'incremental' then
    select a.recovery_count, a.last_recovery_at into recoveries, last_recovery
      from private.catalog_sync_authority a where a.connection_id = job.connection_id for update;
    if not p_permanent then
      -- Six automatic recoveries in a day is no longer a transient outage.
      if last_recovery is null or last_recovery < clock_timestamp() - interval '24 hours' then
        recoveries := 0;
      end if;
      recover := coalesce(recoveries, 0) < 6;
    end if;
    if recover then
      perform private.recover_catalog_sync_feed(job.connection_id, interval '5 minutes');
      update private.catalog_sync_authority
        set recovery_count = coalesce(recoveries, 0) + 1, last_recovery_at = clock_timestamp()
        where connection_id = job.connection_id;
      update public.team_drive_connections set last_error_code = code, updated_at = clock_timestamp()
        where id = job.connection_id;
    else
      update private.catalog_sync_jobs set state = 'failed', last_error_code = 'CANONICAL_FAILED',
        error_detail = code, completed_at = clock_timestamp(), updated_at = clock_timestamp()
        where connection_id = job.connection_id and job_kind <> 'incremental'
          and state = 'pending' and replay_after is not null;
      update public.team_drive_connections set initial_sync_state = 'failed',
        last_error_code = code, updated_at = clock_timestamp() where id = job.connection_id;
    end if;
  end if;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- A finished scan records when it started waiting and wakes the feed even
-- from retry.
-- ---------------------------------------------------------------------------
create or replace function public.service_complete_catalog_sync_job(
  p_job uuid, p_worker text, p_change_token text, p_next_phase text default 'incremental'
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare job private.catalog_sync_jobs; seq bigint; resolved_team uuid;
begin
  select * into job from private.catalog_sync_jobs where id = p_job;
  if not private.lock_catalog_sync_lease(p_job, p_worker, job.lease_epoch) then return false; end if;
  if p_next_phase not in ('incremental', 'reconcile') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select team_id into resolved_team from public.team_drive_connections where id = job.connection_id;
  if job.job_kind = 'incremental' then
    if nullif(p_change_token, '') is null then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
    update private.catalog_sync_authority set confirmed_cursor = p_change_token, confirmed_job_id = p_job,
      confirmed_sequence = confirmed_sequence + 1, confirmed_at = clock_timestamp(), bootstrap_required = false
      where connection_id = job.connection_id returning confirmed_sequence into seq;
    update private.catalog_sync_jobs set phase = 'incremental', state = 'pending', attempts = 0,
      cursor = jsonb_build_object('pageToken', p_change_token, 'changePageToken', p_change_token),
      folder_queue = '[]', lease_owner = null, lease_expires_at = null,
      last_error_code = null, updated_at = clock_timestamp(), last_progress_at = clock_timestamp(),
      next_attempt_at = clock_timestamp() + interval '1 minute'
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

-- ---------------------------------------------------------------------------
-- Manual requests wake the feed too.
-- ---------------------------------------------------------------------------
create or replace function public.request_team_folder_resync(p_team uuid, p_folder text)
returns table(sync_job_id uuid, initial_sync_state text)
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); connected uuid; parent text; joined uuid;
begin
  if actor is null or coalesce(private.team_role(p_team, actor), '') not in ('owner', 'admin') then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if nullif(p_folder, '') is null then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  select c.id, m.parent_folder_id into connected, parent
    from public.team_drive_connections c join public.team_materials m
      on m.connection_id = c.id and m.team_id = c.team_id
      and m.drive_file_id = p_folder and m.kind = 'folder' and m.lifecycle = 'active'
    where c.team_id = p_team and c.state = 'connected';
  if connected is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  joined := private.join_catalog_subtree(connected, p_folder, parent, 'user_subtree');
  perform private.nudge_catalog_sync_feed(connected);
  return query select joined, 'scanning'::text;
end;
$$;

create or replace function public.request_team_catalog_resync(p_team uuid)
returns table(sync_job_id uuid, initial_sync_state text)
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); resolved_connection uuid; queued_job uuid;
begin
  if actor is null or not coalesce(private.team_role(p_team, actor) in ('owner', 'admin'), false) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select c.id into resolved_connection from public.team_drive_connections c
  where c.team_id = p_team and c.state = 'connected' for update;
  if resolved_connection is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select j.id into queued_job from private.catalog_sync_jobs j
  where j.connection_id = resolved_connection
    and j.job_kind in ('initial', 'reconcile')
    and j.requested_folder_id is null
    and j.phase = 'initial_scan'
    and not j.scan_initialized
    and j.state in ('pending', 'leased', 'retry')
  order by j.created_at desc limit 1;
  if queued_job is null then
    queued_job := public.service_enqueue_catalog_reconciliation(resolved_connection);
  end if;
  perform private.nudge_catalog_sync_feed(resolved_connection);
  update public.team_drive_connections
  set initial_sync_state = 'scanning', last_synced_at = null, last_error_code = null
  where id = resolved_connection;
  perform private.record_team_audit(p_team, actor, 'drive.resynced',
    jsonb_build_object('connection_id', resolved_connection, 'state', 'scanning'),
    'succeeded', null);
  insert into public.team_catalog_events(team_id, material_id, event_kind)
  values (p_team, null, 'sync_state');
  return query select queued_job, 'scanning'::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- An expired lease is a failed attempt, not a free restart.
-- ---------------------------------------------------------------------------
create or replace function private.claim_catalog_sync_jobs(
  p_worker text, p_limit integer default 5, p_lease_seconds integer default 60
)
returns setof private.catalog_sync_jobs language plpgsql security definer set search_path = '' as $$
declare
  slots integer;
  slot integer;
  candidate record;
  epoch bigint;
  sequence_number bigint;
  background_turn boolean;
begin
  if nullif(p_worker, '') is null then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  if not pg_try_advisory_xact_lock(71101400) then return; end if;
  -- A worker that never came back: count it, then let the job be claimed again.
  -- The feed itself is never retired this way; health reports it as delayed.
  -- next_attempt_at keeps the value the claim gave it, so the job's place in
  -- the queue is where its lease ended, not the front.
  update private.catalog_sync_jobs
  set attempts = least(attempts + 1, 1000), lease_lost_count = lease_lost_count + 1,
    state = 'pending', lease_owner = null, lease_expires_at = null, updated_at = clock_timestamp()
  where state = 'leased' and lease_expires_at <= clock_timestamp();
  -- Ten attempts without a commit, at least one of them a vanished worker.
  update private.catalog_sync_jobs
  set state = 'failed', last_error_code = 'LEASE_LOST_EXHAUSTED',
    completed_at = clock_timestamp(), updated_at = clock_timestamp()
  where state = 'pending' and job_kind <> 'incremental' and lease_lost_count > 0 and attempts >= 10;
  update private.catalog_sync_jobs set state = 'failed', lease_owner = null, lease_expires_at = null,
    last_error_code = 'RETRY_EXHAUSTED', completed_at = clock_timestamp()
  where attempts >= 1000 and state in ('pending', 'retry');
  select greatest(0, 3 - count(*)::integer) into slots from private.catalog_sync_jobs
    where state = 'leased' and lease_expires_at > clock_timestamp();
  for slot in 1..least(greatest(p_limit, 1), slots) loop
    update private.catalog_sync_scheduler_state
      set claim_sequence = claim_sequence + 1 where singleton
      returning claim_sequence into sequence_number;
    background_turn := sequence_number % 4 = 0;
    select eligible.id, eligible.connection_id into candidate from (
      select j.id, j.connection_id, j.next_attempt_at, j.created_at, j.job_kind,
        row_number() over (partition by j.connection_id order by
          case when background_turn then
            case j.job_kind when 'incremental' then 0 when 'initial' then 1
              when 'discovered_subtree' then 2 else 3 end
          else case j.job_kind when 'user_subtree' then 0
              when 'discovered_subtree' then 1 when 'initial' then 2 else 3 end end,
          j.next_attempt_at, j.created_at, j.id) as rank
      from private.catalog_sync_jobs j
      join public.team_drive_connections c on c.id = j.connection_id
      where c.state <> 'detached' and j.replay_after is null
        and j.next_attempt_at <= clock_timestamp()
        and j.state in ('pending', 'retry')
        and not exists (select 1 from private.catalog_sync_jobs busy
          where busy.connection_id = j.connection_id and busy.state = 'leased'
            and busy.lease_expires_at > clock_timestamp())
    ) eligible where eligible.rank = 1
    order by case when background_turn then
        case eligible.job_kind when 'incremental' then 0 when 'initial' then 1
          when 'discovered_subtree' then 2 else 3 end
      else case eligible.job_kind when 'user_subtree' then 0
          when 'discovered_subtree' then 1 when 'initial' then 2 else 3 end end,
      eligible.next_attempt_at, eligible.created_at, eligible.id limit 1;
    if not found then exit; end if;
    update private.catalog_sync_authority set lease_epoch = lease_epoch + 1
      where connection_id = candidate.connection_id returning lease_epoch into epoch;
    return query update private.catalog_sync_jobs j set state = 'leased', lease_owner = p_worker,
      lease_epoch = epoch, run_count = run_count + 1,
      lease_expires_at = clock_timestamp() + make_interval(secs => least(greatest(p_lease_seconds, 10), 300)),
      next_attempt_at = clock_timestamp() + make_interval(secs => least(greatest(p_lease_seconds, 10), 300)),
      updated_at = clock_timestamp()
      where j.id = candidate.id returning j.*;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- The cron must not call the worker for a waiter nothing can claim.
-- ---------------------------------------------------------------------------
create or replace function private.invoke_catalog_sync_worker()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  endpoint text;
  worker_secret text;
  request_id bigint;
begin
  if not exists (
    select 1
    from private.catalog_sync_jobs as job
    join public.team_drive_connections as connection on connection.id = job.connection_id
    where connection.state <> 'detached'
      and job.attempts < 1000
      and job.replay_after is null
      and job.next_attempt_at <= pg_catalog.clock_timestamp()
      and (
        job.state in ('pending', 'retry')
        or (job.state = 'leased' and job.lease_expires_at <= pg_catalog.clock_timestamp())
      )
  ) then
    return null;
  end if;

  if (
    select count(*)
    from private.catalog_sync_jobs
    where state = 'leased' and lease_expires_at > pg_catalog.clock_timestamp()
  ) >= 3 then
    return null;
  end if;

  select secret.decrypted_secret into endpoint
  from vault.decrypted_secrets as secret
  where secret.name = 'wishly_catalog_sync_url'
  order by secret.created_at desc
  limit 1;

  select secret.decrypted_secret into worker_secret
  from vault.decrypted_secrets as secret
  where secret.name = 'wishly_catalog_sync_secret'
  order by secret.created_at desc
  limit 1;

  if endpoint is null or endpoint !~ '^https?://' then
    raise exception 'CATALOG_SYNC_CONFIG_INVALID: wishly_catalog_sync_url is missing or invalid'
      using errcode = 'P0001';
  end if;
  if worker_secret is null or char_length(worker_secret) < 32 then
    raise exception 'CATALOG_SYNC_CONFIG_INVALID: wishly_catalog_sync_secret is missing or too short'
      using errcode = 'P0001';
  end if;

  select net.http_post(
    url := endpoint,
    headers := pg_catalog.jsonb_build_object(
      'content-type', 'application/json',
      'x-catalog-sync-secret', worker_secret
    ),
    body := '{"scheduled":true}'::jsonb,
    timeout_milliseconds := 60000
  ) into request_id;
  return request_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Orphans are repaired by the clock, never by another person's click.
-- ---------------------------------------------------------------------------
create function private.sweep_catalog_sync_orphans(
  p_limit integer default 200, p_min_age interval default interval '2 minutes'
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  remaining integer := least(greatest(coalesce(p_limit, 200), 1), 500);
  removed integer;
  detached_count integer := 0;
  timeout_count integer := 0;
  created_count integer := 0;
  exhausted_count integer := 0;
  orphan record;
begin
  if not pg_try_advisory_xact_lock(71101401) then
    return jsonb_build_object('skipped', true);
  end if;

  -- 1. A detached connection keeps no live work.
  with victims as (
    select j.id from private.catalog_sync_jobs j
    join public.team_drive_connections c on c.id = j.connection_id
    where c.state = 'detached' and j.state in ('pending', 'leased', 'retry')
    limit remaining for update of j skip locked
  )
  update private.catalog_sync_jobs j set state = 'canceled', last_error_code = 'CONNECTION_DETACHED',
    lease_owner = null, lease_expires_at = null, completed_at = clock_timestamp(),
    updated_at = clock_timestamp()
  from victims v where j.id = v.id;
  get diagnostics removed = row_count;
  detached_count := removed;
  remaining := remaining - removed;

  -- 2. An hour behind the barrier is a failure the person can act on.
  if remaining > 0 then
    with victims as (
      select j.id from private.catalog_sync_jobs j
      where j.replay_after is not null and j.state = 'pending'
        and coalesce(j.scan_completed_at, j.updated_at) < clock_timestamp() - interval '60 minutes'
      limit remaining for update skip locked
    )
    update private.catalog_sync_jobs j set state = 'failed', last_error_code = 'REPLAY_TIMEOUT',
      completed_at = clock_timestamp(), updated_at = clock_timestamp()
    from victims v where j.id = v.id;
    get diagnostics removed = row_count;
    timeout_count := removed;
    remaining := remaining - removed;
  end if;

  -- 3. A waiter with no live feed gets one, from the last confirmed position.
  if remaining > 0 then
    for orphan in
      select distinct j.connection_id from private.catalog_sync_jobs j
      join public.team_drive_connections c on c.id = j.connection_id
      where c.state <> 'detached' and j.replay_after is not null and j.state = 'pending'
        and coalesce(j.scan_completed_at, j.updated_at) < clock_timestamp() - coalesce(p_min_age, interval '0')
        and not exists (select 1 from private.catalog_sync_jobs k
          where k.connection_id = j.connection_id and k.job_kind = 'incremental'
            and k.state in ('pending', 'leased', 'retry'))
      limit remaining
    loop
      if private.recover_catalog_sync_feed(orphan.connection_id, interval '0') is not null then
        created_count := created_count + 1;
      end if;
    end loop;
    remaining := remaining - created_count;
  end if;

  -- 4. Insurance for a lease the claim never reclaimed.
  if remaining > 0 then
    with victims as (
      select j.id from private.catalog_sync_jobs j
      where j.state = 'leased' and j.job_kind <> 'incremental' and j.attempts >= 10
        and j.lease_expires_at < clock_timestamp() - interval '15 minutes'
      limit remaining for update skip locked
    )
    update private.catalog_sync_jobs j set state = 'failed', last_error_code = 'LEASE_LOST_EXHAUSTED',
      lease_owner = null, lease_expires_at = null, completed_at = clock_timestamp(),
      updated_at = clock_timestamp()
    from victims v where j.id = v.id;
    get diagnostics removed = row_count;
    exhausted_count := removed;
  end if;

  return jsonb_build_object('detached', detached_count, 'replay_timeout', timeout_count,
    'canonical_created', created_count, 'lease_exhausted', exhausted_count);
end;
$$;
revoke all on function private.sweep_catalog_sync_orphans(integer, interval) from public, anon, authenticated, service_role;

create function private.run_catalog_sync_maintenance()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare swept jsonb; retained jsonb;
begin
  swept := private.sweep_catalog_sync_orphans();
  retained := private.cleanup_catalog_sync_retention();
  return jsonb_build_object('sweep', swept, 'retention', retained);
end;
$$;
revoke all on function private.run_catalog_sync_maintenance() from public, anon, authenticated, service_role;

select cron.unschedule(job.jobid) from cron.job as job where job.jobname = 'wishly-catalog-sync-retention';
select cron.schedule('wishly-catalog-sync-retention', '*/5 * * * *',
  $cron$select private.run_catalog_sync_maintenance()$cron$);

-- ---------------------------------------------------------------------------
-- A browser that lost the acceptance answer can find its job instead of
-- creating a twin. NULL scope means the whole space.
-- ---------------------------------------------------------------------------
create function public.find_team_folder_sync_request(p_team uuid, p_folder text default null)
returns table(sync_job_id uuid, state text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not coalesce(private.can(p_team, 'view', auth.uid()), false) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
    select j.id, j.state, j.created_at
    from private.catalog_sync_jobs j
    join public.team_drive_connections c on c.id = j.connection_id
    where c.team_id = p_team
      and j.created_at > clock_timestamp() - interval '30 minutes'
      and case when p_folder is null
        then j.requested_folder_id is null and j.job_kind in ('initial', 'reconcile')
        else j.requested_folder_id = p_folder end
    order by (j.state in ('pending', 'leased', 'retry')) desc, j.created_at desc
    limit 1;
end;
$$;
revoke all on function public.find_team_folder_sync_request(uuid, text) from public, anon, service_role;
grant execute on function public.find_team_folder_sync_request(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The detailed status covers a whole-space scan too; its shape is unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.get_team_folder_sync_status(p_team uuid, p_job uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare job private.catalog_sync_jobs; connected_state text; phase text; state text;
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
  state := case when connected_state = 'detached' then 'canceled'
    when job.state in ('failed', 'succeeded', 'canceled') then job.state
    when job.state = 'leased' or job.replay_after is not null then 'running' else 'queued' end;
  phase := case when state in ('failed', 'succeeded', 'canceled') then 'done'
    when job.replay_after is not null then 'replaying_changes'
    when exists (select 1 from private.catalog_scan_frontier f where f.job_id = p_job and f.state = 'reconciling')
      then 'reconciling' else 'listing' end;
  return jsonb_build_object('jobId', job.id,
    'scopeFolderId', coalesce(job.requested_folder_id, '__root__'), 'state', state, 'phase', phase,
    'discoveredFiles', (select count(*) from private.catalog_scan_seen s
      join private.catalog_scan_frontier f on f.job_id = s.job_id and f.generation = s.generation
      where s.job_id = p_job and s.resolution = 'listed'),
    'completedFolders', (select count(*) from private.catalog_scan_frontier f where f.job_id = p_job and f.state = 'done'),
    'pendingFolders', case when not job.scan_initialized then null else
      (select count(*) from private.catalog_scan_frontier f where f.job_id = p_job and f.state <> 'done') end,
    'lastProgressAt', job.last_progress_at, 'completedAt', job.completed_at, 'errorCode', job.last_error_code);
end;
$$;

-- ---------------------------------------------------------------------------
-- Rows that are stuck right now. Nothing is deleted; cursor provenance is
-- untouched; an expired lease becomes a counted retry.
-- ---------------------------------------------------------------------------
update private.catalog_sync_jobs
set attempts = least(attempts + 1, 1000), lease_lost_count = lease_lost_count + 1,
  state = 'pending', lease_owner = null, lease_expires_at = null,
  next_attempt_at = least(next_attempt_at, clock_timestamp()), updated_at = clock_timestamp()
where state = 'leased' and lease_expires_at <= clock_timestamp();
select private.sweep_catalog_sync_orphans(500, interval '0');

notify pgrst, 'reload schema';
