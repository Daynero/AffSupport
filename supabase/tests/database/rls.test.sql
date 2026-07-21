begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(22);

select has_table('public', 'profiles', 'profiles table exists');
select has_table('public', 'admin_users', 'admin_users table exists');
select has_table('public', 'analytics_events', 'analytics_events table exists');

insert into auth.users (id, email, raw_user_meta_data)
values
  ('11111111-1111-4111-8111-111111111111', 'one@example.test', '{"full_name":"One"}'::jsonb),
  ('22222222-2222-4222-8222-222222222222', 'two@example.test', '{"full_name":"Two"}'::jsonb),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'admin@example.test', '{"full_name":"Admin"}'::jsonb);

insert into public.analytics_events (user_id, event_name, properties)
values ('22222222-2222-4222-8222-222222222222', 'home_viewed', '{}'::jsonb);

set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

select results_eq(
  'select count(*) from public.profiles',
  array[1::bigint],
  'a user reads only their own profile'
);

select ok(
  not has_column_privilege('authenticated', 'public.profiles', 'plan', 'UPDATE'),
  'a user cannot update plan'
);

select ok(
  not has_column_privilege('authenticated', 'public.profiles', 'account_status', 'UPDATE'),
  'a user cannot update account status'
);

select results_eq(
  'select count(*) from public.analytics_events',
  array[0::bigint],
  'a non-admin cannot read analytics events'
);

select lives_ok(
  $$insert into public.analytics_events (user_id, event_name, properties)
    values ('11111111-1111-4111-8111-111111111111', 'home_viewed', '{}'::jsonb)$$,
  'a user can insert an allowlisted event for themself'
);

select throws_ok(
  $$insert into public.analytics_events (user_id, event_name, properties)
    values ('22222222-2222-4222-8222-222222222222', 'home_viewed', '{}'::jsonb)$$,
  '42501',
  'new row violates row-level security policy for table "analytics_events"',
  'a user cannot insert an event for another user'
);

select results_eq(
  $$select accepted
    from public.ingest_analytics_events(
      $events$[{
        "event_id": "33333333-3333-4333-8333-333333333333",
        "event_name": "compression_started",
        "event_version": 2,
        "session_id": "44444444-4444-4444-8444-444444444444",
        "installation_id": "55555555-5555-4555-8555-555555555555",
        "flow_id": "66666666-6666-4666-8666-666666666666",
        "run_id": "77777777-7777-4777-8777-777777777777",
        "tool": "compressor",
        "properties": {
          "tool_identifier": "compressor",
          "video_count": 1,
          "flow_id": "66666666-6666-4666-8666-666666666666",
          "run_id": "77777777-7777-4777-8777-777777777777"
        },
        "local_app_version": "0.6.1",
        "platform": "macos",
        "architecture": "arm64",
        "event_source": "web"
      }]$events$::jsonb
    )$$,
  array[true],
  'analytics v2 accepts the routing properties emitted by Wishly 0.6.1'
);

select results_eq(
  $$select accepted
    from public.ingest_analytics_events(
      '[{
        "event_id": "33333333-3333-4333-8333-333333333333",
        "event_name": "compression_started",
        "properties": {}
      }]'::jsonb
    )$$,
  array[true],
  'analytics v2 treats a repeated event id as delivered'
);

reset role;

select results_eq(
  $$select run_id, flow_id, properties
    from public.analytics_events
    where event_id = '33333333-3333-4333-8333-333333333333'$$,
  $$values (
    '77777777-7777-4777-8777-777777777777'::uuid,
    '66666666-6666-4666-8666-666666666666'::uuid,
    '{"tool_identifier": "compressor", "video_count": 1}'::jsonb
  )$$,
  'analytics v2 stores routing ids in columns and removes their property copies'
);

select results_eq(
  $$select count(*)
    from public.analytics_events
    where event_id = '33333333-3333-4333-8333-333333333333'$$,
  array[1::bigint],
  'analytics v2 ingestion remains idempotent'
);

set local role authenticated;

select is(public.is_admin(), false, 'a regular user is not an admin');

select throws_ok(
  $$select public.admin_overview(now() - interval '7 days', now())$$,
  '42501',
  'Administrator access required',
  'a non-admin cannot read admin aggregates'
);

select ok(
  not has_table_privilege('authenticated', 'public.admin_users', 'INSERT'),
  'a user cannot add themself to admin_users'
);

select ok(
  not has_table_privilege('authenticated', 'public.admin_users', 'SELECT'),
  'a user cannot read the admin list'
);

select ok(
  not has_table_privilege('authenticated', 'public.admin_users', 'DELETE'),
  'a user cannot delete an administrator'
);

select ok(
  not has_table_privilege('authenticated', 'public.analytics_events', 'UPDATE'),
  'a user cannot edit analytics events'
);

select ok(
  not has_table_privilege('authenticated', 'public.analytics_events', 'DELETE'),
  'a user cannot delete analytics events'
);

reset role;
insert into public.admin_users (user_id)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
set local role authenticated;
set local request.jwt.claim.sub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

select is(public.is_admin(), true, 'database membership confirms an admin');
select lives_ok(
  $$select public.admin_overview(now() - interval '7 days', now())$$,
  'an admin can read aggregate metrics'
);

select * from finish();
rollback;
