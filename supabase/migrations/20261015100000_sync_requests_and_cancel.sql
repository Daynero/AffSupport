-- 028 — manual sync lifecycle, release B.
--
-- Every manual request is now a row of its own: it carries the person who
-- asked, an idempotency key the browser keeps across a lost answer, and the
-- job it joined or created. "Stop" acts on the request: a job other requests
-- share, or the canonical feed, is only left; a job nobody else needs is
-- canceled between bounded units through the lease fence. Progress counters
-- live on the job and only grow, so retention of page-level observations can
-- no longer make a number go down. The detailed status gains the states a
-- person can act on (blocked, retry_wait, canceling) and a result summary.

create table private.catalog_sync_requests (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  connection_id uuid not null references public.team_drive_connections(id) on delete cascade,
  job_id uuid not null references private.catalog_sync_jobs(id) on delete cascade,
  requested_by uuid not null,
  scope_folder_id text,
  request_key text not null,
  created_at timestamptz not null default clock_timestamp(),
  detached_at timestamptz,
  outcome text not null check (outcome in ('joined', 'created', 'followup', 'detached', 'canceled')),
  constraint catalog_sync_requests_key_unique unique (team_id, request_key),
  constraint catalog_sync_requests_key_check check (char_length(request_key) between 8 and 128)
);
create index catalog_sync_requests_job_idx on private.catalog_sync_requests(job_id);
create index catalog_sync_requests_team_idx on private.catalog_sync_requests(team_id, created_at desc);
alter table private.catalog_sync_requests enable row level security;
revoke all on private.catalog_sync_requests from public, anon, authenticated, service_role;

alter table private.catalog_sync_jobs
  add column cancel_requested_at timestamptz,
  add column cancel_requested_by uuid,
  add column files_listed bigint not null default 0,
  add column files_added bigint not null default 0,
  add column files_updated bigint not null default 0,
  add column files_removed bigint not null default 0,
  add column items_unavailable bigint not null default 0,
  add column folders_done bigint not null default 0;


