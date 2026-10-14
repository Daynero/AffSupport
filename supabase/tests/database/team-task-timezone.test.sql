begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(5);

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
values
  ('b0370000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'timezone-owner@example.test', '{}', '{}'),
  ('b0370000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'timezone-outsider@example.test', '{}', '{}');
insert into public.admin_users (user_id) values
  ('b0370000-0000-4000-8000-000000000001');
insert into public.teams (id, name, owner_id)
values ('b0370000-0000-4000-8000-000000000011', 'Timezone space', 'b0370000-0000-4000-8000-000000000001');
insert into public.team_members (team_id, user_id, base_role)
values ('b0370000-0000-4000-8000-000000000011', 'b0370000-0000-4000-8000-000000000001', 'admin');

select set_config('request.jwt.claim.sub', 'b0370000-0000-4000-8000-000000000001', true);
select is(public.get_team_task_timezone('b0370000-0000-4000-8000-000000000011'), 'Europe/Kyiv', 'existing spaces have one default zone');
select is(public.set_team_task_timezone('b0370000-0000-4000-8000-000000000011', 'America/Los_Angeles'), 'America/Los_Angeles', 'owner may set an IANA zone');
select is(public.get_team_task_timezone('b0370000-0000-4000-8000-000000000011'), 'America/Los_Angeles', 'every reader sees the persisted zone');
select throws_ok(
  $$select public.set_team_task_timezone('b0370000-0000-4000-8000-000000000011', 'bad/zone')$$,
  '22023', 'INVALID_INPUT', 'invalid zone is rejected'
);
select set_config('request.jwt.claim.sub', 'b0370000-0000-4000-8000-000000000002', true);
select throws_ok(
  $$select public.get_team_task_timezone('b0370000-0000-4000-8000-000000000011')$$,
  '42501', 'PERMISSION_DENIED', 'outsider cannot read the zone'
);

select * from finish();
rollback;
