begin;
select plan(24);

-- 076: launches in tasks.
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('c7600000-0000-4000-8000-000000000001','authenticated','authenticated','tl-owner@test.invalid','{}','{}'),
 ('c7600000-0000-4000-8000-000000000002','authenticated','authenticated','tl-viewer@test.invalid','{}','{}'),
 ('c7600000-0000-4000-8000-000000000003','authenticated','authenticated','tl-stranger@test.invalid','{}','{}');
-- An admin owner keeps the fixture space open without a tariff row.
insert into public.admin_users(user_id) values('c7600000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
 ('c7600000-0000-4000-8000-000000000011','Links fixture','c7600000-0000-4000-8000-000000000001'),
 ('c7600000-0000-4000-8000-000000000012','Other fixture','c7600000-0000-4000-8000-000000000003');
insert into public.team_members(team_id,user_id,base_role) values
 ('c7600000-0000-4000-8000-000000000011','c7600000-0000-4000-8000-000000000001','admin'),
 ('c7600000-0000-4000-8000-000000000011','c7600000-0000-4000-8000-000000000002','viewer'),
 ('c7600000-0000-4000-8000-000000000012','c7600000-0000-4000-8000-000000000003','admin');
insert into public.team_tasks(id,team_id,created_by,title) values
 ('c7600000-0000-4000-8000-000000000021','c7600000-0000-4000-8000-000000000011','c7600000-0000-4000-8000-000000000001','Brief'),
 ('c7600000-0000-4000-8000-000000000022','c7600000-0000-4000-8000-000000000012','c7600000-0000-4000-8000-000000000003','Elsewhere');
insert into public.team_launches(id,team_id,created_by) values
 ('c7600000-0000-4000-8000-000000000031','c7600000-0000-4000-8000-000000000011','c7600000-0000-4000-8000-000000000001'),
 ('c7600000-0000-4000-8000-000000000032','c7600000-0000-4000-8000-000000000011','c7600000-0000-4000-8000-000000000001'),
 ('c7600000-0000-4000-8000-000000000033','c7600000-0000-4000-8000-000000000011','c7600000-0000-4000-8000-000000000001'),
 ('c7600000-0000-4000-8000-000000000034','c7600000-0000-4000-8000-000000000012','c7600000-0000-4000-8000-000000000003');
update public.team_launches set archived_at=now() where id='c7600000-0000-4000-8000-000000000033';

-- Structure.
select has_table('public','team_task_launches','the link table exists');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='public.team_task_launches'::regclass),'links force RLS');
select ok(not has_table_privilege('authenticated','public.team_task_launches','insert,update,delete'),'the browser writes only through the functions');
select ok(exists(select 1 from pg_trigger where tgrelid='public.team_task_launches'::regclass and tgname='task_cleanup_reference_fence'),'the link table carries the cleanup fence');
select ok(private.task_cleanup_coverage_verified(),'task cleanup coverage stays verified');
select is_empty($$
 select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in('attach_team_task_launches','create_team_task_with_launches',
   'detach_team_task_launch','list_team_task_launch_ids','list_team_launch_tasks')
 and (not p.prosecdef or not ('search_path=""'=any(p.proconfig)))
$$,'link functions are definer functions with a closed search path');

-- The owner links two launches; a repeat is not an error and adds nothing.
set local role authenticated;
set local request.jwt.claim.sub = 'c7600000-0000-4000-8000-000000000001';
select is(
 public.attach_team_task_launches('c7600000-0000-4000-8000-000000000011','c7600000-0000-4000-8000-000000000021',
   array['c7600000-0000-4000-8000-000000000031','c7600000-0000-4000-8000-000000000032']::uuid[])->'attached',
 '["c7600000-0000-4000-8000-000000000031", "c7600000-0000-4000-8000-000000000032"]'::jsonb,
 'two launches go into the task');
select is(
 public.attach_team_task_launches('c7600000-0000-4000-8000-000000000011','c7600000-0000-4000-8000-000000000021',
   array['c7600000-0000-4000-8000-000000000031']::uuid[]),
 '{"attached": [], "alreadyAttached": ["c7600000-0000-4000-8000-000000000031"]}'::jsonb,
 'already in the task is reported, not duplicated');