create or replace function private.lock_catalog_sync_lease(p_job uuid, p_worker text, p_epoch bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
declare connected uuid; current_epoch bigint; valid boolean;
begin
  select connection_id into connected from private.catalog_sync_jobs where id = p_job;
  if connected is null then return false; end if;
  select lease_epoch into current_epoch from private.catalog_sync_authority
    where connection_id = connected for update;
  select j.state = 'leased' and j.lease_owner = p_worker
    and j.lease_epoch = p_epoch and current_epoch = p_epoch
    and j.lease_expires_at > clock_timestamp() and c.state <> 'detached'
    and j.cancel_requested_at is null
  into valid from private.catalog_sync_jobs j
  join public.team_drive_connections c on c.id = j.connection_id
  where j.id = p_job for update of j;
  return coalesce(valid, false);
end;
$$;

create or replace function private.join_catalog_subtree(
  p_connection uuid, p_folder text, p_parent text, p_kind text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare token text; joined uuid; widen uuid;
begin
  if p_kind not in ('user_subtree','discovered_subtree')
    or nullif(p_folder, '') is null or length(p_folder) > 1024
    or length(coalesce(p_parent, '')) > 1024 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select c.change_page_token into token from public.team_drive_connections c
    where c.id = p_connection and c.state = 'connected' for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  perform 1 from private.catalog_sync_authority
    where connection_id = p_connection for update;

  with recursive ancestors(id, parent, depth, trail) as (
    select p_folder, p_parent, 0, array[p_folder]
    union all
    select a.parent, m.parent_folder_id, a.depth + 1, a.trail || a.parent
      from ancestors a left join public.team_materials m
        on m.connection_id = p_connection and m.drive_file_id = a.parent
      where a.parent is not null and a.depth < 100 and a.parent <> all(a.trail)
  )
  select j.id into joined from ancestors a join private.catalog_sync_jobs j
    on j.connection_id = p_connection and j.requested_folder_id = a.id
    and j.job_kind in ('user_subtree','discovered_subtree')
    and j.state in ('pending','leased','retry')
    -- A scan already behind the replay barrier has walked its branch; a new
    -- request on it gets one follow-up instead of joining a finished walk (028).
    and j.replay_after is null
  where not exists (
    select 1 from private.catalog_scan_frontier f
    where f.job_id = j.id and f.folder_id in (p_folder, p_parent)
      and f.state <> 'queued'
  )
  order by a.depth, j.created_at, j.id limit 1;
  if joined is not null then return joined; end if;

  with recursive job_ancestors(job_id, id, depth, trail) as (
    select j.id, j.requested_folder_id, 0, array[j.requested_folder_id]
      from private.catalog_sync_jobs j where j.connection_id = p_connection
        and j.job_kind in ('user_subtree','discovered_subtree')
        and j.state in ('pending','leased','retry')
    union all
    select a.job_id, m.parent_folder_id, a.depth + 1, a.trail || m.parent_folder_id
      from job_ancestors a join public.team_materials m
        on m.connection_id = p_connection and m.drive_file_id = a.id
      where m.parent_folder_id is not null and a.depth < 100
        and m.parent_folder_id <> all(a.trail)
  )
  select j.id into widen from job_ancestors a join private.catalog_sync_jobs j on j.id = a.job_id
    where a.id = p_folder and a.depth > 0 and j.state in ('pending','retry')
      and not j.scan_initialized
    order by j.created_at, j.id limit 1 for update of j;
  if widen is not null then
    update private.catalog_sync_jobs set requested_folder_id = p_folder,
      folder_queue = jsonb_build_array(p_folder), cursor = jsonb_build_object(
        'pageToken', null, 'changePageToken', token, 'discoveredFolders', '[]'::jsonb),
      updated_at = clock_timestamp() where id = widen;
    return widen;
  end if;

  insert into private.catalog_sync_jobs
    (connection_id, job_kind, phase, cursor, folder_queue, requested_folder_id)
  values (p_connection, p_kind, 'initial_scan', jsonb_build_object(
    'pageToken', null, 'changePageToken', token, 'discoveredFolders', '[]'::jsonb),
    jsonb_build_array(p_folder), p_folder) returning id into joined;
  return joined;
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

create or replace function public.service_commit_catalog_scan_page(
  p_job uuid, p_worker text, p_epoch bigint, p_generation uuid,
  p_expected_page_token text, p_next_page_token text, p_files jsonb, p_complete boolean
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare g private.catalog_scan_generations; connected uuid; existing bigint; affected integer;
begin
  if not private.lock_catalog_sync_lease(p_job, p_worker, p_epoch) then return false; end if;
  select s.* into g from private.catalog_scan_generations s
    join private.catalog_scan_frontier f on f.job_id = s.job_id and f.generation = s.id
    where s.id = p_generation and s.job_id = p_job and s.state = 'listing'
      and s.page_token is not distinct from p_expected_page_token for update of s;
  if not found then return false; end if;
  if p_complete is null or (p_next_page_token is null) <> p_complete then
    raise exception 'INCOMPLETE_LISTING' using errcode = '22023';
  end if;
  if jsonb_typeof(p_files) is distinct from 'array' or jsonb_array_length(p_files) > 100
    or p_next_page_token = '' then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_array_elements(p_files) item where
    jsonb_typeof(item) <> 'object'
    or jsonb_typeof(item -> 'drive_file_id') is distinct from 'string'
    or jsonb_typeof(item -> 'name') is distinct from 'string'
    or jsonb_typeof(item -> 'kind') is distinct from 'string'
    or coalesce(length(item ->> 'drive_file_id'), 0) not between 1 and 1024
    or coalesce(length(item ->> 'name'), 0) not between 1 and 1024
    or coalesce(item ->> 'kind', '') not in ('file', 'folder', 'shortcut')
    or item ->> 'parent_folder_id' is distinct from g.parent_folder_id)
    or (select count(distinct item ->> 'drive_file_id') from jsonb_array_elements(p_files) item) <> jsonb_array_length(p_files)
    then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  select connection_id into connected from private.catalog_sync_jobs where id = p_job;
  select count(*) into existing from jsonb_array_elements(p_files) item
    join public.team_materials m on m.connection_id = connected and m.drive_file_id = item ->> 'drive_file_id';
  affected := private.upsert_catalog_snapshot(connected, g.parent_folder_id, p_files, g.baseline_snapshot);
  insert into private.catalog_scan_seen(job_id, generation, parent_folder_id, drive_file_id, observed_version)
    select p_job, p_generation, g.parent_folder_id, item ->> 'drive_file_id', item ->> 'drive_version'
    from jsonb_array_elements(p_files) item on conflict do nothing;
  insert into private.catalog_scan_frontier(job_id, folder_id, parent_folder_id)
    select p_job, item ->> 'drive_file_id', g.parent_folder_id from jsonb_array_elements(p_files) item
    where item ->> 'kind' = 'folder' and item ->> 'name' <> '.soty'
    on conflict do nothing;
  update private.catalog_scan_generations set page_token = p_next_page_token,
    coverage = case when p_complete then 'complete' else 'unknown' end,
    state = case when p_complete then 'reconciling' else 'listing' end, updated_at = clock_timestamp()
    where id = p_generation;
  update private.catalog_scan_frontier set state = case when p_complete then 'reconciling' else 'listing' end
    where job_id = p_job and generation = p_generation;
  update private.catalog_sync_jobs set last_progress_at = clock_timestamp(), updated_at = clock_timestamp(),
    attempts = 0, last_error_code = null,
    files_listed = files_listed + jsonb_array_length(p_files),
    files_added = files_added + greatest(jsonb_array_length(p_files) - existing, 0),
    files_updated = files_updated + greatest(affected - greatest(jsonb_array_length(p_files) - existing, 0), 0)
    where id = p_job;
  return true;
end;
$$;

create or replace function public.service_resolve_catalog_candidate(
  p_job uuid, p_worker text, p_epoch bigint, p_generation uuid, p_file_id text,
  p_expected_revision bigint, p_outcome text, p_file jsonb default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare g private.catalog_scan_generations; connected uuid; material public.team_materials;
  resolution text := p_outcome;
begin
  if not private.lock_catalog_sync_lease(p_job, p_worker, p_epoch) then return false; end if;
  if p_outcome is null or p_outcome not in ('present', 'trashed', 'out_of_root', 'unavailable') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_outcome <> 'unavailable' and (jsonb_typeof(p_file) is distinct from 'object'
    or p_file ->> 'drive_file_id' is distinct from p_file_id
    or jsonb_typeof(p_file -> 'trashed') is distinct from 'boolean'
    or (p_file ->> 'trashed')::boolean <> (p_outcome = 'trashed')) then
    raise exception 'PROVIDER_PROOF_REQUIRED' using errcode = '22023';
  end if;
  -- A filtered/partial record must not consume a missing candidate as "present".
  if p_outcome = 'present' and (
    jsonb_typeof(p_file -> 'name') is distinct from 'string'
    or coalesce(length(p_file ->> 'name'), 0) not between 1 and 1024
    or jsonb_typeof(p_file -> 'kind') is distinct from 'string'
    or coalesce(p_file ->> 'kind', '') not in ('file', 'folder', 'shortcut')
    or jsonb_typeof(p_file -> 'parent_folder_id') is distinct from 'string'
    or coalesce(length(p_file ->> 'parent_folder_id'), 0) not between 1 and 1024
  ) then
    raise exception 'PROVIDER_PROOF_REQUIRED' using errcode = '22023';
  end if;
  select s.* into g from private.catalog_scan_generations s
    join private.catalog_scan_frontier f on f.job_id = s.job_id and f.generation = s.id
    where s.id = p_generation and s.job_id = p_job and s.state = 'reconciling' for update of s;
  if not found then return false; end if;
  select connection_id into connected from private.catalog_sync_jobs where id = p_job;
  select * into material from public.team_materials m
    where m.connection_id = connected and m.drive_file_id = p_file_id for update;
  if not found or material.catalog_mutation_xid is distinct from p_expected_revision
    or material.parent_folder_id is distinct from g.parent_folder_id
    or not pg_visible_in_snapshot(material.catalog_mutation_xid::text::xid8, g.baseline_snapshot) then
    resolution := 'superseded';
  elsif p_outcome = 'unavailable' then
    -- Permission loss / ambiguous 404 never authorize removal or cleanup.
    update private.catalog_scan_generations set coverage = 'permission_limited', updated_at = clock_timestamp()
      where id = p_generation;
    update private.catalog_sync_jobs set last_error_code = 'PERMISSION_DENIED' where id = p_job;
  elsif p_outcome = 'present' then
    perform private.upsert_catalog_snapshot(connected, null, jsonb_build_array(p_file), g.baseline_snapshot);
  else
    update public.team_materials set lifecycle = case when p_outcome = 'trashed' then 'trashed' else 'missing' end,
      missing_reason = case when p_outcome = 'out_of_root' then 'out_of_root' else null end,
      missing_at = case when p_outcome = 'out_of_root' then clock_timestamp() else null end,
      trashed_at = case when p_outcome = 'trashed' then clock_timestamp() else null end,
      updated_at = clock_timestamp() where id = material.id;
    insert into public.team_catalog_events(team_id, material_id, event_kind)
      values (material.team_id, material.id, 'tombstoned');
  end if;
  insert into private.catalog_scan_seen(job_id, generation, parent_folder_id, drive_file_id, resolution)
    values (p_job, p_generation, g.parent_folder_id, p_file_id, resolution) on conflict do nothing;
  update private.catalog_sync_jobs set last_progress_at = clock_timestamp(), updated_at = clock_timestamp(),
    attempts = 0,
    files_updated = files_updated + case when resolution = 'present' then 1 else 0 end,
    files_removed = files_removed + case when resolution in ('trashed', 'out_of_root') then 1 else 0 end,
    items_unavailable = items_unavailable + case when resolution = 'unavailable' then 1 else 0 end
    where id = p_job;
  return true;
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
    attempts = 0, folders_done = folders_done + 1 where id = p_job;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Requests: one row per click, idempotent by key.
-- ---------------------------------------------------------------------------
create function private.record_catalog_sync_request(
  p_team uuid, p_connection uuid, p_job uuid, p_actor uuid, p_scope text, p_key text, p_created_since timestamptz
) returns table(request_id uuid, outcome text)
language plpgsql security definer set search_path = '' as $$
declare created_at_job timestamptz; verdict text; rid uuid;
begin
  select j.created_at into created_at_job from private.catalog_sync_jobs j where j.id = p_job;
  -- created_at defaults to now(): a job inserted in this transaction equals the
  -- transaction's start, an older one is earlier.
  verdict := case when created_at_job >= p_created_since then 'created' else 'joined' end;
  insert into private.catalog_sync_requests(team_id, connection_id, job_id, requested_by, scope_folder_id, request_key, outcome)
    values (p_team, p_connection, p_job, p_actor, p_scope, p_key, verdict)
    returning id into rid;
  return query select rid, verdict;
end;
$$;
revoke all on function private.record_catalog_sync_request(uuid,uuid,uuid,uuid,text,text,timestamptz)
  from public, anon, authenticated, service_role;

create function public.request_team_folder_resync(p_team uuid, p_folder text, p_request_key text)
returns table(sync_job_id uuid, request_id uuid, outcome text, initial_sync_state text)
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); connected uuid; parent text; joined uuid; started timestamptz := now();
  known private.catalog_sync_requests;
begin
  if actor is null or coalesce(private.team_role(p_team, actor), '') not in ('owner', 'admin') then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if nullif(p_folder, '') is null or char_length(coalesce(p_request_key, '')) not between 8 and 128 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  -- The same key is the same click: a lost answer never becomes a twin.
  select r.* into known from private.catalog_sync_requests r
    where r.team_id = p_team and r.request_key = p_request_key;
  if found then
    return query select known.job_id, known.id, known.outcome, 'scanning'::text;
    return;
  end if;
  select c.id, m.parent_folder_id into connected, parent
    from public.team_drive_connections c join public.team_materials m
      on m.connection_id = c.id and m.team_id = c.team_id
      and m.drive_file_id = p_folder and m.kind = 'folder' and m.lifecycle = 'active'
    where c.team_id = p_team and c.state = 'connected';
  if connected is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  joined := private.join_catalog_subtree(connected, p_folder, parent, 'user_subtree');
  perform private.nudge_catalog_sync_feed(connected);
  return query select joined, r.request_id, r.outcome, 'scanning'::text
    from private.record_catalog_sync_request(p_team, connected, joined, actor, p_folder, p_request_key, started) r;
end;
$$;
revoke all on function public.request_team_folder_resync(uuid,text,text) from public, anon, service_role;
grant execute on function public.request_team_folder_resync(uuid,text,text) to authenticated;

-- The older web keeps its two-argument call; the request row is still written.
create or replace function public.request_team_folder_resync(p_team uuid, p_folder text)
returns table(sync_job_id uuid, initial_sync_state text)
language plpgsql security definer set search_path = '' as $$
begin
  return query select r.sync_job_id, r.initial_sync_state
    from public.request_team_folder_resync(p_team, p_folder, 'legacy-' || gen_random_uuid()::text) r;
end;
$$;

create function public.request_team_catalog_resync(p_team uuid, p_request_key text)
returns table(sync_job_id uuid, request_id uuid, outcome text, initial_sync_state text)
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); resolved_connection uuid; queued_job uuid; started timestamptz := now();
  known private.catalog_sync_requests;
begin
  if actor is null or not coalesce(private.team_role(p_team, actor) in ('owner', 'admin'), false) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if char_length(coalesce(p_request_key, '')) not between 8 and 128 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select r.* into known from private.catalog_sync_requests r
    where r.team_id = p_team and r.request_key = p_request_key;
  if found then
    return query select known.job_id, known.id, known.outcome, 'scanning'::text;
    return;
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
  return query select queued_job, r.request_id, r.outcome, 'scanning'::text
    from private.record_catalog_sync_request(p_team, resolved_connection, queued_job, actor, null, p_request_key, started) r;
end;
$$;
revoke all on function public.request_team_catalog_resync(uuid,text) from public, anon, service_role;
grant execute on function public.request_team_catalog_resync(uuid,text) to authenticated;

create or replace function public.request_team_catalog_resync(p_team uuid)
returns table(sync_job_id uuid, initial_sync_state text)
language plpgsql security definer set search_path = '' as $$
begin
  return query select r.sync_job_id, r.initial_sync_state
    from public.request_team_catalog_resync(p_team, 'legacy-' || gen_random_uuid()::text) r;
end;
$$;

create function public.find_team_folder_sync_request_by_key(p_team uuid, p_request_key text)
returns table(sync_job_id uuid, request_id uuid, state text)
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not coalesce(private.can(p_team, 'view', auth.uid()), false) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query select r.job_id, r.id, j.state from private.catalog_sync_requests r
    join private.catalog_sync_jobs j on j.id = r.job_id
    where r.team_id = p_team and r.request_key = p_request_key;
end;
$$;
revoke all on function public.find_team_folder_sync_request_by_key(uuid,text) from public, anon, service_role;
grant execute on function public.find_team_folder_sync_request_by_key(uuid,text) to authenticated;

-- ---------------------------------------------------------------------------
-- Stop: the request is detached; the job is canceled only when nobody else
-- needs it. The canonical feed is never canceled through a request.
-- ---------------------------------------------------------------------------
create function public.cancel_team_folder_sync(p_team uuid, p_request uuid)
returns table(job_state text, request_outcome text)
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); req private.catalog_sync_requests; job private.catalog_sync_jobs; others integer;
begin
  select r.* into req from private.catalog_sync_requests r where r.id = p_request and r.team_id = p_team for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if actor is null or (req.requested_by <> actor
    and coalesce(private.team_role(p_team, actor), '') not in ('owner', 'admin')) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select j.* into job from private.catalog_sync_jobs j where j.id = req.job_id for update;
  if req.detached_at is not null or job.state in ('succeeded', 'failed', 'canceled') then
    return query select job.state, req.outcome;
    return;
  end if;
  select count(*)::integer into others from private.catalog_sync_requests r
    where r.job_id = job.id and r.id <> req.id and r.detached_at is null;
  if job.job_kind = 'incremental' or others > 0 then
    update private.catalog_sync_requests set detached_at = clock_timestamp(), outcome = 'detached' where id = req.id;
    return query select job.state, 'detached'::text;
    return;
  end if;
  update private.catalog_sync_requests set detached_at = clock_timestamp(), outcome = 'canceled' where id = req.id;
  if job.state in ('pending', 'retry') then
    update private.catalog_sync_jobs set state = 'canceled', last_error_code = 'CANCELED_BY_USER',
      cancel_requested_at = clock_timestamp(), cancel_requested_by = actor,
      lease_owner = null, lease_expires_at = null, completed_at = clock_timestamp(), updated_at = clock_timestamp()
      where id = job.id;
    return query select 'canceled'::text, 'canceled'::text;
    return;
  end if;
  -- Leased: the worker's next fenced write is refused; the claim retires it.
  update private.catalog_sync_jobs set cancel_requested_at = clock_timestamp(), cancel_requested_by = actor,
    updated_at = clock_timestamp() where id = job.id;
  return query select 'canceling'::text, 'canceled'::text;
