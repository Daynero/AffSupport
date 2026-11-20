-- Backend audit 2026-11-20: public.analytics_events is 41% of the shared database (581 MB,
-- 537 000 rows inside the 90-day horizon) and ingest_analytics_events is its largest writer
-- of WAL by a wide margin — 1 973 MB in eight days, 20 kB a call. Two things in the row and
-- its indexes cost that without being read.
--
-- 1. tool_contracts. Every event sent with the app connected repeats its tool contract list
--    — {"compressor": 3, "stitcher": 1, …}, 309 bytes on average, about 40% of the heap, in
--    eight distinct values across 537 000 rows. No report, no CLI command and no function reads
--    the column; the only mention outside ingestion is the check that bounds its size. A list
--    of that plain shape is now stored once in public.analytics_tool_contract_sets and the
--    event carries its 4-byte id, with tool_contracts written as '{}'. Nothing is lost: join on
--    tool_contract_set_id to read it. Rows already stored keep their copy until retention
--    removes them.
--
--    Only the plain shape goes to the dictionary — short alphanumeric names, small whole
--    numbers. Anything else an authenticated caller sends stays in its own event exactly as
--    before and leaves with it after 90 days: the dictionary is never pruned, so it must not
--    become a place to keep arbitrary text, and a name of that shape cannot spell a material
--    id or a Drive file id, which the attachment cleanup inventory searches this table for.
--
-- 2. Indexes. The table carried 18 (202 MB). Four go:
--      analytics_events_local_build_idx   23 MB   0 scans since statistics were reset
--                                                 (2026-11-11); 31 distinct builds, and every
--                                                 query that names a build also bounds time
--      analytics_events_event_name_idx     6 MB   the leading column of
--                                                 analytics_events_event_created_idx
--      analytics_events_tool_idx           6 MB   the leading column of
--                                                 analytics_events_tool_created_idx
--      analytics_events_user_id_idx        5 MB   the leading column of
--                                                 analytics_events_user_created_idx
--    The last two composites are partial («where x is not null»); equality on x implies the
--    predicate, so they answer the same lookups, the auth.users cascade included.
--    analytics_events_installation_created_idx (36 MB, also 0 scans in that window) stays:
--    `analytics investigate <installation id>` resolves its subject through it with no lower
--    time bound, and zero scans only says nobody ran that command in eight days.
--    Every event now maintains 14 indexes instead of 18.
--
-- No client names an index, so dropping one changes no answer — only plans.
begin;

-- The statements below need a brief exclusive lock on a table written many times a second.
-- They must not wait for it indefinitely: every ingest call queues behind a waiting DDL, and
-- a caller gives up after eight seconds. Five seconds, then the whole file fails cleanly and
-- is applied again (as 20261218200000 does).
set local lock_timeout = '5s';

-- What a tool contract list looks like: {"name": version, …}.
create or replace function private.analytics_tool_contract_list_is_plain(p_list jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(
    pg_catalog.jsonb_typeof(p_list) = 'object'
    and (
      select pg_catalog.count(*) between 1 and 64
        and pg_catalog.bool_and(
          entry.key ~ '^[A-Za-z][A-Za-z0-9]{0,31}$'
          and pg_catalog.jsonb_typeof(entry.value) = 'number'
          and entry.value::text ~ '^[0-9]{1,6}$'
        )
      from pg_catalog.jsonb_each(p_list) as entry
    ),
    false
  )
$$;
revoke all on function private.analytics_tool_contract_list_is_plain(jsonb)
  from public, anon, authenticated, service_role;

create table if not exists public.analytics_tool_contract_sets (
  id integer generated always as identity primary key,
  -- md5 of the jsonb text. jsonb normalises key order, so equal lists share a digest.
  digest text not null unique,
  contracts jsonb not null,
  first_seen_at timestamptz not null default pg_catalog.now(),
  constraint analytics_tool_contract_sets_shape
    check (private.analytics_tool_contract_list_is_plain(contracts))
);
alter table public.analytics_tool_contract_sets enable row level security;
-- Supabase grants every new public table to these roles by default.
revoke all on public.analytics_tool_contract_sets from public, anon, authenticated, service_role;
comment on table public.analytics_tool_contract_sets is
  'Each distinct tool contract list an event reported, stored once. analytics_events.tool_contract_set_id points here.';

-- The table has a jsonb column, so it belongs to the attachment cleanup inventory
-- (private.task_cleanup_reference_tables, 20261205122000) and carries its guard like every
-- other such table; without it private.task_cleanup_coverage_verified() is false for the whole
-- database and no orphaned upload can be claimed. The guard runs when a list is first seen.
create or replace trigger task_cleanup_reference_fence
  before insert or update on public.analytics_tool_contract_sets
  for each row execute function private.guard_task_cleanup_reference();

do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'wishly_analytics_ro') then
    grant select on public.analytics_tool_contract_sets to wishly_analytics_ro;
    drop policy if exists analytics_readonly_select on public.analytics_tool_contract_sets;
    create policy analytics_readonly_select on public.analytics_tool_contract_sets
      for select to wishly_analytics_ro using (true);
  end if;
