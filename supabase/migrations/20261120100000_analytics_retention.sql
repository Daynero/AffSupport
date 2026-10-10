-- 031 — analytics retention (FR-057): detailed events live 90 days, daily
-- aggregates live forever, and an account deletion anonymises the row it
-- leaves behind.
--
-- Three pieces, in dependency order:
--
--   1. Two public aggregate tables the read-only CLI role may read:
--        analytics_daily_events(day, event_name, count, users)
--        analytics_daily_tool_outcomes(day, tool, local_app_version, platform,
--                                      starts, completions, failures,
--                                      cancellations, users)
--      plus a private ledger, analytics_daily_materialized(day), that records
--      which UTC days are final. A recorded day is never recomputed: once its
--      events are purged a recomputation would see an empty day and overwrite
--      the aggregate with zeros.
--
--   2. private.materialize_analytics_daily(day) upserts both tables from
--      public.analytics_events for one UTC day of `created_at` (server receipt
--      time, which a client cannot set, so a day that is in the past cannot
--      grow). private.purge_analytics_events(keep_days) materializes every
--      complete day older than the cutoff that is not yet recorded, then
--      deletes the events of recorded days. Retention is counted in whole UTC
--      days: a row is removed on the first run after the day it arrived is
--      more than keep_days days old, never earlier.
--
--   3. A BEFORE UPDATE trigger on analytics_events: when the FK on auth.users
--      sets user_id to null (on delete set null, 20260718211000), the same
--      write also nulls installation_id and session_id, so a deleted account
--      cannot be re-linked through either of its device/session keys.
--
-- Tool outcomes count lifecycle events only: `*_started`, `*_completed`,
-- `*_failed` and `operation_cancelled`, on rows that name a tool. Stage events
-- (`operation_stage_*`) are sub-steps of one operation and are excluded so one
-- run is not counted as several. Rows without a tool are not tool outcomes;
-- they are still counted per event name in analytics_daily_events. Nullable
-- dimensions become 'unknown' because they sit in the primary key.
--
-- `users` is count(distinct user_id); rows already anonymised count toward
-- `count`/`starts`/… but not toward `users`.

-- 1. Aggregate tables ----------------------------------------------------------

create table public.analytics_daily_events (
  day date not null,
  event_name text not null,
  count bigint not null default 0,
  users bigint not null default 0,
  primary key (day, event_name),
  constraint analytics_daily_events_nonnegative check (count >= 0 and users >= 0)
);

create table public.analytics_daily_tool_outcomes (
  day date not null,
  tool text not null,
  local_app_version text not null,
  platform text not null,
  starts bigint not null default 0,
  completions bigint not null default 0,
  failures bigint not null default 0,
  cancellations bigint not null default 0,
  users bigint not null default 0,
  primary key (day, tool, local_app_version, platform),
  constraint analytics_daily_tool_outcomes_nonnegative check (
    starts >= 0 and completions >= 0 and failures >= 0 and cancellations >= 0 and users >= 0
  )
);

create index analytics_daily_tool_outcomes_tool_day_idx
  on public.analytics_daily_tool_outcomes (tool, day desc);

create table private.analytics_daily_materialized (
  day date primary key,
  materialized_at timestamptz not null default now()
);

alter table public.analytics_daily_events enable row level security;
alter table public.analytics_daily_tool_outcomes enable row level security;
alter table private.analytics_daily_materialized enable row level security;

-- Supabase's default privileges hand anon/authenticated/service_role every new
-- public object; take that back before granting anything narrow.
revoke all on table public.analytics_daily_events from public, anon, authenticated, service_role;
revoke all on table public.analytics_daily_tool_outcomes
  from public, anon, authenticated, service_role;
revoke all on table private.analytics_daily_materialized
  from public, anon, authenticated, service_role;

-- Admin read, the same shape as analytics_admin_select on analytics_events.
grant select on table public.analytics_daily_events to authenticated;
grant select on table public.analytics_daily_tool_outcomes to authenticated;

create policy analytics_daily_events_admin_select
on public.analytics_daily_events
for select
to authenticated
using (public.is_admin());

