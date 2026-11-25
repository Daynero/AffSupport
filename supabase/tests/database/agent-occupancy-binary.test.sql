begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(9);

-- 20261224320000: an ad account is busy or free. A launch linked before assignments were
-- recorded ('legacy_unknown') holds the agent, and "Make free" lets it go with the rest.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('c0700000-0000-4000-8000-000000000001','authenticated','authenticated','occupancy-owner@test.invalid','{}','{}');
-- A platform admin's space is open whatever its tariff, as in the other launch fixtures.
insert into public.admin_users(user_id) values('c0700000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
 ('c0700000-0000-4000-8000-000000000011','Occupancy fixture','c0700000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('c0700000-0000-4000-8000-000000000011','c0700000-0000-4000-8000-000000000001','admin');
insert into public.team_accounts(id,team_id,created_by,name) values
 ('c0700000-0000-4000-8000-000000000051','c0700000-0000-4000-8000-000000000011','c0700000-0000-4000-8000-000000000001','Social');
insert into public.team_account_agents(id,team_id,account_id,created_by,agent_id) values
 ('c0700000-0000-4000-8000-000000000052','c0700000-0000-4000-8000-000000000011','c0700000-0000-4000-8000-000000000051','c0700000-0000-4000-8000-000000000001','agent-legacy'),
 ('c0700000-0000-4000-8000-000000000053','c0700000-0000-4000-8000-000000000011','c0700000-0000-4000-8000-000000000051','c0700000-0000-4000-8000-000000000001','agent-empty');
insert into public.team_launches(id,team_id,created_by,draft_config) values
 ('c0700000-0000-4000-8000-000000000101','c0700000-0000-4000-8000-000000000011','c0700000-0000-4000-8000-000000000001',
  '{"agentRowId":"c0700000-0000-4000-8000-000000000052"}'::jsonb),
 ('c0700000-0000-4000-8000-000000000102','c0700000-0000-4000-8000-000000000011','c0700000-0000-4000-8000-000000000001',
  '{"agentRowId":"c0700000-0000-4000-8000-000000000052"}'::jsonb);
-- One carried-over link and one confirmed assignment on the same agent.
insert into private.team_launch_assignments(launch_id,team_id,agent_row_id,source_agent_row_id,state) values
 ('c0700000-0000-4000-8000-000000000101','c0700000-0000-4000-8000-000000000011','c0700000-0000-4000-8000-000000000052','c0700000-0000-4000-8000-000000000052','legacy_unknown'),
 ('c0700000-0000-4000-8000-000000000102','c0700000-0000-4000-8000-000000000011','c0700000-0000-4000-8000-000000000052','c0700000-0000-4000-8000-000000000052','assigned');

select is(
  private.team_agent_availability('c0700000-0000-4000-8000-000000000011','c0700000-0000-4000-8000-000000000052'),
  '{"status":"busy","assignmentCount":1,"legacyCount":1}'::jsonb,
  'a carried-over link and a confirmed one both make the agent busy; the counts stay apart');
select is(
  private.team_agent_availability('c0700000-0000-4000-8000-000000000011','c0700000-0000-4000-8000-000000000053')->>'status',
  'free',
  'an agent holding nothing is free');

delete from private.team_launch_assignments where launch_id='c0700000-0000-4000-8000-000000000102';
select is(
  private.team_agent_availability('c0700000-0000-4000-8000-000000000011','c0700000-0000-4000-8000-000000000052')->>'status',
  'busy',
  'a carried-over link alone is busy, never "unknown"');

select ok(
  not exists(
    select 1 from pg_proc
     where oid = 'private.team_agent_availability(uuid,uuid)'::regprocedure
       and prosrc ~ '''unknown'''),
  'the availability never names a third state');

create temp table occupancy_results(label text primary key, result jsonb) on commit drop;
grant all on occupancy_results to authenticated;

select set_config('request.jwt.claim.sub','c0700000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"c0700000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;

insert into occupancy_results values ('state', public.get_team_agent_assignment_state(
  'c0700000-0000-4000-8000-000000000011','c0700000-0000-4000-8000-000000000052'));
insert into occupancy_results values ('release', public.release_team_agent_assignments(
  'c0700000-0000-4000-8000-000000000011','c0700000-0000-4000-8000-000000000052',
  (select result->>'version' from occupancy_results where label='state'),
  'occupancy-release-1'));

reset role;

select is((select (result->>'releasedCount')::int from occupancy_results where label='release'), 1,
  '"Make free" releases the carried-over link instead of refusing with WRONG_STATE');
select is((select result->'availability'->>'status' from occupancy_results where label='release'), 'free',
  'after the release the agent reads free');
select is(
  (select state from private.team_launch_assignments where launch_id='c0700000-0000-4000-8000-000000000101'),
  'released',
  'the link itself is released');
select is(
  (select previous_state from private.team_launch_assignment_events
    where launch_id='c0700000-0000-4000-8000-000000000101' and action='release_all'),
  'legacy_unknown',
  'the journal keeps what the link was before the release');
select ok(
  has_function_privilege('authenticated','public.release_team_agent_assignments(uuid,uuid,text,text)','execute')
  and not has_function_privilege('anon','public.release_team_agent_assignments(uuid,uuid,text,text)','execute')
  and not has_function_privilege('authenticated','private.team_agent_availability(uuid,uuid)','execute'),
  'grants are unchanged: members release, anonymous callers do not, the helper stays private');

select * from finish();
rollback;
