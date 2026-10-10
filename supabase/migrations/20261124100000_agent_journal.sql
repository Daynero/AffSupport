-- 033 — the agent's diagnostic journal reaches the database (US2, FR-001,
-- FR-002, FR-004, FR-011).
--
-- The agent keeps a bounded local journal of categories and codes
-- (apps/agent/src/server/diagnostics-log.ts). The web reads it page by page
-- from `/api/diagnostics?since=` and forwards it here, so an investigation no
-- longer needs the user to copy a support bundle.
--
-- Three pieces:
--
--   1. public.agent_journal_records — one row per journal record, unique per
--      (agent_instance_id, seq). Nobody inserts directly: RLS is on, every
--      grant is revoked, admins and the read-only CLI role may select.
--
--   2. public.ingest_agent_journal(installation, instance, records) — the only
--      way in. It repeats the agent's privacy fence on the server, because the
--      browser that forwards the records is not trusted: a record whose
--      category, code, time or properties fall outside the fence is refused
--      with a short reason and nothing of it is stored. A record already
--      stored is a no-op. The category list below is a verbatim copy of
--      DIAGNOSTIC_CATEGORIES (packages/shared/src/types.ts);
--      tests/agent-journal-ingest.test.ts fails when the two drift.
--
--   3. private.purge_analytics_events — the 031 daily retention job — also
--      deletes journal records recorded more than 30 days ago. Its signature
--      and its analytics behaviour are unchanged.

-- 1. Table ---------------------------------------------------------------------

create table public.agent_journal_records (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users (id) on delete cascade,
  installation_id uuid,
  agent_instance_id uuid not null,
  seq bigint not null check (seq > 0),
  recorded_at timestamptz not null,
  received_at timestamptz not null default now(),
  category text not null,
  code text not null,
  props jsonb not null default '{}'::jsonb,
  constraint agent_journal_records_instance_seq_key unique (agent_instance_id, seq)
);

create index agent_journal_records_user_recorded_idx
  on public.agent_journal_records (user_id, recorded_at desc);
create index agent_journal_records_installation_recorded_idx
  on public.agent_journal_records (installation_id, recorded_at desc);
create index agent_journal_records_instance_seq_idx
  on public.agent_journal_records (agent_instance_id, seq);

alter table public.agent_journal_records enable row level security;

-- Supabase's default privileges hand anon/authenticated/service_role every new
-- public object; take that back before granting anything narrow.
revoke all on table public.agent_journal_records from public, anon, authenticated, service_role;

-- Admin read, the same shape as analytics_admin_select on analytics_events.
grant select on table public.agent_journal_records to authenticated;

create policy agent_journal_records_admin_select
on public.agent_journal_records
for select
to authenticated
using (public.is_admin());

-- Read-only CLI role: SELECT and nothing else, like analytics_readonly_select.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'wishly_analytics_ro') then
    grant select on table public.agent_journal_records to wishly_analytics_ro;
    execute $policy$
      create policy agent_journal_records_readonly_select
      on public.agent_journal_records
      for select
      to wishly_analytics_ro
      using (true)
    $policy$;
  end if;
end
$$;

comment on table public.agent_journal_records is
  'The agent''s diagnostic journal (categories, codes, closed-vocabulary props), forwarded by the web through ingest_agent_journal. Kept 30 days.';

-- 2. Ingestion -----------------------------------------------------------------

