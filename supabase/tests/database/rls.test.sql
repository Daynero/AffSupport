begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(18);

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