create policy analytics_daily_tool_outcomes_admin_select
on public.analytics_daily_tool_outcomes
for select
to authenticated
using (public.is_admin());

-- Read-only CLI role: SELECT and nothing else, like analytics_readonly_select.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'wishly_analytics_ro') then
    grant select on table public.analytics_daily_events to wishly_analytics_ro;
    grant select on table public.analytics_daily_tool_outcomes to wishly_analytics_ro;
    execute $policy$
      create policy analytics_daily_events_readonly_select
      on public.analytics_daily_events
      for select
      to wishly_analytics_ro
      using (true)
    $policy$;
    execute $policy$
      create policy analytics_daily_tool_outcomes_readonly_select
      on public.analytics_daily_tool_outcomes
      for select
      to wishly_analytics_ro
      using (true)
    $policy$;
  end if;
end
$$;

comment on table public.analytics_daily_events is
  'Per UTC day and event name: row count and distinct signed-in users. Kept indefinitely; source rows are purged after 90 days.';
comment on table public.analytics_daily_tool_outcomes is
  'Per UTC day, tool, local app version and platform: *_started, *_completed, *_failed and operation_cancelled counts plus distinct users. Kept indefinitely.';
comment on table private.analytics_daily_materialized is
  'UTC days whose analytics_daily_* rows are final. A recorded day is never recomputed and its events may be purged.';

-- 2. Materialization and purge ------------------------------------------------

