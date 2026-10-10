begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(13);

-- 031 envelope v3 (20261117110000_analytics_envelope_v3.sql): the Agent's
-- identity and the attempt are columns, and ingestion fills them.

select has_column('public', 'analytics_events', 'agent_instance_id', 'agent_instance_id column exists');
select has_column('public', 'analytics_events', 'agent_platform', 'agent_platform column exists');
select has_column('public', 'analytics_events', 'attempt_id', 'attempt_id column exists');
select has_index('public', 'analytics_events', 'analytics_events_attempt_created_idx',
  'attempt_id is indexed');

-- Own id space: rls.test.sql uses f1000000-…-0001/2/3, the beta seed the obvious ones.
insert into auth.users (id, email, raw_user_meta_data)
values ('f1000000-0000-4000-8000-000000000031', 'envelope@example.test', '{"full_name":"Env"}'::jsonb);

set local role authenticated;
set local request.jwt.claim.sub = 'f1000000-0000-4000-8000-000000000031';

-- A 031 client: attempt_id in the envelope, the Agent fields filled.
select results_eq(
  $$select accepted
    from public.ingest_analytics_events(
      '[{
        "event_id": "f1000000-0000-4000-8000-000000000032",
        "event_name": "team_file_attempt_completed",
        "event_version": 2,
        "attempt_id": "attempt_01",
        "agent_instance_id": "88888888-8888-4888-8888-888888888888",
        "agent_platform": "macos",
        "platform": "linux",
        "properties": {
          "attempt_id": "attempt_01",
          "action": "download",
          "storage_kind": "shared_drive",
          "size_bucket": "agent",
          "cache_state": "cold",
          "attempt_number": 1,
          "duration_ms": 375,
          "stage": "downloading",
          "outcome": "failure",
          "retryable": true,
          "production_completed": false
        }
      }]'::jsonb
    )$$,
  array[true],
  'an envelope v3 event is accepted');

-- A pre-031 client: attempt_id only inside properties.
select results_eq(
  $$select accepted
    from public.ingest_analytics_events(
      '[{
        "event_id": "f1000000-0000-4000-8000-000000000033",
        "event_name": "team_find_started",
        "properties": {"attempt_id": "attempt_legacy", "cue_category": "geo", "stage": "finding"}
      }]'::jsonb
    )$$,
  array[true],
  'a legacy event with attempt_id in properties is accepted');

-- Agent fields this build does not recognise are dropped, not refused.
select results_eq(
  $$select accepted
    from public.ingest_analytics_events(
      '[{
        "event_id": "f1000000-0000-4000-8000-000000000034",
        "event_name": "home_viewed",
        "agent_instance_id": "not-a-uuid",
        "agent_platform": "linux",
        "properties": {}
      }]'::jsonb
    )$$,
  array[true],
  'unknown agent fields do not refuse the event');

-- A malformed attempt_id refuses the event, as a malformed flow_id does.
select results_eq(
  $$select accepted
    from public.ingest_analytics_events(
      '[{
        "event_id": "f1000000-0000-4000-8000-000000000035",
        "event_name": "home_viewed",
        "attempt_id": "bad/attempt",
        "properties": {}
      }]'::jsonb
    )$$,
  array[false],
  'a malformed attempt_id is refused');

reset role;

select results_eq(
  $$select attempt_id, agent_instance_id, agent_platform, platform, properties ? 'attempt_id'
    from public.analytics_events
    where event_id = 'f1000000-0000-4000-8000-000000000032'$$,
  $$values ('attempt_01', '88888888-8888-4888-8888-888888888888'::uuid, 'macos', 'linux', false)$$,
  'envelope v3 stores the attempt and Agent identity in columns and strips the property copy');

select results_eq(
  $$select attempt_id, properties
    from public.analytics_events
    where event_id = 'f1000000-0000-4000-8000-000000000033'$$,
  $$values ('attempt_legacy', '{"cue_category": "geo", "stage": "finding"}'::jsonb)$$,
  'a legacy attempt_id is lifted out of properties into the column');

select results_eq(
  $$select agent_instance_id, agent_platform
    from public.analytics_events
    where event_id = 'f1000000-0000-4000-8000-000000000034'$$,
  $$values (null::uuid, null::text)$$,
  'unrecognised agent fields are stored as null');

select is(
  (select count(*) from public.analytics_events
    where event_id = 'f1000000-0000-4000-8000-000000000035'),
  0::bigint,
  'the refused event was not stored');

-- The table itself holds the platform vocabulary, whatever path a row takes.
select throws_ok(
  $$insert into public.analytics_events (user_id, event_name, properties, agent_platform)
    values ('f1000000-0000-4000-8000-000000000031', 'home_viewed', '{}'::jsonb, 'linux')$$,
  '23514',
  null,
  'an agent_platform outside macos|windows violates the check constraint');

select * from finish();
rollback;