end;
$$;
revoke all on function public.cancel_team_folder_sync(uuid,uuid) from public, anon, service_role;
grant execute on function public.cancel_team_folder_sync(uuid,uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Replay writes fenced by the lease and counted on the job.
-- ---------------------------------------------------------------------------
create function public.service_upsert_catalog_page(
  p_job uuid, p_worker text, p_epoch bigint, p_connection uuid, p_parent_folder_id text, p_files jsonb
) returns integer language plpgsql security definer set search_path = '' as $$
declare existing bigint; affected integer;
begin
  if not private.lock_catalog_sync_lease(p_job, p_worker, p_epoch) then
    raise exception 'LEASE_LOST' using errcode = 'P0001';
  end if;
  select count(*) into existing from jsonb_array_elements(p_files) item
    join public.team_materials m on m.connection_id = p_connection and m.drive_file_id = item ->> 'drive_file_id';
  affected := public.service_upsert_catalog_page(p_connection, p_parent_folder_id, p_files);
  update private.catalog_sync_jobs set
    files_added = files_added + greatest(jsonb_array_length(p_files) - existing, 0),
    files_updated = files_updated + greatest(affected - greatest(jsonb_array_length(p_files) - existing, 0), 0),
    last_progress_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = p_job;
  return affected;
end;
$$;
revoke all on function public.service_upsert_catalog_page(uuid,text,bigint,uuid,text,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.service_upsert_catalog_page(uuid,text,bigint,uuid,text,jsonb) to service_role;

create function public.service_tombstone_catalog_files(
  p_job uuid, p_worker text, p_epoch bigint, p_connection uuid, p_items jsonb
) returns integer language plpgsql security definer set search_path = '' as $$
declare affected integer;
begin
  if not private.lock_catalog_sync_lease(p_job, p_worker, p_epoch) then
    raise exception 'LEASE_LOST' using errcode = 'P0001';
  end if;
  affected := public.service_tombstone_catalog_files(p_connection, p_items);
  update private.catalog_sync_jobs set files_removed = files_removed + affected,
    last_progress_at = clock_timestamp(), updated_at = clock_timestamp() where id = p_job;
  return affected;
end;
$$;
revoke all on function public.service_tombstone_catalog_files(uuid,text,bigint,uuid,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.service_tombstone_catalog_files(uuid,text,bigint,uuid,jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- One status for a folder and for the whole space: state, reason, result.
-- ---------------------------------------------------------------------------
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
    when job.state = 'leased' or job.replay_after is not null then 'running' else 'queued' end;
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

-- ---------------------------------------------------------------------------
-- The diagnostics view now shows requests and counters (same column list).
-- ---------------------------------------------------------------------------
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
