-- 028 — manual sync lifecycle, release D.
--
-- Every write of the change-replay phase now goes through the lease fence, so
-- a worker whose lease ended, or whose job was stopped, can no longer finish
-- its page over a newer worker's data or trash a landing artifact in Drive.
-- A folder that keeps restarting its listing without ever finishing is
-- counted and retired as NO_PROGRESS instead of looping for ever.

alter table private.catalog_sync_jobs add column no_progress_runs integer not null default 0;

-- A read-only check the worker makes before a side effect it cannot fence
-- in SQL: trashing an artifact in Drive, committing a transcript.
create function public.service_catalog_sync_lease_live(p_job uuid, p_worker text, p_epoch bigint)
returns boolean language sql security definer set search_path = '' as $$
  select exists (
    select 1 from private.catalog_sync_jobs j
    join public.team_drive_connections c on c.id = j.connection_id
    join private.catalog_sync_authority a on a.connection_id = j.connection_id
    where j.id = p_job and j.state = 'leased' and j.lease_owner = p_worker
      and j.lease_epoch = p_epoch and a.lease_epoch = p_epoch
      and j.lease_expires_at > clock_timestamp() and c.state <> 'detached'
      and j.cancel_requested_at is null
  );
$$;
revoke all on function public.service_catalog_sync_lease_live(uuid,text,bigint) from public, anon, authenticated, service_role;
grant execute on function public.service_catalog_sync_lease_live(uuid,text,bigint) to service_role;

create function public.service_invalidate_landing_renders(
  p_job uuid, p_worker text, p_epoch bigint, p_connection uuid, p_drive_file_ids text[]
) returns table(team_id uuid, material_id uuid, artifact_root text)
language plpgsql security definer set search_path = '' as $$
begin
  if not private.lock_catalog_sync_lease(p_job, p_worker, p_epoch) then
    raise exception 'LEASE_LOST' using errcode = 'P0001';
  end if;
  return query select * from public.service_invalidate_landing_renders(p_connection, p_drive_file_ids);
end;
$$;
revoke all on function public.service_invalidate_landing_renders(uuid,text,bigint,uuid,text[]) from public, anon, authenticated, service_role;
grant execute on function public.service_invalidate_landing_renders(uuid,text,bigint,uuid,text[]) to service_role;

create function public.service_mark_folder_indexed(
  p_job uuid, p_worker text, p_epoch bigint, p_connection uuid, p_drive_folder_id text
) returns integer language plpgsql security definer set search_path = '' as $$
begin
  if not private.lock_catalog_sync_lease(p_job, p_worker, p_epoch) then
    raise exception 'LEASE_LOST' using errcode = 'P0001';
  end if;
  return public.service_mark_folder_indexed(p_connection, p_drive_folder_id);