create function private.materialize_analytics_daily(p_day date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_today date := (pg_catalog.now() at time zone 'UTC')::date;
  v_event_rows integer := 0;
  v_outcome_rows integer := 0;
  v_recorded boolean := false;
begin
  if p_day is null then
    raise exception 'A day is required' using errcode = '22023';
  end if;

  -- A recorded day is final: its events may already be gone, and recomputing
  -- it from what is left would replace real counts with smaller ones.
  if exists (select 1 from private.analytics_daily_materialized m where m.day = p_day) then
    return pg_catalog.jsonb_build_object(
      'day', p_day, 'skipped', true, 'event_rows', 0, 'outcome_rows', 0, 'recorded', true);
  end if;

  v_start := (p_day::timestamp) at time zone 'UTC';
  v_end := ((p_day + 1)::timestamp) at time zone 'UTC';

  insert into public.analytics_daily_events (day, event_name, count, users)
  select
    p_day,
    e.event_name,
    count(*)::bigint,
    count(distinct e.user_id)::bigint
  from public.analytics_events as e
  where e.created_at >= v_start and e.created_at < v_end
  group by e.event_name
  on conflict (day, event_name) do update
    set count = excluded.count,
        users = excluded.users;
  get diagnostics v_event_rows = row_count;

  insert into public.analytics_daily_tool_outcomes (
    day, tool, local_app_version, platform,
    starts, completions, failures, cancellations, users
  )
  select
    p_day,
    e.tool,
    coalesce(e.local_app_version, e.agent_version, 'unknown'),
    coalesce(e.platform, 'unknown'),
    count(*) filter (where e.event_name ~ '_started$')::bigint,
    count(*) filter (where e.event_name ~ '_completed$')::bigint,
    count(*) filter (where e.event_name ~ '_failed$')::bigint,
    count(*) filter (where e.event_name = 'operation_cancelled')::bigint,
    count(distinct e.user_id)::bigint
  from public.analytics_events as e
  where e.created_at >= v_start and e.created_at < v_end
    and e.tool is not null
    and e.event_name !~ '^operation_stage_'
    and (
      e.event_name ~ '_(started|completed|failed)$'
      or e.event_name = 'operation_cancelled'
    )
  group by e.tool, coalesce(e.local_app_version, e.agent_version, 'unknown'),
    coalesce(e.platform, 'unknown')
  on conflict (day, tool, local_app_version, platform) do update
    set starts = excluded.starts,
        completions = excluded.completions,
        failures = excluded.failures,
        cancellations = excluded.cancellations,
        users = excluded.users;
  get diagnostics v_outcome_rows = row_count;

  -- Only a day that is over can be final; today is left open so a later run
  -- (or the purge, 90 days from now) still recomputes it in full.
  if p_day < v_today then
    insert into private.analytics_daily_materialized (day) values (p_day)
    on conflict (day) do nothing;
    v_recorded := true;
  end if;

  return pg_catalog.jsonb_build_object(
    'day', p_day,
    'skipped', false,
    'event_rows', v_event_rows,
    'outcome_rows', v_outcome_rows,
    'recorded', v_recorded);
end;
$$;

create function private.purge_analytics_events(p_keep_days integer default 90)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_keep integer := coalesce(p_keep_days, 90);
  v_cutoff_day date;
  v_cutoff timestamptz;
  v_day date;
  v_days integer := 0;
  v_deleted bigint := 0;
begin
  if v_keep < 1 then
    raise exception 'keep_days must be at least 1' using errcode = '22023';
  end if;

  -- Whole UTC days: the day the cutoff falls in is still kept in full.
  v_cutoff_day := ((pg_catalog.now() - pg_catalog.make_interval(days => v_keep))
    at time zone 'UTC')::date;
  v_cutoff := (v_cutoff_day::timestamp) at time zone 'UTC';

  -- Every complete day that still has events and is not yet final.
  for v_day in
    select distinct (e.created_at at time zone 'UTC')::date
    from public.analytics_events as e
    where e.created_at < v_cutoff
      and not exists (
        select 1 from private.analytics_daily_materialized m
        where m.day = (e.created_at at time zone 'UTC')::date
      )
    order by 1
  loop
    perform private.materialize_analytics_daily(v_day);
    v_days := v_days + 1;
  end loop;

  -- Delete only what has been counted. If a materialization above failed the
  -- whole call rolls back and nothing is lost.
  delete from public.analytics_events as e
  where e.created_at < v_cutoff
    and exists (
      select 1 from private.analytics_daily_materialized m
      where m.day = (e.created_at at time zone 'UTC')::date
    );
  get diagnostics v_deleted = row_count;

  return pg_catalog.jsonb_build_object(
    'keep_days', v_keep,
    'cutoff', v_cutoff,
    'materialized_days', v_days,
    'deleted_events', v_deleted);
end;
$$;

revoke all on function private.materialize_analytics_daily(date)
  from public, anon, authenticated, service_role;
revoke all on function private.purge_analytics_events(integer)
  from public, anon, authenticated, service_role;

comment on function private.materialize_analytics_daily(date) is
  'Upserts analytics_daily_* for one UTC day of analytics_events.created_at; records a past day as final; skips a day already final.';
comment on function private.purge_analytics_events(integer) is
  'Materializes every complete day older than keep_days that is not yet final, then deletes the events of final days. Returns counts.';

-- 3. Account deletion anonymises the row it leaves ----------------------------

-- The FK auth.users -> analytics_events.user_id is ON DELETE SET NULL; that
-- referential action is an ordinary UPDATE and fires this row trigger. Both
-- columns are uuid (session_id from 20260718211000, installation_id from
-- 20260720130000). ingest_analytics_events is untouched: it only inserts.
create function private.anonymise_analytics_event()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.installation_id := null;
  new.session_id := null;
  return new;
end;
$$;

revoke all on function private.anonymise_analytics_event()
  from public, anon, authenticated, service_role;

create trigger analytics_events_anonymise_on_user_null
before update of user_id on public.analytics_events
for each row
when (old.user_id is not null and new.user_id is null)
execute function private.anonymise_analytics_event();

comment on trigger analytics_events_anonymise_on_user_null on public.analytics_events is
  'Account deletion: when the FK nulls user_id, installation_id and session_id go with it.';

-- 4. Schedule --------------------------------------------------------------------

-- pg_cron is present on hosted Supabase (other workers already schedule through
-- it). Where it is absent (a bare local stack, PGlite) the block is skipped and
-- docs/SUPABASE_SETUP.md describes the manual call. A named schedule replaces
-- an existing job of the same name, so re-running is safe.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'analytics-retention',
      '15 3 * * *',
      $cron$select private.purge_analytics_events(90)$cron$
    );
  end if;
end
$$;

notify pgrst, 'reload schema';
