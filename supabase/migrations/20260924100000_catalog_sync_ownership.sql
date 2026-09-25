-- One cursor authority per connection; finite scans never become feed pollers.
alter table private.catalog_sync_jobs
  add column job_kind text,
  add column lease_epoch bigint not null default 0,
  add column run_count bigint not null default 0,
  add column last_progress_at timestamptz,
  add column replay_after bigint;
update private.catalog_sync_jobs set last_progress_at = updated_at;
alter table private.catalog_sync_jobs alter column last_progress_at set not null;
alter table private.catalog_sync_jobs drop constraint catalog_sync_jobs_state_check;
alter table private.catalog_sync_jobs add constraint catalog_sync_jobs_state_check
  check (state in ('pending', 'leased', 'retry', 'succeeded', 'failed', 'canceled'));
update private.catalog_sync_jobs set job_kind = case
  when requested_folder_id is not null then 'user_subtree'
  when phase = 'initial_scan' then 'initial'
  when phase = 'reconcile' then 'reconcile' else 'incremental' end;
alter table private.catalog_sync_jobs alter column job_kind set not null;
alter table private.catalog_sync_jobs add constraint catalog_sync_jobs_kind_check
  check (job_kind in ('incremental', 'initial', 'user_subtree', 'discovered_subtree', 'reconcile'));

create table private.catalog_sync_authority (
  connection_id uuid primary key references public.team_drive_connections(id) on delete cascade,
  lease_epoch bigint not null default 0 check (lease_epoch >= 0),
  confirmed_cursor text,
  confirmed_job_id uuid references private.catalog_sync_jobs(id) on delete restrict,
  confirmed_sequence bigint not null default 0 check (confirmed_sequence >= 0),
  confirmed_at timestamptz,
  bootstrap_required boolean not null default true,
  constraint catalog_sync_cursor_provenance check (
    (confirmed_cursor is null and confirmed_job_id is null and confirmed_at is null)
    or (confirmed_cursor is not null and confirmed_job_id is not null and confirmed_at is not null)
  )
);
alter table private.catalog_sync_authority enable row level security;
revoke all on private.catalog_sync_authority from public, anon, authenticated, service_role;

-- Historical connection/job tokens have no writer provenance. Never pick MAX,
-- lexicographic order, or the last updated job. Invalidate all old leases before
-- installing uniqueness, preserve the catalog, and queue a fresh bounded walk.
update private.catalog_sync_jobs set state = 'canceled', completed_at = clock_timestamp(),
  lease_owner = null, lease_expires_at = null, last_error_code = 'CURSOR_PROVENANCE_RESET'
where state in ('pending', 'leased', 'retry');
create unique index catalog_sync_one_canonical on private.catalog_sync_jobs(connection_id)
  where job_kind = 'incremental' and state in ('pending', 'leased', 'retry');

create function private.classify_catalog_sync_job()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.last_progress_at := coalesce(new.last_progress_at, new.updated_at);
  if new.job_kind is null then
    new.job_kind := case when new.requested_folder_id is not null then 'user_subtree'
      when new.phase = 'initial_scan' then 'initial'
      when new.phase = 'reconcile' then 'reconcile' else 'incremental' end;
  end if;
  return new;
end;
$$;
create trigger catalog_sync_classify before insert on private.catalog_sync_jobs
  for each row execute function private.classify_catalog_sync_job();

create function private.ensure_catalog_sync_authority()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into private.catalog_sync_authority(connection_id) values (new.connection_id)
    on conflict do nothing;
  perform 1 from private.catalog_sync_authority where connection_id = new.connection_id for update;
  if new.job_kind <> 'incremental' and new.state in ('pending', 'leased', 'retry') then
    insert into private.catalog_sync_jobs(connection_id, job_kind, phase, cursor, next_attempt_at)
    values (new.connection_id, 'incremental', 'incremental',
      jsonb_build_object('pageToken', new.cursor ->> 'changePageToken',
        'changePageToken', new.cursor ->> 'changePageToken'), clock_timestamp() + interval '1 minute')
    on conflict (connection_id) where job_kind = 'incremental' and state in ('pending', 'leased', 'retry')
      do nothing;
  elsif new.job_kind = 'incremental' and nullif(new.cursor ->> 'changePageToken', '') is not null then
    -- This is a bootstrap position, not a confirmed checkpoint.
    update private.catalog_sync_authority set bootstrap_required = false
      where connection_id = new.connection_id and confirmed_cursor is null;
  end if;
  return new;
