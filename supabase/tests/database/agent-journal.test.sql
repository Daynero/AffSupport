begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(38);

-- 033 / US2, FR-001, FR-002, FR-004: the agent journal table, its ingestion
-- RPC with the server-side privacy fence, and its 30-day retention.

-- Shape -------------------------------------------------------------------------

select has_table('public', 'agent_journal_records', 'agent_journal_records exists');
select columns_are('public', 'agent_journal_records', array[
  'id', 'user_id', 'installation_id', 'agent_instance_id', 'seq', 'recorded_at', 'received_at',
  'category', 'code', 'props'
], 'agent_journal_records has exactly the FR-001 columns');
select has_index('public', 'agent_journal_records', 'agent_journal_records_user_recorded_idx',
  'user/time index exists');
select has_index('public', 'agent_journal_records',
  'agent_journal_records_installation_recorded_idx', 'installation/time index exists');
select has_index('public', 'agent_journal_records', 'agent_journal_records_instance_seq_idx',
  'instance/seq index exists');
select ok((select relrowsecurity from pg_class where oid = 'public.agent_journal_records'::regclass),
  'agent_journal_records has RLS enabled');

-- Grants ------------------------------------------------------------------------

select ok(not has_table_privilege('authenticated', 'public.agent_journal_records', 'insert'),
  'authenticated cannot insert journal records directly');
select ok(not has_table_privilege('authenticated', 'public.agent_journal_records', 'update'),
  'authenticated cannot update journal records');
select ok(not has_table_privilege('anon', 'public.agent_journal_records', 'select'),
  'anon cannot read journal records');
select ok(not has_table_privilege('service_role', 'public.agent_journal_records', 'insert'),
  'service_role cannot insert journal records');
select ok(has_table_privilege('wishly_analytics_ro', 'public.agent_journal_records', 'select'),
  'the read-only analytics role may read journal records');
select ok(not has_table_privilege('wishly_analytics_ro', 'public.agent_journal_records', 'insert'),
  'the read-only analytics role cannot insert journal records');
select ok(has_function_privilege('authenticated',
  'public.ingest_agent_journal(uuid, uuid, jsonb)', 'execute'),
  'authenticated may call the ingestion RPC');
select ok(not has_function_privilege('anon',
  'public.ingest_agent_journal(uuid, uuid, jsonb)', 'execute'),
  'anon may not call the ingestion RPC');
select ok(not has_function_privilege('authenticated',
  'private.purge_analytics_events(integer)', 'execute'),
  'browser roles still cannot purge');

-- Seed --------------------------------------------------------------------------

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
values
  ('e0330000-0000-4000-8000-00000000000a', 'authenticated', 'authenticated',
    'journal-a@example.test', '{}', '{}'),
  ('e0330000-0000-4000-8000-00000000000b', 'authenticated', 'authenticated',
    'journal-b@example.test', '{}', '{}');

-- Ingestion as user A -------------------------------------------------------------

create temp table journal_results (label text primary key, result jsonb) on commit drop;
grant all on journal_results to authenticated;

set local role authenticated;
set local request.jwt.claim.sub = 'e0330000-0000-4000-8000-00000000000a';

insert into journal_results values ('accept', public.ingest_agent_journal(
  'e0330000-0000-4000-8000-0000000000a1', 'e0330000-0000-4000-8000-0000000000c1',
  jsonb_build_array(
    jsonb_build_object('seq', 1, 'at', (extract(epoch from now()) * 1000)::bigint,
      'category', 'spawn', 'code', 'exit_nonzero',
      'props', jsonb_build_object('duration', 'under_10s', 'exitCode', 1, 'killed', false)),
    jsonb_build_object('seq', 2, 'at', (extract(epoch from now()) * 1000)::bigint,
      'category', 'stream', 'code', 'subscriber_evicted'))));

select is((select result from journal_results where label = 'accept'),
  '{"accepted": 2, "duplicates": 0, "rejected": []}'::jsonb, 'two safe records are accepted');

insert into journal_results values ('duplicate', public.ingest_agent_journal(
  'e0330000-0000-4000-8000-0000000000a1', 'e0330000-0000-4000-8000-0000000000c1',
  jsonb_build_array(jsonb_build_object('seq', 1, 'at', 1760000000000,
    'category', 'spawn', 'code', 'exit_nonzero'))));
