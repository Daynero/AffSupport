begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(11);

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
('a0390000-0000-4000-8000-000000000001','authenticated','authenticated','overview-owner@example.test','{}','{}'),
('a0390000-0000-4000-8000-000000000002','authenticated','authenticated','overview-outsider@example.test','{}','{}');
insert into public.admin_users(user_id) values ('a0390000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
('a0390000-0000-4000-8000-000000000010','Overview fixture','a0390000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
('a0390000-0000-4000-8000-000000000010','a0390000-0000-4000-8000-000000000001','admin');

select set_config('request.jwt.claim.sub','a0390000-0000-4000-8000-000000000002',true);
select throws_ok($$select public.get_team_account_launch_finance_overview(
 'a0390000-0000-4000-8000-000000000010','2026-10-01','2026-10-31')$$,
 '42501','PERMISSION_DENIED','an outsider cannot read the account overview');
select set_config('request.jwt.claim.sub','a0390000-0000-4000-8000-000000000001',true);
select throws_ok($$select public.get_team_account_launch_finance_overview(
 'a0390000-0000-4000-8000-000000000010','2026-10-31','2026-10-01')$$,
 '22023','INVALID_PERIOD','reversed period is rejected');

insert into public.team_accounts(id,team_id,created_by,name) values
('a0390000-0000-4000-8000-000000000020','a0390000-0000-4000-8000-000000000010','a0390000-0000-4000-8000-000000000001','Social A'),
('a0390000-0000-4000-8000-000000000021','a0390000-0000-4000-8000-000000000010','a0390000-0000-4000-8000-000000000001','Social B');
insert into public.team_account_agents(id,team_id,account_id,created_by,agent_id,created_at) values
('a0390000-0000-4000-8000-000000000030','a0390000-0000-4000-8000-000000000010',
 'a0390000-0000-4000-8000-000000000020','a0390000-0000-4000-8000-000000000001','rk-1','2026-10-01T00:00:00Z');
update public.team_agent_placements set id='a0390000-0000-4000-8000-000000000040',ends_on='2026-10-10'
 where agent_row_id='a0390000-0000-4000-8000-000000000030';
insert into public.team_agent_finance_values
 (team_id,agent_row_id,placement_id,account_id,entry_date,metric,amount_cents) values
('a0390000-0000-4000-8000-000000000010','a0390000-0000-4000-8000-000000000030',
 'a0390000-0000-4000-8000-000000000040','a0390000-0000-4000-8000-000000000020',
 '2026-10-05','topup',0);
update public.team_account_agents set account_id='a0390000-0000-4000-8000-000000000021'
 where id='a0390000-0000-4000-8000-000000000030';
insert into public.team_agent_placements(id,team_id,agent_row_id,account_id,starts_on) values
('a0390000-0000-4000-8000-000000000041','a0390000-0000-4000-8000-000000000010',
 'a0390000-0000-4000-8000-000000000030','a0390000-0000-4000-8000-000000000021','2026-10-10');

insert into public.team_launches(id,team_id,created_by,draft_config,effective_launch_date) values
('a0390000-0000-4000-8000-000000000050','a0390000-0000-4000-8000-000000000010',
 'a0390000-0000-4000-8000-000000000001','{"agentRowId":"a0390000-0000-4000-8000-000000000030"}','2026-10-03'),
('a0390000-0000-4000-8000-000000000051','a0390000-0000-4000-8000-000000000010',
 'a0390000-0000-4000-8000-000000000001','{"agentRowId":"a0390000-0000-4000-8000-000000000099"}','2026-10-04'),
('a0390000-0000-4000-8000-000000000052','a0390000-0000-4000-8000-000000000010',
 'a0390000-0000-4000-8000-000000000001','{"agentRowId":"a0390000-0000-4000-8000-000000000030"}','2026-10-05');
insert into public.team_launch_revisions
 (id,team_id,launch_id,revision_no,result_kind,config,sources,original_url,generated_url,sub_values,created_by) values
('a0390000-0000-4000-8000-000000000060','a0390000-0000-4000-8000-000000000010',
 'a0390000-0000-4000-8000-000000000050',1,'manual','{}',
 '{"agentRowId":"a0390000-0000-4000-8000-000000000030","accountId":"a0390000-0000-4000-8000-000000000020","offer":"Offer A"}',
 'https://example.test/a','https://example.test/a','{}','a0390000-0000-4000-8000-000000000001'),
('a0390000-0000-4000-8000-000000000061','a0390000-0000-4000-8000-000000000010',
 'a0390000-0000-4000-8000-000000000051',1,'manual','{}',
 '{"agentRowId":"a0390000-0000-4000-8000-000000000099","accountId":"a0390000-0000-4000-8000-000000000020","offer":"Offer B"}',
 'https://example.test/b','https://example.test/b','{}','a0390000-0000-4000-8000-000000000001'),
('a0390000-0000-4000-8000-000000000062','a0390000-0000-4000-8000-000000000010',
 'a0390000-0000-4000-8000-000000000052',1,'manual','{}',
 '{"agentRowId":"a0390000-0000-4000-8000-000000000030","accountId":"a0390000-0000-4000-8000-000000000099","offer":"Offer C"}',
 'https://example.test/c','https://example.test/c','{}','a0390000-0000-4000-8000-000000000001');
update public.team_launches set active_revision_id=case id
 when 'a0390000-0000-4000-8000-000000000050' then 'a0390000-0000-4000-8000-000000000060'::uuid
 when 'a0390000-0000-4000-8000-000000000051' then 'a0390000-0000-4000-8000-000000000061'::uuid
 else 'a0390000-0000-4000-8000-000000000062'::uuid end;

create temporary table overview_result as select public.get_team_account_launch_finance_overview(
 'a0390000-0000-4000-8000-000000000010','2026-10-01','2026-10-31') as body;
select is((select jsonb_array_length(body->'socials') from overview_result),2,
 'both ordered socials are present');
select is((select body->'agents'->0->>'socialId' from overview_result),
 'a0390000-0000-4000-8000-000000000021','moved RK is under its current social');
select is((select body->'launches'->2->>'association' from overview_result),'moved',
 'revision snapshot keeps a launch linked to its historical social');
select is((select body->'launches'->1->>'unmatchedReason' from overview_result),'missing_agent',
 'missing RK remains an explicit unmatched launch');
select is((select body->'launches'->1->>'agentRowId' from overview_result),
 'a0390000-0000-4000-8000-000000000099','missing RK keeps its stable source ID');
select is((select body->'launches'->0->>'unmatchedReason' from overview_result),'missing_snapshot_social',
 'missing social snapshot is not assigned by label');
select is((select body->'launches'->0->>'snapshotSocialId' from overview_result),
 'a0390000-0000-4000-8000-000000000099','missing snapshot keeps its stable social ID');
select is((select body->'finance'->0->>'topupCents' from overview_result),'0',
 'recorded zero remains zero on the historical placement');
select ok((select body->'finance'->1->'topupCents'='null'::jsonb from overview_result),
 'new placement with no finance row remains null');
select * from finish();
rollback;