end;
$$;
create trigger catalog_sync_ensure_authority after insert on private.catalog_sync_jobs
  for each row execute function private.ensure_catalog_sync_authority();

insert into private.catalog_sync_jobs(connection_id, job_kind, phase, folder_queue, cursor)
select c.id, 'reconcile', 'initial_scan', jsonb_build_array(c.root_folder_id) || coalesce((
  select jsonb_agg(s.drive_folder_id order by s.selected_at) from public.team_drive_selections s
  where s.connection_id = c.id and s.state = 'active' and not s.is_root), '[]'::jsonb), '{}'::jsonb
from public.team_drive_connections c where c.state <> 'detached';
update public.team_drive_connections set initial_sync_state = 'scanning', updated_at = clock_timestamp()
where state <> 'detached';

-- Lock the connection authority before the job in every mutation transaction.
-- A successful check holds the fence until the caller's transaction commits.
create function private.lock_catalog_sync_lease(p_job uuid, p_worker text, p_epoch bigint)
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
  into valid from private.catalog_sync_jobs j
  join public.team_drive_connections c on c.id = j.connection_id
  where j.id = p_job for update of j;
  return coalesce(valid, false);
end;
$$;
revoke all on function private.lock_catalog_sync_lease(uuid, text, bigint) from public, anon, authenticated, service_role;
revoke all on function private.classify_catalog_sync_job() from public, anon, authenticated, service_role;
revoke all on function private.ensure_catalog_sync_authority() from public, anon, authenticated, service_role;

create or replace function private.claim_catalog_sync_jobs(
  p_worker text, p_limit integer default 5, p_lease_seconds integer default 60
)
returns setof private.catalog_sync_jobs language plpgsql security definer set search_path = '' as $$
declare slots integer; candidate record; epoch bigint;
begin
  if nullif(p_worker, '') is null then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  if not pg_try_advisory_xact_lock(71101400) then return; end if;
  update private.catalog_sync_jobs set state = 'failed', lease_owner = null, lease_expires_at = null,
    last_error_code = 'RETRY_EXHAUSTED', completed_at = clock_timestamp()
  where attempts >= 1000 and (state in ('pending', 'retry')
    or (state = 'leased' and lease_expires_at <= clock_timestamp()));
  select greatest(0, 3 - count(*)::integer) into slots from private.catalog_sync_jobs
    where state = 'leased' and lease_expires_at > clock_timestamp();
  for candidate in
    select ranked.id, ranked.connection_id from (
      select j.id, j.connection_id, j.next_attempt_at, j.created_at,
        row_number() over (partition by j.connection_id order by j.next_attempt_at, j.created_at, j.id) as rank
      from private.catalog_sync_jobs j
      join public.team_drive_connections c on c.id = j.connection_id
      where c.state <> 'detached' and j.replay_after is null
        and j.next_attempt_at <= clock_timestamp()
        and (j.state in ('pending', 'retry') or (j.state = 'leased' and j.lease_expires_at <= clock_timestamp()))
        and not exists (select 1 from private.catalog_sync_jobs busy
          where busy.connection_id = j.connection_id and busy.state = 'leased'
            and busy.lease_expires_at > clock_timestamp())
    ) ranked where ranked.rank = 1
    order by ranked.next_attempt_at, ranked.created_at, ranked.id
    limit least(greatest(p_limit, 1), slots)
  loop
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
      updated_at = clock_timestamp(), last_error_code = null
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
      last_error_code = null, updated_at = clock_timestamp(), last_progress_at = clock_timestamp() where id = p_job;
    update private.catalog_sync_jobs set next_attempt_at = least(next_attempt_at, clock_timestamp())
      where connection_id = job.connection_id and job_kind = 'incremental' and state = 'pending';
  end if;
  insert into public.team_catalog_events(team_id, material_id, event_kind) values (resolved_team, null, 'sync_state');
  return true;
end;
$$;