end;
$$;
revoke all on function public.service_mark_folder_indexed(uuid,text,bigint,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.service_mark_folder_indexed(uuid,text,bigint,uuid,text) to service_role;

create function public.service_mark_root_state(
  p_job uuid, p_worker text, p_epoch bigint, p_connection uuid, p_state text, p_root_name text default null
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.lock_catalog_sync_lease(p_job, p_worker, p_epoch) then
    raise exception 'LEASE_LOST' using errcode = 'P0001';
  end if;
  perform public.service_mark_root_state(p_connection, p_state, p_root_name);
end;
$$;
revoke all on function public.service_mark_root_state(uuid,text,bigint,uuid,text,text) from public, anon, authenticated, service_role;
grant execute on function public.service_mark_root_state(uuid,text,bigint,uuid,text,text) to service_role;

create function public.service_touch_catalog_reconciled(
  p_job uuid, p_worker text, p_epoch bigint, p_connection uuid
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.lock_catalog_sync_lease(p_job, p_worker, p_epoch) then
    raise exception 'LEASE_LOST' using errcode = 'P0001';
  end if;
  perform public.service_touch_catalog_reconciled(p_connection);
end;
$$;
revoke all on function public.service_touch_catalog_reconciled(uuid,text,bigint,uuid) from public, anon, authenticated, service_role;
grant execute on function public.service_touch_catalog_reconciled(uuid,text,bigint,uuid) to service_role;

create function public.service_enqueue_catalog_reconciliation(
  p_job uuid, p_worker text, p_epoch bigint, p_connection uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
begin
  if not private.lock_catalog_sync_lease(p_job, p_worker, p_epoch) then
    raise exception 'LEASE_LOST' using errcode = 'P0001';
  end if;
  return public.service_enqueue_catalog_reconciliation(p_connection);
end;
$$;
revoke all on function public.service_enqueue_catalog_reconciliation(uuid,text,bigint,uuid) from public, anon, authenticated, service_role;
grant execute on function public.service_enqueue_catalog_reconciliation(uuid,text,bigint,uuid) to service_role;

create or replace function public.service_begin_catalog_folder(
  p_job uuid, p_worker text, p_epoch bigint, p_folder text, p_restart boolean default false
)
returns table(generation uuid, page_token text)
language plpgsql security definer set search_path = '' as $$
declare job private.catalog_sync_jobs; frontier private.catalog_scan_frontier; created uuid;
begin
  if not private.lock_catalog_sync_lease(p_job, p_worker, p_epoch) then return; end if;
  select * into job from private.catalog_sync_jobs where id = p_job;
  if job.job_kind = 'incremental' then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  if not job.scan_initialized then
    insert into private.catalog_scan_frontier(job_id, folder_id)
      select p_job, value from jsonb_array_elements_text(job.folder_queue)
      on conflict do nothing;
    update private.catalog_sync_jobs set scan_initialized = true where id = p_job;
  end if;
  select * into frontier from private.catalog_scan_frontier
    where job_id = p_job and folder_id = p_folder for update;
  if not found then raise exception 'INVALID_SCOPE' using errcode = '22023'; end if;
  if p_restart or frontier.generation is null then
    -- A restart that never reaches finish is the loop that looked like work:
    -- re-list, find the same unreadable item, re-list. Count it (028).
    if p_restart then
      update private.catalog_sync_jobs set no_progress_runs = no_progress_runs + 1 where id = p_job;
    end if;
    update private.catalog_scan_generations set state = 'abandoned', updated_at = clock_timestamp()
      where id = frontier.generation;
    insert into private.catalog_scan_generations(job_id, parent_folder_id)
      values (p_job, p_folder) returning id into created;
    update private.catalog_scan_frontier set generation = created, state = 'listing'
      where job_id = p_job and folder_id = p_folder;
  else created := frontier.generation;
  end if;
  return query select g.id, g.page_token from private.catalog_scan_generations g where g.id = created;
end;
$$;

create or replace function public.service_finish_catalog_folder(p_job uuid, p_worker text, p_epoch bigint, p_generation uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare g private.catalog_scan_generations; connected uuid;
begin
  if not private.lock_catalog_sync_lease(p_job, p_worker, p_epoch) then return false; end if;
  select s.* into g from private.catalog_scan_generations s
    join private.catalog_scan_frontier f on f.job_id = s.job_id and f.generation = s.id
    where s.id = p_generation and s.job_id = p_job and s.state = 'reconciling' for update of s;
  if not found then return false; end if;
  if exists (select 1 from public.service_catalog_missing_candidates(p_job, p_worker, p_epoch, p_generation))
    then return false; end if;
  select connection_id into connected from private.catalog_sync_jobs where id = p_job;
  if g.coverage = 'complete' then perform public.service_mark_folder_indexed(connected, g.parent_folder_id); end if;
  update private.catalog_scan_generations set state = 'done', updated_at = clock_timestamp() where id = p_generation;
  update private.catalog_scan_frontier set state = 'done' where job_id = p_job and generation = p_generation;
  update private.catalog_sync_jobs set last_progress_at = clock_timestamp(), updated_at = clock_timestamp(),
    attempts = 0, folders_done = folders_done + 1, no_progress_runs = 0 where id = p_job;
  return true;
end;
$$;

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
  -- Ten restarts of the same folder without ever finishing it is not work.
  update private.catalog_sync_jobs set state = 'failed', last_error_code = 'NO_PROGRESS',
    lease_owner = null, lease_expires_at = null, completed_at = clock_timestamp(), updated_at = clock_timestamp()
  where state in ('pending', 'retry') and job_kind <> 'incremental' and no_progress_runs >= 10;
  -- A person asked for this one to stop before any worker reached it.
  update private.catalog_sync_jobs set state = 'canceled', last_error_code = 'CANCELED_BY_USER',
    lease_owner = null, lease_expires_at = null, completed_at = clock_timestamp(), updated_at = clock_timestamp()
  where state in ('pending', 'retry') and cancel_requested_at is not null;
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

create or replace view public.analytics_catalog_sync_jobs
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
  r.requested_by,
  r.id as request_id,
  case when r.request_key is null then null
    else left(encode(extensions.digest(r.request_key, 'sha256'), 'hex'), 12) end as request_key_hash,
  r.outcome as request_outcome,
  r.detached_at,
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
  j.no_progress_runs,
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
  j.cancel_requested_at,
  j.files_listed,
  j.files_added,
  j.files_updated,
  j.files_removed,
  j.items_unavailable,
  j.folders_done
from private.catalog_sync_jobs j
join public.team_drive_connections c on c.id = j.connection_id
left join private.catalog_sync_authority a on a.connection_id = j.connection_id
left join lateral (
  select k.id, k.state, k.last_error_code, k.next_attempt_at
  from private.catalog_sync_jobs k
  where k.connection_id = j.connection_id and k.job_kind = 'incremental'
  order by (k.state in ('pending', 'leased', 'retry')) desc, k.created_at desc
  limit 1
) k on true
left join lateral (
  select r.id, r.requested_by, r.request_key, r.outcome, r.detached_at
  from private.catalog_sync_requests r
  where r.job_id = j.id order by r.created_at desc limit 1
) r on true;

notify pgrst, 'reload schema';
