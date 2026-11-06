begin;
select plan(10);

select ok(not has_table_privilege('anon','public.analytics_workspace_operations','select'),'anonymous callers cannot read workspace diagnostics');
select ok(not has_table_privilege('authenticated','public.analytics_workspace_operations','select'),'browser callers cannot read workspace diagnostics');
select ok(has_table_privilege('service_role','public.analytics_workspace_operations','select'),'service can read restricted workspace diagnostics');
select is_empty($$select column_name from information_schema.columns where table_schema='public'
 and table_name='analytics_workspace_operations' and column_name in('name','source_material_id','idempotency_key','request_nonce','error_detail')$$,
 'restore diagnostics omit content and request secrets');

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('b1470000-0000-4000-8000-000000000001','authenticated','authenticated','restore-native@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('b1470000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
 ('b1470000-0000-4000-8000-000000000011','Synthetic restore diagnostics','b1470000-0000-4000-8000-000000000001');
insert into public.team_operations(id,team_id,actor_id,kind,state,idempotency_key,request_nonce,error_code,finished_at)
 select gen_random_uuid(),'b1470000-0000-4000-8000-000000000011','b1470000-0000-4000-8000-000000000001',
 'restore',state,'restore-'||state,'restore-'||state,
 case when state='running' then 'PROCESS_RESULT_UNCERTAIN' when state='failed' then 'legacy private failure detail' else null end,
 case when state in ('succeeded','failed','canceled') then now() else null end
 from unnest(array['pending','running','succeeded','failed','canceled']) state;

select is((select count(*)::integer from public.analytics_workspace_operations where team_id='b1470000-0000-4000-8000-000000000011' and action='restore'),5,'all hosted restore states are visible without browser events');
select is((select state||':'||confirmed_count from public.analytics_workspace_operations where team_id='b1470000-0000-4000-8000-000000000011' and state='pending'),'pending:0','pending is unconfirmed');
select is((select state||':'||code||':'||confirmed_count from public.analytics_workspace_operations where team_id='b1470000-0000-4000-8000-000000000011' and state='running'),'running:PROCESS_RESULT_UNCERTAIN:0','running uncertainty is retained');
select is((select state||':'||confirmed_count from public.analytics_workspace_operations where team_id='b1470000-0000-4000-8000-000000000011' and state='confirmed'),'confirmed:1','only succeeded confirms restoration');
select is((select code from public.analytics_workspace_operations where team_id='b1470000-0000-4000-8000-000000000011' and state='failed'),'UNKNOWN','unrecognized legacy failure text never leaves the projection');
select is((select state||':'||confirmed_count from public.analytics_workspace_operations where team_id='b1470000-0000-4000-8000-000000000011' and state='cancelled'),'cancelled:0','canceled is not restored');

select * from finish();
rollback;
