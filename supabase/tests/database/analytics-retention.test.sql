begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(50);

-- 031 / FR-057: detailed events live 90 days, daily aggregates live forever,
-- and a deleted account leaves rows that cannot be re-linked. Two users send
-- the same traffic every day for 95 days; one day is materialized by hand,
-- the purge takes the rest, and then one account is deleted.
--
-- Per UTC day: user A sends compression_started, compression_completed,
-- operation_stage_started (a sub-step, must not count), operation_cancelled
-- on the stitcher with no version/platform (lands in 'unknown'), home_viewed
-- (no tool). User B sends compression_started, compression_failed, home_viewed.
-- Eight rows a day, five of them A's.

-- Shape -------------------------------------------------------------------------

select has_table('public', 'analytics_daily_events', 'analytics_daily_events exists');
select has_table('public', 'analytics_daily_tool_outcomes', 'analytics_daily_tool_outcomes exists');
select has_table('private', 'analytics_daily_materialized', 'the materialized-day ledger exists');

select ok((select relrowsecurity from pg_class where oid = 'public.analytics_daily_events'::regclass),
  'analytics_daily_events has RLS enabled');
select ok((select relrowsecurity from pg_class
  where oid = 'public.analytics_daily_tool_outcomes'::regclass),
  'analytics_daily_tool_outcomes has RLS enabled');

select ok(has_table_privilege('wishly_analytics_ro', 'public.analytics_daily_events', 'select'),
  'the read-only analytics role may read daily events');
select ok(has_table_privilege('wishly_analytics_ro', 'public.analytics_daily_tool_outcomes', 'select'),
  'the read-only analytics role may read daily tool outcomes');
select ok(not has_table_privilege('wishly_analytics_ro', 'public.analytics_daily_events', 'insert'),
  'the read-only analytics role cannot insert daily events');
select ok(not has_table_privilege('wishly_analytics_ro', 'public.analytics_daily_tool_outcomes', 'update'),
  'the read-only analytics role cannot update daily tool outcomes');
select ok(not has_table_privilege('anon', 'public.analytics_daily_events', 'select'),
  'anon cannot read daily events');
select ok(not has_table_privilege('authenticated', 'public.analytics_daily_events', 'insert'),
  'authenticated cannot insert daily events');
select ok(not has_table_privilege('authenticated', 'private.analytics_daily_materialized', 'select'),
  'authenticated cannot read the ledger');
select ok(not has_function_privilege('authenticated',
  'private.materialize_analytics_daily(date)', 'execute'),
  'browser roles cannot materialize');
select ok(not has_function_privilege('authenticated',
  'private.purge_analytics_events(integer)', 'execute'),
  'browser roles cannot purge');
select ok(not has_function_privilege('service_role',
  'private.purge_analytics_events(integer)', 'execute'),
  'service_role cannot purge');

-- Seed --------------------------------------------------------------------------

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
values
  ('e0310000-0000-4000-8000-00000000000a', 'authenticated', 'authenticated',
    'retention-a@example.test', '{}', '{}'),
  ('e0310000-0000-4000-8000-00000000000b', 'authenticated', 'authenticated',
    'retention-b@example.test', '{}', '{}');

insert into public.analytics_events
  (user_id, event_name, session_id, installation_id, tool, local_app_version, platform,
   properties, created_at, occurred_at)
select
  'e0310000-0000-4000-8000-00000000000a',
  row.event_name,
  'e0310000-0000-4000-8000-0000000000a1',
  'e0310000-0000-4000-8000-0000000000a2',
  row.tool,
  case when row.tool = 'stitcher' then null else '1.4.0' end,
  case when row.tool = 'stitcher' then null else 'macos' end,
  '{}'::jsonb,
  now() - make_interval(days => day.n),
  now() - make_interval(days => day.n)
from generate_series(1, 95) as day(n)
cross join (values
  ('compression_started', 'compressor'),
  ('compression_completed', 'compressor'),
  ('operation_stage_started', 'compressor'),
  ('operation_cancelled', 'stitcher'),
  ('home_viewed', null)
) as row(event_name, tool);

insert into public.analytics_events
  (user_id, event_name, session_id, installation_id, tool, local_app_version, platform,
   properties, created_at, occurred_at)
