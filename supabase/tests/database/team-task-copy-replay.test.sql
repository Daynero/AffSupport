begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(7);

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
values
  ('a0370000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'copy-owner-a@example.test', '{}', '{}'),
  ('a0370000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'copy-owner-b@example.test', '{}', '{}');
insert into public.admin_users (user_id) values
  ('a0370000-0000-4000-8000-000000000001'),
  ('a0370000-0000-4000-8000-000000000002');
insert into public.teams (id, name, owner_id) values
  ('a0370000-0000-4000-8000-000000000011', 'Copy A', 'a0370000-0000-4000-8000-000000000001'),
  ('a0370000-0000-4000-8000-000000000012', 'Copy B', 'a0370000-0000-4000-8000-000000000002');
insert into public.team_members (team_id, user_id, base_role) values
  ('a0370000-0000-4000-8000-000000000011', 'a0370000-0000-4000-8000-000000000001', 'admin'),
  ('a0370000-0000-4000-8000-000000000012', 'a0370000-0000-4000-8000-000000000002', 'admin');

select set_config('request.jwt.claim.sub', 'a0370000-0000-4000-8000-000000000001', true);
select is((select count(*)::int from public.team_tasks where team_id = 'a0370000-0000-4000-8000-000000000011'), 0, 'fixture starts empty');
create temporary table copy_fixture as
select id from public.create_team_task('a0370000-0000-4000-8000-000000000011', 'Original task');
create temporary table copy_result as
select public.copy_team_tasks(
  'a0370000-0000-4000-8000-000000000011',
  array[(select id from copy_fixture)],
  'a0370000-0000-4000-8000-000000000021'
) as ids;
select is((select cardinality(ids) from copy_result), 1, 'first request creates one task');
select is(
  public.copy_team_tasks(
    'a0370000-0000-4000-8000-000000000011',
    array[(select id from copy_fixture)],
    'a0370000-0000-4000-8000-000000000021'
  ),
  (select ids from copy_result),
  'replay returns the same receipt'
);
select is((select count(*)::int from public.team_tasks where team_id = 'a0370000-0000-4000-8000-000000000011'), 2, 'replay created no duplicate');
select throws_ok(
  $$select public.copy_team_tasks('a0370000-0000-4000-8000-000000000012', array[(select id from copy_fixture)], 'a0370000-0000-4000-8000-000000000022')$$,
  '42501', 'PERMISSION_DENIED', 'cannot copy into a foreign team'
);
select throws_ok(
  $$select public.copy_team_tasks('a0370000-0000-4000-8000-000000000011', array[(select ids[1] from copy_result)], 'a0370000-0000-4000-8000-000000000021')$$,
  '22023', 'REQUEST_REUSE_CONFLICT', 'request key cannot be reused for another source'
);
select ok(not has_table_privilege('authenticated', 'private.team_task_copy_requests', 'SELECT'), 'private receipts are not client-readable');

select * from finish();
rollback;