select is(
 public.list_team_task_launch_ids('c7600000-0000-4000-8000-000000000011','c7600000-0000-4000-8000-000000000021'),
 array['c7600000-0000-4000-8000-000000000031','c7600000-0000-4000-8000-000000000032']::uuid[],
 'the task lists its launches');
select is(
 jsonb_array_length(public.list_team_launch_tasks('c7600000-0000-4000-8000-000000000011',
   array['c7600000-0000-4000-8000-000000000031']::uuid[])),
 1,'a launch knows its task');
select is(
 public.list_team_launch_tasks('c7600000-0000-4000-8000-000000000011',
   array['c7600000-0000-4000-8000-000000000031']::uuid[])->0->>'title',
 'Brief','with the task title for the chip');

-- What cannot be linked.
select throws_ok($$select public.attach_team_task_launches('c7600000-0000-4000-8000-000000000011',
 'c7600000-0000-4000-8000-000000000021',array['c7600000-0000-4000-8000-000000000033']::uuid[])$$,
 'P0002',null,'a deleted launch is refused');
select throws_ok($$select public.attach_team_task_launches('c7600000-0000-4000-8000-000000000011',
 'c7600000-0000-4000-8000-000000000021',array['c7600000-0000-4000-8000-000000000034']::uuid[])$$,
 'P0002',null,'another space''s launch is refused');
select throws_ok($$select public.attach_team_task_launches('c7600000-0000-4000-8000-000000000011',
 'c7600000-0000-4000-8000-000000000022',array['c7600000-0000-4000-8000-000000000031']::uuid[])$$,
 'P0002',null,'another space''s task is refused');
select throws_ok($$select public.attach_team_task_launches('c7600000-0000-4000-8000-000000000011',
 'c7600000-0000-4000-8000-000000000021','{}'::uuid[])$$,'22023',null,'an empty set is refused');

-- A new task made of launches, in one step; a gone launch leaves no empty task behind.
select is(
 (public.create_team_task_with_launches('c7600000-0000-4000-8000-000000000011','From launches',
   array['c7600000-0000-4000-8000-000000000032']::uuid[])).title,
 'From launches','a task is made with its launches');
select is((select count(*)::integer from public.team_task_launches l join public.team_tasks t on t.id=l.task_id
 where t.title='From launches'),1,'and holds them');
select throws_ok($$select public.create_team_task_with_launches('c7600000-0000-4000-8000-000000000011','Ghost',
 array['c7600000-0000-4000-8000-000000000033']::uuid[])$$,'P0002',null,'a gone launch refuses the new task');
select is((select count(*)::integer from public.team_tasks where title='Ghost'),0,'and no empty task is left');

-- Taking one out leaves the launch where it is.
select lives_ok($$select public.detach_team_task_launch('c7600000-0000-4000-8000-000000000011',
 'c7600000-0000-4000-8000-000000000021','c7600000-0000-4000-8000-000000000032')$$,'a launch comes out of the task');
select is(
 public.list_team_task_launch_ids('c7600000-0000-4000-8000-000000000011','c7600000-0000-4000-8000-000000000021'),
 array['c7600000-0000-4000-8000-000000000031']::uuid[],'only the other one is left');

-- A viewer reads but cannot link; a stranger cannot read.
set local request.jwt.claim.sub = 'c7600000-0000-4000-8000-000000000002';
select throws_ok($$select public.attach_team_task_launches('c7600000-0000-4000-8000-000000000011',
 'c7600000-0000-4000-8000-000000000021',array['c7600000-0000-4000-8000-000000000032']::uuid[])$$,
 '42501',null,'a viewer cannot link');
set local request.jwt.claim.sub = 'c7600000-0000-4000-8000-000000000003';
select throws_ok($$select public.list_team_task_launch_ids('c7600000-0000-4000-8000-000000000011',
 'c7600000-0000-4000-8000-000000000021')$$,'42501',null,'a stranger cannot read the links');
reset role;

-- Deleting the launch takes its link with it.
delete from public.team_launches where id='c7600000-0000-4000-8000-000000000031';
select is((select count(*)::integer from public.team_task_launches
 where task_id='c7600000-0000-4000-8000-000000000021'),0,'a deleted launch leaves no link');

select * from finish();
rollback;