end $$;

-- A plain reference, deliberately without a foreign key: ingestion is the hottest write path
-- in the database and the dictionary is never pruned.
alter table public.analytics_events add column if not exists tool_contract_set_id integer;
comment on column public.analytics_events.tool_contracts is
  'Empty when tool_contract_set_id is set (since 20261220120000): the list lives in analytics_tool_contract_sets. Older rows, and lists that are not plain name/version maps, hold their own copy.';

create or replace function public.ingest_analytics_events(p_events jsonb)
returns table (event_id uuid, accepted boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  item jsonb;
  v_event_id uuid;
  v_event_name text;
  v_properties jsonb;
  v_flow_id uuid;
  v_run_id uuid;
  v_attempt_id text;
  v_agent_instance_id uuid;
  v_agent_platform text;
  v_contracts jsonb;
  v_inline_contracts jsonb;
  v_contract_set integer;
  v_digest text;
  -- One batch comes from one page, so its events nearly always share a list: remember the
  -- last one that resolved to the dictionary, and the last one that has to stay in the row.
  v_known_contracts jsonb;
  v_known_set integer;
  v_inline_only jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) > 100 then
    raise exception 'Expected at most 100 events' using errcode = '22023';
  end if;

  for item in select value from jsonb_array_elements(p_events)
  loop
    begin
      -- Do not leak a previous loop value into the rejection result when the
      -- current event_id cannot be parsed.
      v_event_id := null;
      v_event_id := (item ->> 'event_id')::uuid;
      v_event_name := item ->> 'event_name';
      v_properties := coalesce(item -> 'properties', '{}'::jsonb);
      v_flow_id := nullif(coalesce(item ->> 'flow_id', v_properties ->> 'flow_id'), '')::uuid;
      v_run_id := nullif(coalesce(item ->> 'run_id', v_properties ->> 'run_id'), '')::uuid;
      v_attempt_id := nullif(coalesce(item ->> 'attempt_id', v_properties ->> 'attempt_id'), '');

      -- Routing identifiers live in typed columns only: 0.6.1 clients repeated
      -- flow_id/run_id in properties, pre-031 clients carry attempt_id there.
      v_properties := v_properties - 'flow_id' - 'run_id' - 'attempt_id';

      if v_event_name is null or v_event_name !~ '^[a-z][a-z0-9_]{1,63}$' then
        raise exception 'Invalid event name';
      end if;
      if v_attempt_id is not null and v_attempt_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$' then
        raise exception 'Invalid attempt_id';
      end if;
      if not public.analytics_properties_are_safe_v2(v_properties) then
        raise exception 'Unsafe event properties';
      end if;

      -- The Agent fields are informational: a value this build does not
      -- recognise is dropped, not a reason to refuse the event.
      v_agent_instance_id := case
        when (item ->> 'agent_instance_id')
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then (item ->> 'agent_instance_id')::uuid
        else null end;
      v_agent_platform := case
        when item ->> 'agent_platform' in ('macos', 'windows') then item ->> 'agent_platform'
        else null end;

      -- A plain tool contract list is stored once and referenced. Every other value stays
      -- in the row, where the table's own check judges it exactly as before: a malformed one
      -- still refuses the event, and neither arbitrary text nor a flood of distinct lists
      -- can grow a table that retention never prunes.
      v_contracts := coalesce(item -> 'tool_contracts', '{}'::jsonb);
      v_inline_contracts := v_contracts;
      v_contract_set := null;
      if v_contracts <> '{}'::jsonb then
        if v_known_contracts is not null and v_contracts = v_known_contracts then
          v_contract_set := v_known_set;
        elsif v_inline_only is not null and v_contracts = v_inline_only then
          null;
        elsif private.analytics_tool_contract_list_is_plain(v_contracts) then
          v_digest := pg_catalog.md5(v_contracts::text);
          select known.id into v_contract_set
            from public.analytics_tool_contract_sets as known
           where known.digest = v_digest and known.contracts = v_contracts;
          if v_contract_set is null
            and (select pg_catalog.count(*) from public.analytics_tool_contract_sets) < 500 then
            insert into public.analytics_tool_contract_sets (digest, contracts)
            values (v_digest, v_contracts)
            on conflict (digest) do nothing;
            select known.id into v_contract_set
              from public.analytics_tool_contract_sets as known
             where known.digest = v_digest and known.contracts = v_contracts;
          end if;
          if v_contract_set is not null then
            v_known_contracts := v_contracts;
            v_known_set := v_contract_set;
          else
            v_inline_only := v_contracts;
          end if;
        else
          v_inline_only := v_contracts;
        end if;
        if v_contract_set is not null then
          v_inline_contracts := '{}'::jsonb;
        end if;
      end if;

      insert into public.analytics_events (
        event_id, event_name, event_version, occurred_at, session_sequence,
        user_id, session_id, installation_id, flow_id, run_id, attempt_id, tool, properties,
        app_version, agent_version, web_build_id, local_app_version, local_app_build,
        release_channel, core_api_version, tool_contracts, tool_contract_set_id,
        locale, platform, architecture,
        agent_instance_id, agent_platform,
        event_source, feature, screen, action, outcome, error_code, error_stage,
        error_fingerprint
      ) values (
        v_event_id, v_event_name, coalesce((item ->> 'event_version')::integer, 1),
        coalesce((item ->> 'occurred_at')::timestamptz, now()),
        (item ->> 'session_sequence')::integer,
        auth.uid(), (item ->> 'session_id')::uuid, (item ->> 'installation_id')::uuid,
        v_flow_id, v_run_id, v_attempt_id, nullif(item ->> 'tool', ''), v_properties,
        left(item ->> 'web_build_id', 64), left(item ->> 'local_app_version', 64),
        left(item ->> 'web_build_id', 96), left(item ->> 'local_app_version', 64),
        left(item ->> 'local_app_build', 96), left(item ->> 'release_channel', 32),
        (item ->> 'core_api_version')::integer, v_inline_contracts, v_contract_set,
        nullif(item ->> 'locale', ''), nullif(item ->> 'platform', ''),
        nullif(item ->> 'architecture', ''),
        v_agent_instance_id, v_agent_platform,
        coalesce(item ->> 'event_source', 'web'),
        nullif(item ->> 'feature', ''), nullif(item ->> 'screen', ''),
        nullif(item ->> 'action', ''), nullif(item ->> 'outcome', ''),
        nullif(item ->> 'error_code', ''), nullif(item ->> 'error_stage', ''),
        nullif(item ->> 'error_fingerprint', '')
      )
      -- Omitting a conflict target avoids the PL/pgSQL OUT-parameter ambiguity
      -- while retaining idempotent delivery by the unique event_id index.
      on conflict do nothing;

      event_id := v_event_id;
      accepted := true;
      reason := null;
      return next;
    exception when others then
      -- The refused event's block is rolled back, and with it a dictionary row it may have
      -- added. Variables survive a rollback, so forget what was remembered rather than hand
      -- the next event a reference to a row that no longer exists.
      v_known_contracts := null;
      v_known_set := null;
      v_inline_only := null;
      event_id := v_event_id;
      accepted := false;
      reason := left(sqlerrm, 160);
      return next;
    end;
  end loop;
end;
$$;

revoke all on function public.ingest_analytics_events(jsonb) from public, anon;
grant execute on function public.ingest_analytics_events(jsonb) to authenticated;

drop index if exists public.analytics_events_local_build_idx;
drop index if exists public.analytics_events_event_name_idx;
drop index if exists public.analytics_events_tool_idx;
drop index if exists public.analytics_events_user_id_idx;

commit;