create function public.ingest_agent_journal(
  p_installation_id uuid,
  p_agent_instance_id uuid,
  p_records jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_item jsonb;
  v_seq bigint;
  v_number numeric;
  v_recorded_at timestamptz;
  v_category text;
  v_code text;
  v_props jsonb;
  v_reason text;
  v_prop record;
  v_text text;
  v_inserted integer;
  v_accepted integer := 0;
  v_duplicates integer := 0;
  v_rejected jsonb := '[]'::jsonb;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_agent_instance_id is null then
    raise exception 'An agent instance is required' using errcode = '22023';
  end if;
  if p_records is null or pg_catalog.jsonb_typeof(p_records) <> 'array'
    or pg_catalog.jsonb_array_length(p_records) > 200 then
    raise exception 'Expected at most 200 records' using errcode = '22023';
  end if;

  for v_item in select value from pg_catalog.jsonb_array_elements(p_records)
  loop
    v_reason := null;
    v_seq := null;
    v_recorded_at := null;

    if pg_catalog.jsonb_typeof(v_item) <> 'object' then
      v_reason := 'invalid_record';
    end if;

    -- seq: a positive integer that fits a bigint. Nested so no cast ever
    -- sees a value whose type was not checked first.
    if v_reason is null then
      v_reason := 'invalid_seq';
      if pg_catalog.jsonb_typeof(v_item -> 'seq') = 'number' then
        v_number := (v_item ->> 'seq')::numeric;
        if v_number > 0 and v_number = pg_catalog.trunc(v_number)
          and v_number <= 9223372036854775807 then
          v_seq := v_number::bigint;
          v_reason := null;
        end if;
      end if;
    end if;

    -- at: epoch milliseconds, and not more than one day ahead of this clock.
    if v_reason is null then
      v_reason := 'invalid_time';
      if pg_catalog.jsonb_typeof(v_item -> 'at') = 'number' then
        v_number := (v_item ->> 'at')::numeric;
        if v_number > 0 and v_number < 253402300800000 then
          v_recorded_at := pg_catalog.to_timestamp((v_number / 1000)::double precision);
          v_reason := case when v_recorded_at > pg_catalog.now() + interval '1 day'
            then 'future_time' else null end;
        end if;
      end if;
    end if;

    -- category: DIAGNOSTIC_CATEGORIES, verbatim.
    if v_reason is null then
      v_category := case when pg_catalog.jsonb_typeof(v_item -> 'category') = 'string'
        then v_item ->> 'category' else null end;
      if v_category is null or v_category not in (
        'boot',
        'shutdown',
        'stream',
        'auth',
        'entitlement',
        'spawn',
        'picker',
        'drop',
        'update',
        'power',
        'team'
      ) then
        v_reason := 'invalid_category';
      end if;
    end if;

    if v_reason is null then
      v_code := case when pg_catalog.jsonb_typeof(v_item -> 'code') = 'string'
        then v_item ->> 'code' else null end;
      if v_code is null or v_code !~ '^[a-z][a-z0-9_]{1,63}$' then
        v_reason := 'invalid_code';
      end if;
    end if;

    -- props: an object of at most 16 safe keys; every value a number, a
    -- boolean, or a short vocabulary word that cannot be a path, a URL, an
    -- address or a credential.
    if v_reason is null then
      v_props := coalesce(v_item -> 'props', '{}'::jsonb);
      if pg_catalog.jsonb_typeof(v_props) = 'null' then
        v_props := '{}'::jsonb;
      end if;
      if pg_catalog.jsonb_typeof(v_props) <> 'object' then
        v_reason := 'invalid_props';
      elsif (select count(*) from pg_catalog.jsonb_object_keys(v_props)) > 16 then
        v_reason := 'too_many_props';
      else
        for v_prop in select key, value from pg_catalog.jsonb_each(v_props)
        loop
          if v_prop.key !~ '^[a-zA-Z][a-zA-Z0-9_]{0,31}$' then
            v_reason := 'invalid_prop_key';
          elsif pg_catalog.jsonb_typeof(v_prop.value) in ('number', 'boolean') then
            null;
          elsif pg_catalog.jsonb_typeof(v_prop.value) = 'string' then
            v_text := pg_catalog.lower(v_prop.value #>> '{}');
            if pg_catalog.length(v_text) < 1 or pg_catalog.length(v_text) > 64 then
              v_reason := 'invalid_prop_value';
            elsif pg_catalog.strpos(v_text, '/') > 0
              or pg_catalog.strpos(v_text, '\') > 0
              or pg_catalog.strpos(v_text, '://') > 0
              or pg_catalog.strpos(v_text, 'token') > 0
              or pg_catalog.strpos(v_text, 'bearer') > 0
              or pg_catalog.strpos(v_text, '@') > 0 then
              v_reason := 'unsafe_prop_value';
            end if;
          else
            v_reason := 'invalid_prop_value';
          end if;
          exit when v_reason is not null;
        end loop;
      end if;
    end if;

    if v_reason is not null then
      v_rejected := v_rejected || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('seq', v_seq, 'reason', v_reason));
      continue;
    end if;

    insert into public.agent_journal_records (
      user_id, installation_id, agent_instance_id, seq, recorded_at, category, code, props
    ) values (
      v_user, p_installation_id, p_agent_instance_id, v_seq, v_recorded_at, v_category, v_code,
      v_props
    )
    on conflict (agent_instance_id, seq) do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted = 1 then
      v_accepted := v_accepted + 1;
    else
      v_duplicates := v_duplicates + 1;
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'accepted', v_accepted,
    'duplicates', v_duplicates,
    'rejected', v_rejected);
end;
$$;

revoke all on function public.ingest_agent_journal(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.ingest_agent_journal(uuid, uuid, jsonb) to authenticated;

comment on function public.ingest_agent_journal(uuid, uuid, jsonb) is
  'Stores up to 200 agent journal records for the calling user after the server-side privacy fence. Returns {accepted, duplicates, rejected: [{seq, reason}]}.';

-- 3. Retention -----------------------------------------------------------------

-- The body up to the final return is 20261120100000 verbatim; the journal
-- delete and its counter are the only additions.
create or replace function private.purge_analytics_events(p_keep_days integer default 90)
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
  v_deleted_journal bigint := 0;
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

  -- 033 FR-004: the agent journal lives 30 days, independent of keep_days,
  -- and has no aggregate to keep.
  delete from public.agent_journal_records as j
  where j.recorded_at < pg_catalog.now() - interval '30 days';
  get diagnostics v_deleted_journal = row_count;

  return pg_catalog.jsonb_build_object(
    'keep_days', v_keep,
    'cutoff', v_cutoff,
    'materialized_days', v_days,
    'deleted_events', v_deleted,
    'deleted_journal_records', v_deleted_journal);
end;
$$;

revoke all on function private.purge_analytics_events(integer)
  from public, anon, authenticated, service_role;

comment on function private.purge_analytics_events(integer) is
  'Materializes every complete day older than keep_days that is not yet final, then deletes the events of final days; also deletes agent journal records older than 30 days. Returns counts.';

notify pgrst, 'reload schema';