select is((select result from journal_results where label = 'duplicate'),
  '{"accepted": 0, "duplicates": 1, "rejected": []}'::jsonb,
  'the same (instance, seq) again is a no-op');

-- Every rejection reason, one record each.
insert into journal_results values ('reject', public.ingest_agent_journal(
  'e0330000-0000-4000-8000-0000000000a1', 'e0330000-0000-4000-8000-0000000000c1',
  $$[
    "text",
    {"seq": 0, "at": 1760000000000, "category": "boot", "code": "started"},
    {"seq": 10, "at": "yesterday", "category": "boot", "code": "started"},
    {"seq": 11, "at": 99999999999999, "category": "boot", "code": "started"},
    {"seq": 12, "at": 1760000000000, "category": "filesystem", "code": "started"},
    {"seq": 13, "at": 1760000000000, "category": "boot", "code": "Started-Now"},
    {"seq": 14, "at": 1760000000000, "category": "boot", "code": "started", "props": [1]},
    {"seq": 15, "at": 1760000000000, "category": "boot", "code": "started",
      "props": {"a1": 1, "a2": 1, "a3": 1, "a4": 1, "a5": 1, "a6": 1, "a7": 1, "a8": 1, "a9": 1,
        "b1": 1, "b2": 1, "b3": 1, "b4": 1, "b5": 1, "b6": 1, "b7": 1, "b8": 1}},
    {"seq": 16, "at": 1760000000000, "category": "boot", "code": "started",
      "props": {"file-name": "x"}},
    {"seq": 17, "at": 1760000000000, "category": "boot", "code": "started",
      "props": {"v": {"nested": 1}}},
    {"seq": 18, "at": 1760000000000, "category": "boot", "code": "started",
      "props": {"v": "Users/me"}},
    {"seq": 19, "at": 1760000000000, "category": "boot", "code": "started",
      "props": {"v": "C:\\Users"}},
    {"seq": 20, "at": 1760000000000, "category": "boot", "code": "started",
      "props": {"v": "a://b"}},
    {"seq": 21, "at": 1760000000000, "category": "boot", "code": "started",
      "props": {"v": "AccessToken"}},
    {"seq": 22, "at": 1760000000000, "category": "boot", "code": "started",
      "props": {"v": "Bearer x"}},
    {"seq": 23, "at": 1760000000000, "category": "boot", "code": "started",
      "props": {"v": "me@example.test"}}
  ]$$::jsonb));

select is((select (result->>'accepted')::integer from journal_results where label = 'reject'), 0,
  'no unsafe record is accepted');
select is(
  (select jsonb_agg(item->>'reason') from journal_results,
    jsonb_array_elements(result->'rejected') as item where label = 'reject'),
  '["invalid_record", "invalid_seq", "invalid_time", "future_time", "invalid_category",
    "invalid_code", "invalid_props", "too_many_props", "invalid_prop_key", "invalid_prop_value",
    "unsafe_prop_value", "unsafe_prop_value", "unsafe_prop_value", "unsafe_prop_value",
    "unsafe_prop_value", "unsafe_prop_value"]'::jsonb,
  'each unsafe record is refused with its reason, in order');
select is(
  (select jsonb_agg(item->'seq') from journal_results,
    jsonb_array_elements(result->'rejected') as item where label = 'reject'),
  '[null, null, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]'::jsonb,
  'rejections name the seq when it could be read');

select throws_ok(
  $$select public.ingest_agent_journal(null, 'e0330000-0000-4000-8000-0000000000c1',
    (select jsonb_agg(jsonb_build_object('seq', n, 'at', 1760000000000,
      'category', 'boot', 'code', 'started')) from generate_series(1, 201) as n))$$,
  '22023', 'Expected at most 200 records', 'more than 200 records are refused');
select throws_ok(
  $$select public.ingest_agent_journal(null, null, '[]'::jsonb)$$,
  '22023', 'An agent instance is required', 'a missing agent instance is refused');

-- A non-admin cannot read the table, not even their own rows.
select is((select count(*)::integer from public.agent_journal_records), 0,
  'a non-admin user reads no journal records');

reset role;

