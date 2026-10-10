-- Feature 034 — a suspended space does no background work (plan R6–R8, US6.4, FR-009/FR-010).
--
-- Every claim that hands work to a worker skips spaces the gate closes. Nothing is deleted:
-- files, catalogs and re-stitched copies stay, and the catalog updater remembers each catalog's
-- interval in `paused_interval` until someone who manages the updater turns it back on. When a
-- space reopens it gets one Drive reconciliation.
--
-- Function bodies below are the latest definitions with the gate added; the comments mark the
-- added lines. Forward-only; reverse steps in ROLLBACK.md.

-- ---------------------------------------------------------------------------------------------
-- The updater keeps a paused catalog (R7).

create or replace function private.sync_catalog_updater(p_team uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  earliest timestamptz;
  preparing_one_off boolean;
begin
  -- 034: a catalog paused by its tariff is kept with its interval.
  delete from public.team_catalog_updater_items as item
  where item.team_id = p_team and item.update_interval is null and item.round_due_at is null
    and item.paused_interval is null;

  select min(item.next_run_at) into earliest
  from public.team_catalog_updater_items as item
  where item.team_id = p_team and item.update_interval is not null;

  select exists (
    select 1
    from public.team_catalog_updaters as updater
    join public.team_catalog_updater_items as item on item.team_id = updater.team_id
    where updater.team_id = p_team and updater.restitch
      and item.round_due_at is not null
  ) into preparing_one_off;

  update public.team_catalog_updaters as updater
     set state = case when earliest is null and not preparing_one_off then 'stopped' else 'running' end,
         next_run_at = earliest,
         started_at = case
           when earliest is null and not preparing_one_off then updater.started_at
           when updater.state <> 'running' then clock_timestamp()
           else updater.started_at
         end,
         started_by = case
           when (earliest is not null or preparing_one_off) and updater.state <> 'running'
             then auth.uid()
           else updater.started_by
         end,
         updated_by = coalesce(auth.uid(), updater.updated_by),
         updated_at = clock_timestamp()
   where updater.team_id = p_team;

  if exists (
    select 1 from public.team_catalog_updaters as updater
    where updater.team_id = p_team and updater.restitch and updater.state = 'running'
  ) then
    perform private.retire_restitch_spares(p_team, array(
      select item.catalog_material_id from public.team_catalog_updater_items as item
      where item.team_id = p_team
        and (item.update_interval is not null or item.round_due_at is not null
             or item.paused_interval is not null)
    ));
    perform private.queue_restitch_jobs(p_team);
  else
    -- 034: a paused catalog keeps its prepared spare for when the space reopens.
    perform private.retire_restitch_spares(p_team, array(
      select item.catalog_material_id from public.team_catalog_updater_items as item
      where item.team_id = p_team and item.paused_interval is not null
    ));
  end if;

  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (p_team, null, 'sync_state');
end;
$$;

create or replace function private.forget_unscheduled_catalog_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.round_due_at is null and new.update_interval is null and new.paused_interval is null then
    delete from public.team_catalog_updater_items
    where catalog_material_id = new.catalog_material_id;
    perform private.sync_catalog_updater(new.team_id);
  end if;
  return null;
end;
$$;

-- Moves every schedule of a closed space aside. p_team null = every closed space.
create function private.apply_tariff_pauses(p_team uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  paused integer := 0;
  closed record;
begin
  for closed in
    select distinct item.team_id
    from public.team_catalog_updater_items as item
    where (p_team is null or item.team_id = p_team)
      and (item.update_interval is not null or item.round_due_at is not null)
      and not private.team_workspace_allowed(item.team_id)
  loop
    perform 1 from public.team_catalog_updaters as updater
    where updater.team_id = closed.team_id for update;
    update public.team_catalog_updater_items as item
       set paused_interval = coalesce(item.update_interval, item.paused_interval),
           update_interval = null,
           next_run_at = null,
           round_due_at = null,
           attempts = 0,
           lease_owner = null,
           lease_expires_at = null,
           next_attempt_at = clock_timestamp()
     where item.team_id = closed.team_id
       and (item.update_interval is not null or item.round_due_at is not null);
    update public.team_catalog_updaters as updater
       set paused_by_tariff_at = coalesce(updater.paused_by_tariff_at, clock_timestamp())
     where updater.team_id = closed.team_id
       and exists (
         select 1 from public.team_catalog_updater_items as item
         where item.team_id = closed.team_id and item.paused_interval is not null
       );
    perform private.sync_catalog_updater(closed.team_id);
    paused := paused + 1;
  end loop;
  return paused;
end;
$$;

revoke all on function private.apply_tariff_pauses(uuid) from public, anon, authenticated;

-- Clears the space's "paused by tariff" mark once no catalog is held any more.
create function private.clear_tariff_pause_mark(p_team uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.team_catalog_updaters as updater
     set paused_by_tariff_at = null
   where updater.team_id = p_team
     and updater.paused_by_tariff_at is not null
     and not exists (
       select 1 from public.team_catalog_updater_items as item
       where item.team_id = p_team and item.paused_interval is not null
     );
$$;

revoke all on function private.clear_tariff_pause_mark(uuid) from public, anon, authenticated;

-- US6.6: back on by hand; every paused catalog resumes its interval and runs once now.
create function public.resume_team_catalog_updater(p_team uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  perform 1 from public.team_catalog_updaters where team_id = p_team for update;
  update public.team_catalog_updater_items as item
     set update_interval = item.paused_interval,
         next_run_at = clock_timestamp(),
         paused_interval = null
   where item.team_id = p_team and item.paused_interval is not null;
  update public.team_catalog_updaters
     set paused_by_tariff_at = null
   where team_id = p_team;
  perform private.sync_catalog_updater(p_team);
  return true;
end;
$$;

revoke all on function public.resume_team_catalog_updater(uuid) from public, anon;
grant execute on function public.resume_team_catalog_updater(uuid) to authenticated;

-- Choosing an interval (or none) for a paused catalog ends its pause.
create or replace function public.set_team_catalog_update_interval(
  p_team uuid, p_catalogs uuid[], p_interval text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  wanted uuid[];
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_interval is not null and private.catalog_updater_interval(p_interval) is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  wanted := private.checked_catalogs(p_team, p_catalogs);

  insert into public.team_catalog_updaters (team_id) values (p_team)
  on conflict (team_id) do nothing;
  perform 1 from public.team_catalog_updaters where team_id = p_team for update;

  if p_interval is null then
    update public.team_catalog_updater_items as item
       set update_interval = null, next_run_at = null, round_due_at = null,
           attempts = 0, lease_owner = null, lease_expires_at = null,
           next_attempt_at = clock_timestamp(),
           paused_interval = null -- 034
     where item.team_id = p_team and item.catalog_material_id = any(wanted);
  else
    insert into public.team_catalog_updater_items (
      catalog_material_id, team_id, update_interval, next_run_at
    )
    select catalog, p_team, p_interval,
           clock_timestamp() + private.catalog_updater_interval(p_interval)
    from unnest(wanted) as catalog
    on conflict (catalog_material_id) do update
      set update_interval = excluded.update_interval,
          next_run_at = case
            when public.team_catalog_updater_items.update_interval
                 is not distinct from excluded.update_interval
              then public.team_catalog_updater_items.next_run_at
            else excluded.next_run_at
          end,
          paused_interval = null; -- 034
    update public.team_catalog_updaters
       set update_interval = p_interval
     where team_id = p_team;
  end if;

  perform private.clear_tariff_pause_mark(p_team); -- 034
  perform private.sync_catalog_updater(p_team);
  return private.catalog_updater_state(p_team);
end;
$$;

-- "Update now" on a paused catalog brings its own schedule back with it.
create or replace function public.run_team_catalog_update_now(p_team uuid, p_catalogs uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  wanted uuid[];
  opened integer;
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  wanted := private.checked_catalogs(p_team, p_catalogs);

  insert into public.team_catalog_updaters (team_id) values (p_team)
  on conflict (team_id) do nothing;
  perform 1 from public.team_catalog_updaters where team_id = p_team for update;

  insert into public.team_catalog_updater_items (catalog_material_id, team_id)
  select catalog, p_team from unnest(wanted) as catalog
  on conflict (catalog_material_id) do nothing;

  -- 034: restore the remembered interval before the round opens.
  update public.team_catalog_updater_items as item
     set update_interval = item.paused_interval,
         next_run_at = clock_timestamp() + private.catalog_updater_interval(item.paused_interval),
         paused_interval = null
   where item.team_id = p_team
     and item.catalog_material_id = any(wanted)
     and item.paused_interval is not null;

  update public.team_catalog_updater_items as item
     set round_due_at = clock_timestamp(),
         next_attempt_at = clock_timestamp(),
         attempts = 0,
         next_run_at = case
           when item.update_interval is null then null
           else clock_timestamp() + private.catalog_updater_interval(item.update_interval)
         end
   where item.team_id = p_team
     and item.catalog_material_id = any(wanted)
     and item.round_due_at is null;
  get diagnostics opened = row_count;

  perform private.clear_tariff_pause_mark(p_team); -- 034
  perform private.sync_catalog_updater(p_team);
  return opened;
end;
$$;

create or replace function public.stop_team_catalog_updater(p_team uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.team_catalog_updater_items as item
     set update_interval = null, next_run_at = null, round_due_at = null,
         attempts = 0, lease_owner = null, lease_expires_at = null,
         next_attempt_at = clock_timestamp(),
         paused_interval = null -- 034
   where item.team_id = p_team;
  perform private.clear_tariff_pause_mark(p_team); -- 034
  perform private.sync_catalog_updater(p_team);
  return private.catalog_updater_state(p_team);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- R8 — a reopened space reconciles with Drive once.

create function private.resume_space_sync(p_team uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_connection uuid;
  queued_job uuid;
begin
  select connection.id into resolved_connection
  from public.team_drive_connections as connection
  where connection.team_id = p_team and connection.state = 'connected'
  order by connection.created_at desc
  limit 1;
  if resolved_connection is null then
    return null;
  end if;
  select job.id into queued_job
  from private.catalog_sync_jobs as job
  where job.connection_id = resolved_connection
    and job.job_kind in ('initial', 'reconcile')
    and job.requested_folder_id is null
    and job.state in ('pending', 'leased', 'retry')
  limit 1;
  if queued_job is not null then
    return queued_job;
  end if;
  begin
    queued_job := public.service_enqueue_catalog_reconciliation(resolved_connection);
  exception when others then
    -- Reopening a space never fails because a reconciliation could not be queued.
    return null;
  end;
  return queued_job;
end;
$$;

revoke all on function private.resume_space_sync(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- R6 — claims skip closed spaces.

create or replace function public.service_open_catalog_updater_rounds()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  opened integer := 0;
  due record;
begin
  for due in
    select distinct item.team_id
    from public.team_catalog_updater_items as item
    where item.update_interval is not null
      and item.next_run_at <= clock_timestamp()
      and item.round_due_at is null
      and private.team_workspace_allowed(item.team_id) -- 034
  loop
    perform 1 from public.team_catalog_updaters as updater
    where updater.team_id = due.team_id for update skip locked;
    if not found then continue; end if;
    update public.team_catalog_updater_items as item
       set round_due_at = clock_timestamp(),
           next_attempt_at = clock_timestamp(),
           next_run_at = clock_timestamp() + private.catalog_updater_interval(item.update_interval)
     where item.team_id = due.team_id
       and item.update_interval is not null
       and item.next_run_at <= clock_timestamp()
       and item.round_due_at is null;
    opened := opened + 1;
    update public.team_catalog_updaters as updater
       set next_run_at = (
             select min(item.next_run_at) from public.team_catalog_updater_items as item
             where item.team_id = due.team_id and item.update_interval is not null
           ),
           updated_at = clock_timestamp()
     where updater.team_id = due.team_id;
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    values (due.team_id, null, 'sync_state');
  end loop;
  return opened;
end;
$$;

create or replace function private.claim_catalog_updater_items(
  p_worker text, p_limit integer default 10, p_lease_seconds integer default 60
)
returns setof public.team_catalog_updater_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  slots integer;
  gone record;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(72301500) then return; end if;

  for gone in
    delete from public.team_catalog_updater_items as item
    where item.round_due_at is not null
      and not exists (
        select 1 from private.live_product_catalogs(item.team_id) as live
        where live.catalog_material_id = item.catalog_material_id
      )
    returning item.team_id, item.catalog_material_id
  loop
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    values (gone.team_id, gone.catalog_material_id, 'upserted');
    perform private.sync_catalog_updater(gone.team_id);
  end loop;

  select greatest(0, 12 - count(*)::integer) into slots
  from public.team_catalog_updater_items
  where lease_expires_at > clock_timestamp();
  if slots = 0 then return; end if;

  return query
  with candidates as (
    select item.catalog_material_id
    from public.team_catalog_updater_items as item
    left join public.team_catalog_updaters as updater on updater.team_id = item.team_id
    left join private.catalog_restitch_jobs as job
      on job.catalog_material_id = item.catalog_material_id
    where item.round_due_at is not null
      and item.next_attempt_at <= clock_timestamp()
      and (item.lease_expires_at is null or item.lease_expires_at <= clock_timestamp())
      and private.team_workspace_allowed(item.team_id) -- 034
      and (
        item.update_interval is not null
        or
        not coalesce(updater.restitch, false)
        or exists (
          select 1 from public.team_catalog_restitch_copies as copy
          where copy.catalog_material_id = item.catalog_material_id and copy.role = 'spare'
        )
        or (item.round_due_at <= clock_timestamp() - interval '30 minutes'
            and (job.catalog_material_id is null or job.state <> 'leased'
                 or job.lease_expires_at <= clock_timestamp()))
      )
    order by item.next_attempt_at, item.round_due_at
    for update of item skip locked
    limit least(greatest(p_limit, 1), slots)
  )
  update public.team_catalog_updater_items as item
     set lease_owner = p_worker,
         lease_expires_at = clock_timestamp()
           + make_interval(secs => least(greatest(p_lease_seconds, 10), 300)),
         next_attempt_at = clock_timestamp()
           + make_interval(secs => least(greatest(p_lease_seconds, 10), 300)),
         attempts = item.attempts + 1
    from candidates
   where item.catalog_material_id = candidates.catalog_material_id
  returning item.*;
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
  update private.catalog_sync_jobs
  set attempts = least(attempts + 1, 1000), lease_lost_count = lease_lost_count + 1,
    state = 'pending', lease_owner = null, lease_expires_at = null, updated_at = clock_timestamp()
  where state = 'leased' and lease_expires_at <= clock_timestamp();
  update private.catalog_sync_jobs
  set state = 'failed', last_error_code = 'LEASE_LOST_EXHAUSTED',
    completed_at = clock_timestamp(), updated_at = clock_timestamp()
  where state = 'pending' and job_kind <> 'incremental' and lease_lost_count > 0 and attempts >= 10;
  update private.catalog_sync_jobs set state = 'failed', lease_owner = null, lease_expires_at = null,
    last_error_code = 'RETRY_EXHAUSTED', completed_at = clock_timestamp()
  where attempts >= 1000 and state in ('pending', 'retry');
  update private.catalog_sync_jobs set state = 'failed', last_error_code = 'NO_PROGRESS',
    lease_owner = null, lease_expires_at = null, completed_at = clock_timestamp(), updated_at = clock_timestamp()
  where state in ('pending', 'retry') and job_kind <> 'incremental' and no_progress_runs >= 10;
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
        and private.team_workspace_allowed(c.team_id) -- 034
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
      and private.team_workspace_allowed(connection.team_id) -- 034
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

-- A closed space's waiting jobs are not timed out or re-fed; they wait for the space to reopen.
create or replace function private.sweep_catalog_sync_orphans(
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

  if remaining > 0 then
    with victims as (
      select j.id from private.catalog_sync_jobs j
      join public.team_drive_connections c on c.id = j.connection_id -- 034
      where j.replay_after is not null and j.state = 'pending'
        and coalesce(j.scan_completed_at, j.updated_at) < clock_timestamp() - interval '60 minutes'
        and private.team_workspace_allowed(c.team_id) -- 034
      limit remaining for update of j skip locked
    )
    update private.catalog_sync_jobs j set state = 'failed', last_error_code = 'REPLAY_TIMEOUT',
      completed_at = clock_timestamp(), updated_at = clock_timestamp()
    from victims v where j.id = v.id;
    get diagnostics removed = row_count;
    timeout_count := removed;
    remaining := remaining - removed;
  end if;

  if remaining > 0 then
    for orphan in
      select distinct j.connection_id from private.catalog_sync_jobs j
      join public.team_drive_connections c on c.id = j.connection_id
      where c.state <> 'detached' and j.replay_after is not null and j.state = 'pending'
        and private.team_workspace_allowed(c.team_id) -- 034
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

create or replace function public.service_claim_preview_warm(p_limit integer default 50)
returns table (
  material_id uuid,
  team_id uuid,
  connection_id uuid,
  credential_id uuid,
  drive_file_id text,
  resource_key text,
  drive_version text,
  mime_type text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return query
  with candidate as (
    select material.id
    from public.team_materials as material
    join public.team_drive_connections as connection on connection.id = material.connection_id
    left join public.team_materials as parent
      on parent.team_id = material.team_id
     and parent.connection_id = material.connection_id
     and parent.drive_file_id = material.parent_folder_id
     and parent.kind = 'folder'
    where material.lifecycle = 'active'
      and connection.state = 'connected'
      and private.team_workspace_allowed(connection.team_id) -- 034
      and (
        material.provider_thumbnail_state = 'pending'
        or (
          material.provider_thumbnail_state = 'unavailable'
          and material.provider_thumbnail_reason = 'provider_missing'
          and material.modified_at > clock_timestamp() - interval '24 hours'
          and material.provider_thumbnail_claimed_at < clock_timestamp() - interval '1 hour'
        )
      )
      and (
        material.provider_thumbnail_claimed_at is null
        or material.provider_thumbnail_claimed_at < clock_timestamp() - interval '10 minutes'
      )
      and (
        parent.folder_indexed_at is not null
        or material.parent_folder_id = connection.root_folder_id
      )
    order by coalesce(parent.folder_indexed_at, connection.connected_at), material.id
    for update of material skip locked
    limit p_limit
  )
  update public.team_materials as material
  set provider_thumbnail_claimed_at = clock_timestamp()
  from candidate, public.team_drive_connections as connection
  where material.id = candidate.id
    and connection.id = material.connection_id
  returning material.id, material.team_id, material.connection_id, connection.credential_id,
            material.drive_file_id, material.resource_key, material.drive_version, material.mime_type;
end;
$$;

create or replace function public.service_claim_archive_inspections(p_limit integer default 20)
returns table (
  material_id uuid,
  team_id uuid,
  credential_id uuid,
  drive_file_id text,
  resource_key text,
  drive_version text,
  checksum text,
  size_bytes bigint
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return query
  with candidate as (
    select material.id
    from public.team_materials as material
    join public.team_drive_connections as connection on connection.id = material.connection_id
    where material.kind = 'file'
      and material.category = 'archive'
      and material.landing_validation_state is null
      and material.lifecycle = 'active'
      and material.size_bytes is not null
      and material.size_bytes between 22 and 2147483647
      and connection.state = 'connected'
      and private.team_workspace_allowed(connection.team_id) -- 034
      and (
        material.landing_inspection_claimed_at is null
        or material.landing_inspection_claimed_at < clock_timestamp() - interval '10 minutes'
      )
    order by material.created_at, material.id
    for update of material skip locked
    limit p_limit
  )
  update public.team_materials as material
  set landing_inspection_claimed_at = clock_timestamp()
  from candidate, public.team_drive_connections as connection
  where material.id = candidate.id
    and connection.id = material.connection_id
  returning material.id, material.team_id, connection.credential_id, material.drive_file_id,
            material.resource_key, material.drive_version, material.checksum, material.size_bytes;
end;
$$;

create or replace function public.service_claim_retired_restitch_copies(p_limit integer default 10)
returns table (material_id uuid, team_id uuid, drive_file_id text, credential_id uuid)
language sql
security definer
set search_path = ''
as $$
  with due as (
    select copy.material_id
    from public.team_catalog_restitch_copies as copy
    where copy.role = 'retired' and copy.next_delete_at <= clock_timestamp()
      and private.team_workspace_allowed(copy.team_id) -- 034
    order by copy.next_delete_at
    for update of copy skip locked
    limit least(greatest(p_limit, 1), 50)
  ), leased as (
    update public.team_catalog_restitch_copies as copy
       set next_delete_at = clock_timestamp() + interval '5 minutes',
           delete_attempts = copy.delete_attempts + 1
      from due
     where copy.material_id = due.material_id
    returning copy.material_id, copy.team_id, copy.drive_file_id
  )
  select leased.material_id, leased.team_id, leased.drive_file_id, connection.credential_id
  from leased
  join public.team_materials as file on file.id = leased.material_id
  join public.team_drive_connections as connection on connection.id = file.connection_id;
$$;

create or replace function public.service_claim_orphan_cleanups(
  p_worker text, p_limit integer default 10, p_lease_seconds integer default 60
)
returns table (
  material_id uuid,
  team_id uuid,
  drive_file_id text,
  resource_key text,
  credential_id uuid,
  companion_kind text,
  name text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.queue_orphan_cleanups();
  return query
  with due as (
    select item.material_id
    from private.orphan_cleanups as item
    where (item.lease_owner is null or item.lease_expires_at < clock_timestamp())
      and item.attempts < 5
      and private.team_workspace_allowed(item.team_id) -- 034
    order by item.queued_at
    for update of item skip locked
    limit least(greatest(p_limit, 1), 50)
  ), leased as (
    update private.orphan_cleanups as item
       set lease_owner = p_worker,
           lease_expires_at = clock_timestamp()
             + make_interval(secs => least(greatest(p_lease_seconds, 10), 600)),
           attempts = item.attempts + 1
      from due
     where item.material_id = due.material_id
    returning item.material_id, item.team_id
  )
  select leased.material_id,
         leased.team_id,
         file.drive_file_id,
         file.resource_key,
         connection.credential_id,
         file.companion_kind,
         file.name
  from leased
  join public.team_materials as file on file.id = leased.material_id
  join public.team_drive_connections as connection on connection.id = file.connection_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Schedule: every ten minutes, closed spaces put their updater aside.

select cron.unschedule(job.jobid)
from cron.job as job
where job.jobname = 'wishly-tariff-pauses';

select cron.schedule(
  'wishly-tariff-pauses',
  '*/10 * * * *',
  $cron$select private.apply_tariff_pauses(null)$cron$
);
