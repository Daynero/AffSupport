begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(24);

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
('a0400000-0000-4000-8000-000000000001','authenticated','authenticated','archive-owner@example.test','{}','{}'),
('a0400000-0000-4000-8000-000000000002','authenticated','authenticated','archive-outsider@example.test','{}','{}');
insert into public.admin_users(user_id) values ('a0400000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
('a0400000-0000-4000-8000-000000000010','Archive fixture','a0400000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
('a0400000-0000-4000-8000-000000000010','a0400000-0000-4000-8000-000000000001','admin');
select set_config('request.jwt.claim.sub','a0400000-0000-4000-8000-000000000001',true);
insert into public.team_accounts(id,team_id,created_by,name) values
('a0400000-0000-4000-8000-000000000020','a0400000-0000-4000-8000-000000000010',
 'a0400000-0000-4000-8000-000000000001','Archived social');
insert into public.team_account_agents(id,team_id,account_id,created_by,agent_id) values
('a0400000-0000-4000-8000-000000000030','a0400000-0000-4000-8000-000000000010',
 'a0400000-0000-4000-8000-000000000020','a0400000-0000-4000-8000-000000000001','rk-archive');
insert into public.team_launches(id,team_id,created_by,draft_config,work_status) values
('a0400000-0000-4000-8000-000000000040','a0400000-0000-4000-8000-000000000010',
 'a0400000-0000-4000-8000-000000000001',
 '{"agentRowId":"a0400000-0000-4000-8000-000000000030"}','in_progress');

select set_config('request.jwt.claim.sub','a0400000-0000-4000-8000-000000000002',true);
select throws_ok($$select public.set_team_account_archived(
 'a0400000-0000-4000-8000-000000000010','a0400000-0000-4000-8000-000000000020',
 true,0,'a0400000-0000-4000-8000-000000000050')$$,
 '42501','PERMISSION_DENIED','outsider cannot archive');
select throws_ok($$select public.list_team_accounts_by_state(
 'a0400000-0000-4000-8000-000000000010','archived')$$,
 '42501','PERMISSION_DENIED','outsider cannot list archived socials');
select set_config('request.jwt.claim.sub','a0400000-0000-4000-8000-000000000001',true);
select throws_ok($$select public.set_team_account_archived(
 'a0400000-0000-4000-8000-000000000010','a0400000-0000-4000-8000-000000000020',
 true,0,'a0400000-0000-4000-8000-000000000050')$$,
 '23514','ACTIVE_LAUNCH','active launch blocks archive');
select is((select archive_version from public.team_accounts where id='a0400000-0000-4000-8000-000000000020'),
 0::bigint,'refused archive leaves version unchanged');

update public.team_launches set work_status='done'
 where id='a0400000-0000-4000-8000-000000000040';
select is((public.set_team_account_archived(
 'a0400000-0000-4000-8000-000000000010','a0400000-0000-4000-8000-000000000020',
 true,0,'a0400000-0000-4000-8000-000000000050')->>'status'),
 'applied','completed launch permits archive');
select is((public.set_team_account_archived(
 'a0400000-0000-4000-8000-000000000010','a0400000-0000-4000-8000-000000000020',
 true,0,'a0400000-0000-4000-8000-000000000050')->>'version'),
 '1','same request returns the durable receipt');
select is((select count(*) from public.analytics_account_archive_receipts
 where request_id='a0400000-0000-4000-8000-000000000050'),
 1::bigint,'one committed archive yields one read-only receipt');
select ok(not has_table_privilege('authenticated', 'public.analytics_account_archive_receipts', 'select'),
 'ordinary members cannot read cross-team archive receipts');
select is((public.set_team_account_archived(
 'a0400000-0000-4000-8000-000000000010','a0400000-0000-4000-8000-000000000020',
 false,0,'a0400000-0000-4000-8000-000000000051')->>'status'),
 'conflict','stale version cannot restore');
select is((select count(*) from public.list_team_accounts('a0400000-0000-4000-8000-000000000010')),
 0::bigint,'archived social disappears from active reader');
select is((select count(*) from public.list_team_accounts_by_state(
 'a0400000-0000-4000-8000-000000000010','archived')),
 1::bigint,'archived social remains searchable');
select is((select count(*) from public.team_account_agents
 where account_id='a0400000-0000-4000-8000-000000000020'),
 1::bigint,'agent identity survives archive');
select is((select count(*) from public.team_launches
 where id='a0400000-0000-4000-8000-000000000040'),
 1::bigint,'launch history survives archive');
select ok((public.get_team_account_launch_finance_overview(
 'a0400000-0000-4000-8000-000000000010','2026-10-01','2026-10-31')
 ->'socials'->0->>'archivedAt') is not null,
 'combined overview marks archived social while retaining its identity');
select is((public.get_team_account_launch_finance_overview(
 'a0400000-0000-4000-8000-000000000010','2026-10-01','2026-10-31')
 ->'launches'->0->>'association'), 'unmatched',
 'launch without a captured social is not silently reassigned');
select throws_ok($$insert into public.team_launches(id,team_id,created_by,draft_config)
 values('a0400000-0000-4000-8000-000000000041','a0400000-0000-4000-8000-000000000010',
 'a0400000-0000-4000-8000-000000000001',
 '{"agentRowId":"a0400000-0000-4000-8000-000000000030"}')$$,
 '23514','ACCOUNT_ARCHIVED','archived social cannot gain active launch');
select throws_ok($$insert into public.team_account_agents(id,team_id,account_id,created_by,agent_id)
 values('a0400000-0000-4000-8000-000000000031','a0400000-0000-4000-8000-000000000010',
 'a0400000-0000-4000-8000-000000000020','a0400000-0000-4000-8000-000000000001','new-rk')$$,
 '23514','ACCOUNT_ARCHIVED','archived social cannot gain a new RK');
select throws_ok($$update public.team_account_agents set agent_id='changed-rk'
 where id='a0400000-0000-4000-8000-000000000030'$$,
 '23514','ACCOUNT_ARCHIVED','archived social cannot mutate an existing RK');
select throws_ok($$select public.delete_team_account(
 'a0400000-0000-4000-8000-000000000010','a0400000-0000-4000-8000-000000000020')$$,
 '23514','ACCOUNT_HAS_HISTORY','delete cannot erase archived history');
select is((public.set_team_account_archived(
 'a0400000-0000-4000-8000-000000000010','a0400000-0000-4000-8000-000000000020',
 false,1,'a0400000-0000-4000-8000-000000000052')->>'status'),
 'applied','restoration succeeds');
select is((select count(*) from public.list_team_accounts('a0400000-0000-4000-8000-000000000010')),
 1::bigint,'restored social reappears in active order');
select throws_ok($$select public.delete_team_account(
 'a0400000-0000-4000-8000-000000000010','a0400000-0000-4000-8000-000000000020')$$,
 '23514','ACCOUNT_HAS_HISTORY','restored account with a completed launch still cannot lose its RK identity');

insert into public.team_accounts(id,team_id,created_by,name) values
('a0400000-0000-4000-8000-000000000021','a0400000-0000-4000-8000-000000000010',
 'a0400000-0000-4000-8000-000000000001','Second social');
select is((public.reorder_team_accounts(
 'a0400000-0000-4000-8000-000000000010','a0400000-0000-4000-8000-000000000010',
 array['a0400000-0000-4000-8000-000000000021','a0400000-0000-4000-8000-000000000020']::uuid[],
 (public.get_team_account_order('a0400000-0000-4000-8000-000000000010')->>'socials_version')::bigint,
 'a0400000-0000-4000-8000-000000000053')->>'status'),
 'applied','manual order puts the second social first');
select public.set_team_account_archived(
 'a0400000-0000-4000-8000-000000000010','a0400000-0000-4000-8000-000000000020',
 true,2,'a0400000-0000-4000-8000-000000000054');
select public.set_team_account_archived(
 'a0400000-0000-4000-8000-000000000010','a0400000-0000-4000-8000-000000000020',
 false,3,'a0400000-0000-4000-8000-000000000055');
select is((select array_agg(id order by sort_rank) from public.team_accounts
 where team_id='a0400000-0000-4000-8000-000000000010'),
 array['a0400000-0000-4000-8000-000000000021','a0400000-0000-4000-8000-000000000020']::uuid[],
 'archive and restore preserve the manual rank');

select * from finish();
rollback;