-- A stale failure must not overwrite the new worker's state or the connection's health.
create or replace function public.service_retry_catalog_sync_job(
  p_job uuid, p_worker text, p_error_code text, p_next_attempt_at timestamptz, p_permanent boolean default false
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare job private.catalog_sync_jobs; terminal boolean;
begin
  select * into job from private.catalog_sync_jobs where id = p_job;
  if not private.lock_catalog_sync_lease(p_job, p_worker, job.lease_epoch) then return false; end if;
  terminal := p_permanent or job.attempts + 1 >= 10;
  update private.catalog_sync_jobs set state = case when terminal then 'failed' else 'retry' end,
    attempts = least(attempts + 1, 1000), last_error_code = left(coalesce(p_error_code, 'DRIVE_UNAVAILABLE'), 96),
    next_attempt_at = coalesce(p_next_attempt_at, clock_timestamp() + interval '1 minute'),
    lease_owner = null, lease_expires_at = null,
    completed_at = case when terminal then clock_timestamp() else null end, updated_at = clock_timestamp()
    where id = p_job;
  if terminal and job.job_kind = 'incremental' then
    update public.team_drive_connections set initial_sync_state = 'failed',
      last_error_code = left(p_error_code, 96), updated_at = clock_timestamp() where id = job.connection_id;
  end if;
  return true;
end;
$$;

-- The new worker receives the fence explicitly. Keep the old return type for
-- rollback, but do not let an old worker acquire work after rollout.
create function public.service_claim_catalog_sync_work(
  p_worker text, p_limit integer default 1, p_lease_seconds integer default 180
)
returns table(job_id uuid, connection_id uuid, phase text, cursor jsonb, folder_queue jsonb,
  attempts integer, team_id uuid, credential_id uuid, root_folder_id text,
  root_resource_key text, drive_id text, drive_kind text, job_kind text,
  lease_epoch bigint, bootstrap_required boolean)
language sql security definer set search_path = '' as $$
  select j.id, j.connection_id, j.phase, j.cursor, j.folder_queue, j.attempts,
    c.team_id, c.credential_id, c.root_folder_id, c.root_resource_key, c.drive_id, c.drive_kind,
    j.job_kind, j.lease_epoch, a.bootstrap_required
  from private.claim_catalog_sync_jobs(p_worker, p_limit, p_lease_seconds) j
  join public.team_drive_connections c on c.id = j.connection_id
  join private.catalog_sync_authority a on a.connection_id = j.connection_id;
$$;
revoke all on function public.service_claim_catalog_sync_work(text, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.service_claim_catalog_sync_work(text, integer, integer) to service_role;
revoke execute on function public.service_claim_catalog_sync_jobs(text, integer, integer) from service_role;

-- A fresh provider position is captured BEFORE the recovery walk. This is not a
-- confirmed success; only replay's final page may publish a confirmed cursor.
create function public.service_bootstrap_catalog_sync(p_job uuid, p_worker text, p_epoch bigint, p_token text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare connected uuid;
begin
  if not private.lock_catalog_sync_lease(p_job, p_worker, p_epoch) then return false; end if;
  if nullif(p_token, '') is null then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  select connection_id into connected from private.catalog_sync_jobs where id = p_job;
  update private.catalog_sync_authority set bootstrap_required = false
    where connection_id = connected and bootstrap_required;
  if not found then return false; end if;
  update private.catalog_sync_jobs set cursor = cursor || jsonb_build_object('changePageToken', p_token,
    'pageToken', case when job_kind = 'incremental' then p_token else cursor ->> 'pageToken' end)
    where connection_id = connected and state in ('pending', 'leased', 'retry');
  return true;
end;
$$;
revoke all on function public.service_bootstrap_catalog_sync(uuid, text, bigint, text) from public, anon, authenticated, service_role;
grant execute on function public.service_bootstrap_catalog_sync(uuid, text, bigint, text) to service_role;

-- Explicit epochs on the active worker's lifecycle RPCs. Legacy signatures are
-- retained for rollback/owner-internal calls, never as a service-role bypass.
create function public.service_save_catalog_sync_progress(
  p_job uuid, p_worker text, p_epoch bigint, p_phase text, p_page_token text,
  p_change_token text, p_folder_queue jsonb, p_discovered_folders jsonb default '[]'::jsonb
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not private.lock_catalog_sync_lease(p_job, p_worker, p_epoch) then return false; end if;
  if not public.service_save_catalog_sync_progress(p_job, p_worker, p_phase, p_page_token,
    p_change_token, p_folder_queue, p_discovered_folders) then return false; end if;
  update private.catalog_sync_jobs set last_progress_at = clock_timestamp() where id = p_job;
  return true;
end;
$$;
create function public.service_release_catalog_sync_job(p_job uuid, p_worker text, p_epoch bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not private.lock_catalog_sync_lease(p_job, p_worker, p_epoch) then return false; end if;
  return public.service_release_catalog_sync_job(p_job, p_worker);
end;
$$;
create function public.service_complete_catalog_sync_job(
  p_job uuid, p_worker text, p_epoch bigint, p_change_token text, p_next_phase text default 'incremental'
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not private.lock_catalog_sync_lease(p_job, p_worker, p_epoch) then return false; end if;
  return public.service_complete_catalog_sync_job(p_job, p_worker, p_change_token, p_next_phase);
end;
$$;
create function public.service_retry_catalog_sync_job(
  p_job uuid, p_worker text, p_epoch bigint, p_error_code text, p_next_attempt_at timestamptz,
  p_permanent boolean default false
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not private.lock_catalog_sync_lease(p_job, p_worker, p_epoch) then return false; end if;
  return public.service_retry_catalog_sync_job(p_job, p_worker, p_error_code, p_next_attempt_at, p_permanent);
end;
$$;
revoke all on function public.service_save_catalog_sync_progress(uuid,text,bigint,text,text,text,jsonb,jsonb),
  public.service_release_catalog_sync_job(uuid,text,bigint),
  public.service_complete_catalog_sync_job(uuid,text,bigint,text,text),
  public.service_retry_catalog_sync_job(uuid,text,bigint,text,timestamptz,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.service_save_catalog_sync_progress(uuid,text,bigint,text,text,text,jsonb,jsonb),
  public.service_release_catalog_sync_job(uuid,text,bigint),
  public.service_complete_catalog_sync_job(uuid,text,bigint,text,text),
  public.service_retry_catalog_sync_job(uuid,text,bigint,text,timestamptz,boolean) to service_role;
revoke execute on function public.service_save_catalog_sync_progress(uuid,text,text,text,text,jsonb,jsonb),
  public.service_release_catalog_sync_job(uuid,text),
  public.service_complete_catalog_sync_job(uuid,text,text,text),
  public.service_retry_catalog_sync_job(uuid,text,text,timestamptz,boolean),
  public.service_checkpoint_catalog_sync_job(uuid,text,text,text,text,jsonb,jsonb),
  public.service_checkpoint_initial_sync(uuid,text,jsonb,text),
  public.service_begin_change_replay(uuid,uuid) from service_role;

-- Backfill cancellation must be terminal for the existing browser projection,
-- not an infinite "running" until the UI adopts the richer status contract.
create or replace function public.get_team_folder_resync_status(p_team uuid, p_job uuid)
returns table(status text) language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not coalesce(private.can(p_team, 'view', auth.uid()), false) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query select case when c.state = 'detached' or j.state in ('failed', 'canceled') then 'failed'
    when j.state = 'succeeded' then 'succeeded' else 'running' end
  from private.catalog_sync_jobs j join public.team_drive_connections c on c.id = j.connection_id
  where j.id = p_job and c.team_id = p_team and j.requested_folder_id is not null;
end;
$$;

-- Preserve existing health semantics when a separate canonical job is added.
create or replace function public.get_team_storage_health(p_team uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  connection record;
  waiting_since timestamptz;
  live_job boolean;
  warm_active boolean;
  render_active boolean;
  folder_total integer;
  folder_unindexed integer;
  file_total integer;
  thumbs_pending integer;
  thumbs_ready integer;
  renders_pending integer;
  scanning boolean;
  -- How long a missing preview can still honestly be called "preparing".
  preview_window constant interval := interval '24 hours';
  -- The warm pass claims a row at most ten minutes apart, so a claim inside
  -- this window is proof it is running.
  warm_liveness constant interval := interval '15 minutes';
  -- The agent's watchdog is three minutes; `list_landing_renders` already reads
  -- anything older than four as a failed render.
  render_liveness constant interval := interval '4 minutes';
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  select drive.id, drive.state, drive.initial_sync_state, drive.last_error_code,
         drive.last_reconciled_at, drive.last_synced_at, drive.connected_at
    into connection
  from public.team_drive_connections as drive
  where drive.team_id = p_team and drive.state <> 'detached'
  order by drive.connected_at desc nulls last
  limit 1;

  if connection.id is null or connection.state in ('pending', 'unavailable') then
    return jsonb_build_object('kind', 'disconnected');
  end if;
  if connection.state = 'needs_reauth' then
    return jsonb_build_object('kind', 'attention', 'reason', 'needs_reauth', 'fixer', 'owner');
  end if;
  if connection.state = 'root_missing' then
    return jsonb_build_object('kind', 'attention', 'reason', 'root_missing', 'fixer', 'owner');
  end if;
  if connection.last_error_code in ('PERMISSION_DENIED', 'ROOT_ESCAPE') then
    return jsonb_build_object('kind', 'attention', 'reason', 'permission_lost', 'fixer', 'owner');
  end if;
  if connection.initial_sync_state = 'failed' then
    return jsonb_build_object('kind', 'attention', 'reason', 'sync_failed', 'fixer', 'manager');
  end if;

  -- The provider pushed back within the last ten minutes: a pause, not a failure.
  select min(job.updated_at) into waiting_since
  from private.catalog_sync_jobs as job
  where job.connection_id = connection.id
    and job.state = 'retry'
    and job.last_error_code in ('RATE_LIMITED', 'DRIVE_UNAVAILABLE')
    and job.updated_at > clock_timestamp() - interval '10 minutes';
  if waiting_since is not null then
    return jsonb_build_object('kind', 'waiting_provider', 'since', waiting_since);
  end if;

  select count(*) filter (where material.kind = 'folder')::integer,
         count(*) filter (where material.kind = 'folder' and material.folder_indexed_at is null)::integer,
         count(*) filter (where material.kind <> 'folder')::integer,
         count(*) filter (
           where material.provider_thumbnail_state = 'pending'
             and coalesce(material.modified_at, material.created_at)
                 > clock_timestamp() - preview_window
         )::integer,
         count(*) filter (where material.provider_thumbnail_state = 'ready')::integer,
         -- Is anything actually warming previews right now? Either the pass has
         -- claimed a row recently, or a file arrived before its first claim was
         -- due. Without one of those, `pending` means "Drive never made one".
         bool_or(
           material.provider_thumbnail_state = 'pending'
           and (
             material.provider_thumbnail_claimed_at > clock_timestamp() - warm_liveness
             or coalesce(material.created_at, material.modified_at)
                > clock_timestamp() - warm_liveness
           )
         )
    into folder_total, folder_unindexed, file_total, thumbs_pending, thumbs_ready, warm_active
  from public.team_materials as material
  where material.team_id = p_team
    and material.connection_id = connection.id
    and material.lifecycle = 'active';

  scanning := connection.initial_sync_state in ('not_started', 'scanning', 'replaying')
              or folder_unindexed > 0;

  if scanning then
    -- Confirmed scan progress, not the age of an unrelated feed claim.
    select exists (
      select 1
      from private.catalog_sync_jobs as job
      where job.connection_id = connection.id
        and job.state in ('pending', 'leased', 'retry')
        -- A fresh feed claim cannot hide a stalled finite traversal.
        and (job.job_kind <> 'incremental' or not exists (
          select 1 from private.catalog_sync_jobs finite
          where finite.connection_id = connection.id and finite.job_kind <> 'incremental'
            and finite.state in ('pending', 'leased', 'retry')
        ))
        and job.attempts < 10
        -- Claims and failed retries are not confirmed progress.
        and job.last_progress_at > clock_timestamp() - interval '15 minutes'
    ) into live_job;

    if not live_job then
      return jsonb_build_object('kind', 'attention', 'reason', 'sync_failed', 'fixer', 'manager');
    end if;

    return jsonb_build_object(
      'kind', 'indexing',
      'indexedFolders', folder_total - folder_unindexed,
      'totalFolders', case when connection.initial_sync_state = 'scanning' then null else folder_total end,
      'files', file_total
    );
  end if;

  -- A render pass is live when one of its rows was touched inside the watchdog
  -- window. Outside it, `rendering` is a render that stopped and `stale` is a
  -- queue nobody is working through — neither is progress to report.
  select exists (
    select 1
    from public.team_landing_renders as render
    join public.team_materials as material
      on material.id = render.material_id and material.team_id = render.team_id
    where render.team_id = p_team
      and material.lifecycle = 'active'
      and render.render_state = 'rendering'
      and render.updated_at > clock_timestamp() - render_liveness
  ) into render_active;

  renders_pending := 0;
  if render_active then
    select count(*)::integer into renders_pending
    from public.team_landing_renders as render
    join public.team_materials as material
      on material.id = render.material_id and material.team_id = render.team_id
    where render.team_id = p_team
      and material.lifecycle = 'active'
      and render.render_state in ('rendering', 'stale')
      and render.updated_at > clock_timestamp() - preview_window;
  end if;

  if not coalesce(warm_active, false) then
    thumbs_pending := 0;
  end if;

  if thumbs_pending + renders_pending > 0 then
    return jsonb_build_object(
      'kind', 'preparing',
      'ready', thumbs_ready,
      'pending', thumbs_pending + renders_pending
    );
  end if;

  return jsonb_build_object(
    'kind', 'connected',
    'lastReconciledAt', coalesce(
      connection.last_reconciled_at, connection.last_synced_at, connection.connected_at, clock_timestamp()
    )
  );
end;
$function$;

revoke all on function public.get_team_storage_health(uuid) from public, anon;
grant execute on function public.get_team_storage_health(uuid) to authenticated;

notify pgrst, 'reload schema';