-- Anonymous callers are refused.
set local role anon;
set local request.jwt.claim.sub = '';
select throws_ok(
  $$select public.ingest_agent_journal(null, 'e0330000-0000-4000-8000-0000000000c1', '[]'::jsonb)$$,
  '42501', null, 'anon cannot ingest');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '';
select throws_ok(
  $$select public.ingest_agent_journal(null, 'e0330000-0000-4000-8000-0000000000c1', '[]'::jsonb)$$,
  '42501', 'Authentication required', 'an authenticated role without a user cannot ingest');
reset role;

-- What landed ----------------------------------------------------------------------

select is((select count(*)::integer from public.agent_journal_records
  where agent_instance_id = 'e0330000-0000-4000-8000-0000000000c1'), 2,
  'exactly the two accepted records are stored');
select is((select user_id from public.agent_journal_records
  where agent_instance_id = 'e0330000-0000-4000-8000-0000000000c1' and seq = 1),
  'e0330000-0000-4000-8000-00000000000a'::uuid, 'the record belongs to the caller');
select is((select installation_id from public.agent_journal_records
  where agent_instance_id = 'e0330000-0000-4000-8000-0000000000c1' and seq = 1),
  'e0330000-0000-4000-8000-0000000000a1'::uuid, 'the record carries the installation');
select is((select props from public.agent_journal_records
  where agent_instance_id = 'e0330000-0000-4000-8000-0000000000c1' and seq = 1),
  '{"duration": "under_10s", "exitCode": 1, "killed": false}'::jsonb, 'props are stored as sent');
select is((select props from public.agent_journal_records
  where agent_instance_id = 'e0330000-0000-4000-8000-0000000000c1' and seq = 2),
  '{}'::jsonb, 'a record without props stores an empty object');

-- Readers ---------------------------------------------------------------------------

-- The read-only role need not see pgTAP's schema: count under the role, assert
-- after it.
set local role wishly_analytics_ro;
select set_config('journal_test.ro_count', (select count(*)::text
  from public.agent_journal_records
  where agent_instance_id = 'e0330000-0000-4000-8000-0000000000c1'), true);
reset role;
select is(current_setting('journal_test.ro_count')::integer, 2,
  'the read-only role reads journal records');

insert into public.admin_users (user_id) values ('e0330000-0000-4000-8000-00000000000b');
set local role authenticated;
set local request.jwt.claim.sub = 'e0330000-0000-4000-8000-00000000000b';
select is((select count(*)::integer from public.agent_journal_records
  where agent_instance_id = 'e0330000-0000-4000-8000-0000000000c1'), 2,
  'an admin reads journal records');
reset role;

-- Retention ---------------------------------------------------------------------

insert into public.agent_journal_records
  (user_id, agent_instance_id, seq, recorded_at, category, code)
values
  ('e0330000-0000-4000-8000-00000000000b', 'e0330000-0000-4000-8000-0000000000c2', 1,
    now() - interval '31 days', 'boot', 'started'),
  ('e0330000-0000-4000-8000-00000000000b', 'e0330000-0000-4000-8000-0000000000c2', 2,
    now() - interval '29 days', 'boot', 'started');

create temp table journal_purge on commit drop as
select private.purge_analytics_events(90) as result;

select ok((select result ? 'deleted_events' from journal_purge),
  'the purge still reports deleted events');
select ok((select (result->>'deleted_journal_records')::integer >= 1 from journal_purge),
  'the purge reports deleted journal records');
select is((select count(*)::integer from public.agent_journal_records
  where agent_instance_id = 'e0330000-0000-4000-8000-0000000000c2'
    and recorded_at < now() - interval '30 days'), 0,
  'no journal record older than 30 days remains');
select is((select count(*)::integer from public.agent_journal_records
  where agent_instance_id = 'e0330000-0000-4000-8000-0000000000c2'), 1,
  'a journal record younger than 30 days is kept');

-- Account deletion ----------------------------------------------------------------

delete from auth.users where id = 'e0330000-0000-4000-8000-00000000000a';
select is((select count(*)::integer from public.agent_journal_records
  where user_id = 'e0330000-0000-4000-8000-00000000000a'), 0,
  'deleting the account deletes its journal');
select is((select count(*)::integer from public.agent_journal_records
  where agent_instance_id = 'e0330000-0000-4000-8000-0000000000c1'), 0,
  'no orphaned journal record of the deleted account remains');

select * from finish();
rollback;