select
  'e0310000-0000-4000-8000-00000000000b',
  row.event_name,
  'e0310000-0000-4000-8000-0000000000b1',
  'e0310000-0000-4000-8000-0000000000b2',
  row.tool,
  '1.4.0',
  'macos',
  '{}'::jsonb,
  now() - make_interval(days => day.n),
  now() - make_interval(days => day.n)
from generate_series(1, 95) as day(n)
cross join (values
  ('compression_started', 'compressor'),
  ('compression_failed', 'compressor'),
  ('home_viewed', null)
) as row(event_name, tool);

select is((select count(*)::integer from public.analytics_events
  where user_id in ('e0310000-0000-4000-8000-00000000000a', 'e0310000-0000-4000-8000-00000000000b')),
  760, 'seed: eight rows a day for 95 days');

-- Materialize one old day by hand -----------------------------------------------

create temp table retention_days as
select
  ((now() - interval '93 days') at time zone 'UTC')::date as day93,
  ((now() - interval '95 days') at time zone 'UTC')::date as day95,
  ((now() - interval '90 days') at time zone 'UTC')::date as cutoff_day;

select is((private.materialize_analytics_daily((select day93 from retention_days)))->>'recorded',
  'true', 'a past day is recorded as final when materialized');

select is((select count(*)::integer from public.analytics_daily_events
  where day = (select day93 from retention_days)), 6,
  'six event names on the materialized day');
select is((select count from public.analytics_daily_events
  where day = (select day93 from retention_days) and event_name = 'compression_started'),
  2::bigint, 'compression_started counted once per user');
select is((select users from public.analytics_daily_events
  where day = (select day93 from retention_days) and event_name = 'compression_started'),
  2::bigint, 'two distinct users started a compression');
select is((select users from public.analytics_daily_events
  where day = (select day93 from retention_days) and event_name = 'compression_failed'),
  1::bigint, 'one distinct user failed a compression');

select is((select count(*)::integer from public.analytics_daily_tool_outcomes
  where day = (select day93 from retention_days)), 2,
  'two tool/version/platform rows: compressor and the unknown-version stitcher');
select results_eq(
  $$select starts, completions, failures, cancellations, users
    from public.analytics_daily_tool_outcomes
    where day = (select day93 from retention_days)
      and tool = 'compressor' and local_app_version = '1.4.0' and platform = 'macos'$$,
  $$values (2::bigint, 1::bigint, 1::bigint, 0::bigint, 2::bigint)$$,
  'compressor: 2 starts (stage events excluded), 1 completion, 1 failure, 0 cancellations, 2 users');
select results_eq(
  $$select starts, completions, failures, cancellations, users
    from public.analytics_daily_tool_outcomes
    where day = (select day93 from retention_days)
      and tool = 'stitcher' and local_app_version = 'unknown' and platform = 'unknown'$$,
  $$values (0::bigint, 0::bigint, 0::bigint, 1::bigint, 1::bigint)$$,
  'stitcher with no version/platform lands in unknown with one cancellation');
select is((select count(*)::integer from public.analytics_daily_tool_outcomes
  where day = (select day93 from retention_days) and tool = 'unknown'), 0,
  'rows without a tool are not tool outcomes');

-- Idempotent: a second run changes nothing.
select is((private.materialize_analytics_daily((select day93 from retention_days)))->>'skipped',
  'true', 'a final day is skipped on a second run');
select is((select count(*)::integer from public.analytics_daily_events
  where day = (select day93 from retention_days)), 6,
  'a second run leaves the day as it was');
select is((select count(*)::integer from private.analytics_daily_materialized), 1,
  'exactly one day is recorded before the purge');

-- Purge -------------------------------------------------------------------------

create temp table retention_purge as
select private.purge_analytics_events(90) as result;

select is((select (result->>'materialized_days')::integer from retention_purge), 4,
  'the purge materializes the four old days not yet final');
select is((select (result->>'deleted_events')::integer from retention_purge), 40,
  'the purge deletes five whole days of eight rows');
select is((select count(*)::integer from public.analytics_events
  where created_at < ((select cutoff_day from retention_days)::timestamp at time zone 'UTC')),
  0, 'no event older than the cutoff day remains');
