begin;
select plan(30);
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('b1510000-0000-4000-8000-000000000001','authenticated','authenticated','overlap-native@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('b1510000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
 ('b1510000-0000-4000-8000-000000000011','Synthetic retry provenance','b1510000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('b1510000-0000-4000-8000-000000000011','b1510000-0000-4000-8000-000000000001','admin');
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('b1510000-0000-4000-8000-000000000021','b1510000-0000-4000-8000-000000000001','retry-synthetic','overlap-native@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('b1510000-0000-4000-8000-000000000031','b1510000-0000-4000-8000-000000000011','b1510000-0000-4000-8000-000000000021','retry-root','Synthetic root','my_drive','connected',now());

insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,mime_type)
select ('b1510000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
'b1510000-0000-4000-8000-000000000011','b1510000-0000-4000-8000-000000000031',
'dispatch-'||n,'retry-root','Synthetic dispatch '||n,'file','video/mp4'
from generate_series(41,44)n;
insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)
select ('b1510000-0000-4000-8000-'||lpad((n+10)::text,12,'0'))::uuid,
'b1510000-0000-4000-8000-000000000011','b1510000-0000-4000-8000-000000000001',
'trash','running',('b1510000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
'synthetic-dispatch-'||n,case when n=44 then 'request:legacy-dispatch' else 'group-v1:'||repeat('a',64)end
from generate_series(41,44)n;
insert into private.team_material_group_intents(id,team_id,source_material_id,operation_id,action,member_snapshot,state)
select ('b1510000-0000-4000-8000-'||lpad((n+20)::text,12,'0'))::uuid,
'b1510000-0000-4000-8000-000000000011',
('b1510000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
('b1510000-0000-4000-8000-'||lpad((n+10)::text,12,'0'))::uuid,'trash',
jsonb_build_array(jsonb_build_object('material_id',('b1510000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
'drive_file_id','dispatch-'||n,'resource_key',null,'parent_folder_id','retry-root','role','source')),'running'
from generate_series(41,44)n where n<>42;

select ok(not public.service_checkpoint_material_group_intent('b1510000-0000-4000-8000-000000000061','b1510000-0000-4000-8000-000000000041'),'legacy checkpoint cannot bypass managed dispatch ownership');
select is(public.service_claim_material_group_execution('b1510000-0000-4000-8000-000000000061','b1510000-0000-4000-8000-000000000071')->>'acquired','true','first invocation reserves the existing intent');
select is(public.service_claim_material_group_execution('b1510000-0000-4000-8000-000000000061','b1510000-0000-4000-8000-000000000071')->>'acquired','false','same reservation replay is readback, not dispatch permission');
select is(public.service_claim_material_group_execution('b1510000-0000-4000-8000-000000000061','b1510000-0000-4000-8000-000000000072')->>'acquired','false','another invocation cannot reuse an active owner');
select ok(public.service_begin_material_group_dispatch('b1510000-0000-4000-8000-000000000061','b1510000-0000-4000-8000-000000000071','b1510000-0000-4000-8000-000000000041'),'member reserved before provider IO');
select ok(not public.service_begin_material_group_dispatch('b1510000-0000-4000-8000-000000000061','b1510000-0000-4000-8000-000000000071','b1510000-0000-4000-8000-000000000041'),'a pending member is never issued twice');
select ok(not public.service_checkpoint_material_group_execution('b1510000-0000-4000-8000-000000000061','b1510000-0000-4000-8000-000000000072','b1510000-0000-4000-8000-000000000041'),'wrong invocation cannot confirm another member');
select ok(public.service_end_material_group_execution('b1510000-0000-4000-8000-000000000061','b1510000-0000-4000-8000-000000000071'),'uncertain executor closes without clearing its member');
select is(public.service_claim_material_group_execution('b1510000-0000-4000-8000-000000000061','b1510000-0000-4000-8000-000000000072')->>'acquired','false','closed unknown dispatch remains held');
select is((select state from public.analytics_material_group_execution where id='b1510000-0000-4000-8000-000000000061'),'dispatch_unconfirmed','diagnostic projection does not call a reservation execution');
select is((select confirmed_count from public.analytics_material_group_execution where id='b1510000-0000-4000-8000-000000000061'),0,'unknown provider reply is not confirmed');
select throws_ok($q$insert into private.team_material_group_intents(team_id,source_material_id,operation_id,action,member_snapshot,state)values(
'b1510000-0000-4000-8000-000000000011','b1510000-0000-4000-8000-000000000042','b1510000-0000-4000-8000-000000000052','trash',
'[{"material_id":"b1510000-0000-4000-8000-000000000042","role":"source"},{"material_id":"b1510000-0000-4000-8000-000000000041","role":"transcript"}]','running')$q$,'55000','GROUP_RECONCILING','a shared sidecar cannot bypass the original intent');
select is(public.service_claim_material_group_execution('b1510000-0000-4000-8000-000000000063','b1510000-0000-4000-8000-000000000071')->>'acquired','true','independent material can execute');
select ok(public.service_begin_material_group_dispatch('b1510000-0000-4000-8000-000000000063','b1510000-0000-4000-8000-000000000071','b1510000-0000-4000-8000-000000000043'),'second material gets its own reservation');
select ok(public.service_end_material_group_execution('b1510000-0000-4000-8000-000000000063','b1510000-0000-4000-8000-000000000071','b1510000-0000-4000-8000-000000000043',null),'positive no-dispatch closure clears only its own member');
select is(public.service_claim_material_group_execution('b1510000-0000-4000-8000-000000000063','b1510000-0000-4000-8000-000000000072')->>'acquired','true','same intent can resume after known no-dispatch closure');
select ok(not public.service_end_material_group_execution('b1510000-0000-4000-8000-000000000063','b1510000-0000-4000-8000-000000000071'),'old owner cannot close a replacement invocation');
select ok(public.service_begin_material_group_dispatch('b1510000-0000-4000-8000-000000000063','b1510000-0000-4000-8000-000000000072','b1510000-0000-4000-8000-000000000043'),'replacement invocation reserves its member once');
select ok(public.service_checkpoint_material_group_execution('b1510000-0000-4000-8000-000000000063','b1510000-0000-4000-8000-000000000072','b1510000-0000-4000-8000-000000000043'),'verified response confirms exactly the held member');
select is(public.service_claim_material_group_execution('b1510000-0000-4000-8000-000000000063','b1510000-0000-4000-8000-000000000071')->>'completed','true','all acknowledgements read back without another execution');
select is(public.service_complete_material_group_intent('b1510000-0000-4000-8000-000000000063')->>'state','succeeded','existing completion authority registers the confirmed group');
select is(public.service_claim_material_group_execution('b1510000-0000-4000-8000-000000000064','b1510000-0000-4000-8000-000000000071')->>'acquired','false','legacy execution never becomes an unexecuted managed reservation');
select ok((select execution_protocol is null and execution_owner is null and execution_closed is null from private.team_material_group_intents where id='b1510000-0000-4000-8000-000000000064'),'legacy metadata stays unknown');
select throws_ok($q$update private.team_material_group_intents set execution_protocol=null where id='b1510000-0000-4000-8000-000000000061'$q$,'23514',null,'mixed legacy and managed accounting is invalid');
select ok(not has_function_privilege('authenticated','public.service_claim_material_group_execution(uuid,uuid)','execute'),'browser role cannot claim provider execution');
select ok(has_function_privilege('service_role','public.service_claim_material_group_execution(uuid,uuid)','execute'),'trusted service owns claim authority');
select ok(not has_table_privilege('anon','public.analytics_material_group_execution','select'),'anonymous role cannot read execution metadata');
select ok(has_table_privilege('wishly_analytics_ro','public.analytics_material_group_execution','select'),'SELECT-only diagnostics can read bounded execution state');
select ok(not exists(select 1 from information_schema.columns where table_schema='public' and table_name='analytics_material_group_execution' and column_name in('member_snapshot','drive_file_id','execution_owner','name','parent_folder_id')),'projection excludes provider and content fields');
select ok(exists(select 1 from private.task_cleanup_reference_tables() where schema_name='private' and table_name='team_material_group_intents') and exists(select 1 from pg_trigger where tgrelid='private.team_material_group_intents'::regclass and tgname='task_cleanup_reference_fence' and tgenabled<>'D'),'existing cleanup inventory and row fence cover the new member marker');
select * from finish();
rollback;
