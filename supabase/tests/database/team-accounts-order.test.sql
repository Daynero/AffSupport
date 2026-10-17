begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(13);

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data) values
('a0380000-0000-4000-8000-000000000001','authenticated','authenticated','order-owner@example.test','{}','{}'),
('a0380000-0000-4000-8000-000000000002','authenticated','authenticated','order-outsider@example.test','{}','{}');
insert into public.admin_users(user_id) values ('a0380000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
('a0380000-0000-4000-8000-000000000011','Order A','a0380000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
('a0380000-0000-4000-8000-000000000011','a0380000-0000-4000-8000-000000000001','admin');

select set_config('request.jwt.claim.sub','a0380000-0000-4000-8000-000000000001',true);
insert into public.team_accounts(id,team_id,created_by,name) values
('a0380000-0000-4000-8000-000000000021','a0380000-0000-4000-8000-000000000011','a0380000-0000-4000-8000-000000000001','v31'),
('a0380000-0000-4000-8000-000000000022','a0380000-0000-4000-8000-000000000011','a0380000-0000-4000-8000-000000000001','v2'),
('a0380000-0000-4000-8000-000000000023','a0380000-0000-4000-8000-000000000011','a0380000-0000-4000-8000-000000000001','v3');
select ok(private.team_natural_order_key('v2') < private.team_natural_order_key('v3')
  and private.team_natural_order_key('v3') < private.team_natural_order_key('v31'),
  'natural migration key keeps v2, v3, v31');
select is((select array_agg(id order by sort_rank) from public.team_accounts
  where team_id='a0380000-0000-4000-8000-000000000011'),
  array['a0380000-0000-4000-8000-000000000021','a0380000-0000-4000-8000-000000000022',
    'a0380000-0000-4000-8000-000000000023']::uuid[], 'new socials append in insertion order');
select is((public.get_team_account_order('a0380000-0000-4000-8000-000000000011')->>'socials_version')::bigint,
  3::bigint, 'three inserts advance the social version');

create temporary table order_result as select public.reorder_team_accounts(
  'a0380000-0000-4000-8000-000000000011', 'a0380000-0000-4000-8000-000000000011',
  array['a0380000-0000-4000-8000-000000000022','a0380000-0000-4000-8000-000000000023',
    'a0380000-0000-4000-8000-000000000021']::uuid[], 3,
  'a0380000-0000-4000-8000-000000000031') as result;
select is((select result->>'status' from order_result), 'applied', 'valid complete reorder applies');
select is((select result->>'version' from order_result), '4', 'reorder advances the scope version');
select is(public.reorder_team_accounts(
  'a0380000-0000-4000-8000-000000000011', 'a0380000-0000-4000-8000-000000000011',
  array['a0380000-0000-4000-8000-000000000022','a0380000-0000-4000-8000-000000000023',
    'a0380000-0000-4000-8000-000000000021']::uuid[], 3,
  'a0380000-0000-4000-8000-000000000031'),
  (select result from order_result), 'same request replays the receipt');
select is((public.reorder_team_accounts(
  'a0380000-0000-4000-8000-000000000011', 'a0380000-0000-4000-8000-000000000011',
  array['a0380000-0000-4000-8000-000000000021','a0380000-0000-4000-8000-000000000022',
    'a0380000-0000-4000-8000-000000000023']::uuid[], 3,
  'a0380000-0000-4000-8000-000000000032')->>'status'), 'conflict',
  'stale editor receives a version conflict');
select throws_ok($$select public.reorder_team_accounts(
  'a0380000-0000-4000-8000-000000000011','a0380000-0000-4000-8000-000000000011',
  array['a0380000-0000-4000-8000-000000000021']::uuid[],4,
  'a0380000-0000-4000-8000-000000000033')$$,
  '22023','INVALID_INPUT','incomplete membership is rejected');

insert into public.team_account_agents(id,team_id,account_id,created_by,agent_id) values
('a0380000-0000-4000-8000-000000000041','a0380000-0000-4000-8000-000000000011','a0380000-0000-4000-8000-000000000022','a0380000-0000-4000-8000-000000000001','rk10'),
('a0380000-0000-4000-8000-000000000042','a0380000-0000-4000-8000-000000000011','a0380000-0000-4000-8000-000000000023','a0380000-0000-4000-8000-000000000001','rk2');
select throws_ok($$select public.reorder_team_accounts(
  'a0380000-0000-4000-8000-000000000011','a0380000-0000-4000-8000-000000000022',
  array['a0380000-0000-4000-8000-000000000042']::uuid[],1,
  'a0380000-0000-4000-8000-000000000035')$$,
  '22023','INVALID_INPUT','an agent from another parent cannot enter the order');
update public.team_account_agents set account_id='a0380000-0000-4000-8000-000000000023'
  where id='a0380000-0000-4000-8000-000000000041';
select is((select sort_rank from public.team_account_agents where id='a0380000-0000-4000-8000-000000000041'),
  2::bigint, 'move appends in the destination scope');
select is((public.get_team_account_order('a0380000-0000-4000-8000-000000000011')->'agents'->
  'a0380000-0000-4000-8000-000000000023'->>'version')::bigint,
  2::bigint, 'move advances destination version');

select set_config('request.jwt.claim.sub','a0380000-0000-4000-8000-000000000002',true);
select throws_ok($$select public.reorder_team_accounts(
  'a0380000-0000-4000-8000-000000000011','a0380000-0000-4000-8000-000000000011',
  array[]::uuid[],4,'a0380000-0000-4000-8000-000000000034')$$,
  '42501','PERMISSION_DENIED','outsider cannot reorder');

-- Simulate pre-migration rows with no rank using the migration's backfill
-- expression. A temporary table keeps the live constraints untouched.
create temporary table rank_fixture as
  select id, team_id, name, null::bigint as sort_rank from public.team_accounts
  where team_id='a0380000-0000-4000-8000-000000000011';
with ranked as (
  select id, row_number() over (
    partition by team_id order by private.team_natural_order_key(name), lower(name), id
  ) as rank from rank_fixture
)
update rank_fixture a set sort_rank = ranked.rank from ranked where ranked.id = a.id;
select is((select array_agg(name order by sort_rank) from rank_fixture),
  array['v2','v3','v31']::text[], 'backfill preserves the former natural order');

select * from finish();
rollback;