select is((select count(*)::integer from public.analytics_events
  where user_id in ('e0310000-0000-4000-8000-00000000000a', 'e0310000-0000-4000-8000-00000000000b')),
  720, 'ninety days of recent events are kept');
select is((select count(*)::integer from private.analytics_daily_materialized), 5,
  'five days are recorded as final after the purge');
select is((select count from public.analytics_daily_events
  where day = (select day95 from retention_days) and event_name = 'home_viewed'),
  2::bigint, 'the oldest purged day keeps its aggregate');
select is((select starts from public.analytics_daily_tool_outcomes
  where day = (select day95 from retention_days) and tool = 'compressor'),
  2::bigint, 'the oldest purged day keeps its tool outcomes');

-- A second purge is a no-op.
select is((private.purge_analytics_events(90))->>'deleted_events', '0',
  'a second purge deletes nothing');

-- Who can read the aggregates --------------------------------------------------

-- The temp tables above belong to the superuser; the role blocks compute the
-- day inline so they exercise only the grants under test.
set local role wishly_analytics_ro;
select is((select count(*)::integer from public.analytics_daily_events
  where day = ((now() - interval '95 days') at time zone 'UTC')::date), 6,
  'the read-only role reads daily events of a purged day');
select is((select count(*)::integer from public.analytics_daily_tool_outcomes
  where day = ((now() - interval '95 days') at time zone 'UTC')::date), 2,
  'the read-only role reads daily tool outcomes of a purged day');
select throws_ok(
  $$select count(*) from private.analytics_daily_materialized$$,
  '42501', null, 'the read-only role cannot read the private ledger');
select throws_ok(
  $$insert into public.analytics_daily_events (day, event_name) values (current_date, 'x')$$,
  '42501', null, 'the read-only role cannot write daily events');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e0310000-0000-4000-8000-00000000000b', true);
select is((select count(*)::integer from public.analytics_daily_events), 0,
  'a signed-in non-admin sees no daily events');
select is((select count(*)::integer from public.analytics_daily_tool_outcomes), 0,
  'a signed-in non-admin sees no daily tool outcomes');
reset role;

insert into public.admin_users (user_id) values ('e0310000-0000-4000-8000-00000000000b');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e0310000-0000-4000-8000-00000000000b', true);
select ok((select count(*) from public.analytics_daily_events) > 0,
  'an admin reads daily events');
reset role;

-- Account deletion -------------------------------------------------------------

select is((select count(*)::integer from public.analytics_events
  where installation_id = 'e0310000-0000-4000-8000-0000000000a2'), 450,
  'before deletion: 90 days of five rows carry installation A');

delete from auth.users where id = 'e0310000-0000-4000-8000-00000000000a';

select is((select count(*)::integer from public.analytics_events
  where user_id = 'e0310000-0000-4000-8000-00000000000a'), 0,
  'after deletion: no row names user A');
select is((select count(*)::integer from public.analytics_events
  where installation_id = 'e0310000-0000-4000-8000-0000000000a2'), 0,
  'after deletion: no row carries installation A');
select is((select count(*)::integer from public.analytics_events
  where session_id = 'e0310000-0000-4000-8000-0000000000a1'), 0,
  'after deletion: no row carries a session of A');
select is((select count(*)::integer from public.analytics_events
  where user_id is null and installation_id is null and session_id is null
    and created_at >= now() - interval '91 days'
    and event_name in ('compression_started', 'compression_completed',
      'operation_stage_started', 'operation_cancelled', 'home_viewed')), 450,
  'after deletion: all 450 of A''s rows are anonymised on every key');
select is((select count(*)::integer from public.analytics_events
  where user_id = 'e0310000-0000-4000-8000-00000000000b'
    and installation_id = 'e0310000-0000-4000-8000-0000000000b2'
    and session_id = 'e0310000-0000-4000-8000-0000000000b1'), 270,
  'the other account keeps user, installation and session');

-- An ordinary update that does not null user_id leaves the keys alone.
update public.analytics_events set tool = tool
where user_id = 'e0310000-0000-4000-8000-00000000000b';
select is((select count(*)::integer from public.analytics_events
  where installation_id = 'e0310000-0000-4000-8000-0000000000b2'), 270,
  'an update that keeps user_id keeps installation_id');

select * from finish();
rollback;
