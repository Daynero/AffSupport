begin;
select plan(12);
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('b1520000-0000-4000-8000-000000000001','authenticated','authenticated','overlap-native@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('b1520000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
 ('b1520000-0000-4000-8000-000000000011','Synthetic retry provenance','b1520000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('b1520000-0000-4000-8000-000000000011','b1520000-0000-4000-8000-000000000001','admin');
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('b1520000-0000-4000-8000-000000000021','b1520000-0000-4000-8000-000000000001','retry-synthetic','overlap-native@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('b1520000-0000-4000-8000-000000000031','b1520000-0000-4000-8000-000000000011','b1520000-0000-4000-8000-000000000021','retry-root','Synthetic root','my_drive','connected',now());

insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,mime_type)
select ('b1520000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
'b1520000-0000-4000-8000-000000000011','b1520000-0000-4000-8000-000000000031',
'dispatch-'||n,'retry-root','Synthetic dispatch '||n,'file','video/mp4'
from generate_series(41,44)n;
insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)
select ('b1520000-0000-4000-8000-'||lpad((n+10)::text,12,'0'))::uuid,
'b1520000-0000-4000-8000-000000000011','b1520000-0000-4000-8000-000000000001',
'trash','running',('b1520000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
'synthetic-dispatch-'||n,case when n=44 then 'request:legacy-dispatch' else 'group-v1:'||repeat('a',64)end
from generate_series(41,44)n;
insert into private.team_material_group_intents(id,team_id,source_material_id,operation_id,action,member_snapshot,state)
select ('b1520000-0000-4000-8000-'||lpad((n+20)::text,12,'0'))::uuid,
'b1520000-0000-4000-8000-000000000011',
('b1520000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
('b1520000-0000-4000-8000-'||lpad((n+10)::text,12,'0'))::uuid,'trash',
jsonb_build_array(jsonb_build_object('material_id',('b1520000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
'drive_file_id','dispatch-'||n,'resource_key',null,'parent_folder_id','retry-root','role','source')),'running'
from generate_series(41,44)n where n<>42;


select ok(not has_function_privilege('authenticated','public.service_reconcile_confirmed_material_group(uuid,uuid,uuid,uuid,text,uuid)','execute'),'browser cannot complete a hosted group directly');
select ok(has_function_privilege('service_role','public.service_reconcile_confirmed_material_group(uuid,uuid,uuid,uuid,text,uuid)','execute'),'trusted service can reconcile existing completion');
select throws_ok($q$select public.service_reconcile_confirmed_material_group('b1520000-0000-4000-8000-000000000011','b1520000-0000-4000-8000-000000000001','b1520000-0000-4000-8000-000000000054','b1520000-0000-4000-8000-000000000044','trash',null)$q$,'55000','PROCESS_RESULT_UNCERTAIN','legacy intent is never assumed to be a confirmed managed run');
select throws_ok($q$select public.service_reconcile_confirmed_material_group('b1520000-0000-4000-8000-000000000011','b1520000-0000-4000-8000-000000000002','b1520000-0000-4000-8000-000000000051','b1520000-0000-4000-8000-000000000041','trash',null)$q$,'42501','PERMISSION_DENIED','replacement actor cannot reconcile the original operation');
select throws_ok($q$select public.service_reconcile_confirmed_material_group('b1520000-0000-4000-8000-000000000011','b1520000-0000-4000-8000-000000000001','b1520000-0000-4000-8000-000000000051','b1520000-0000-4000-8000-000000000043','trash',null)$q$,'22023','REQUEST_REUSE_CONFLICT','different source cannot reuse the completion receipt');
update public.team_materials set placement_state='moving' where id='b1520000-0000-4000-8000-000000000041';
select public.service_claim_material_group_execution('b1520000-0000-4000-8000-000000000061','b1520000-0000-4000-8000-000000000071');
select public.service_begin_material_group_dispatch('b1520000-0000-4000-8000-000000000061','b1520000-0000-4000-8000-000000000071','b1520000-0000-4000-8000-000000000041');
select throws_ok($q$select public.service_reconcile_confirmed_material_group('b1520000-0000-4000-8000-000000000011','b1520000-0000-4000-8000-000000000001','b1520000-0000-4000-8000-000000000051','b1520000-0000-4000-8000-000000000041','trash',null)$q$,'55000','GROUP_RECONCILING','unconfirmed dispatch remains held without provider retry');
select public.service_checkpoint_material_group_execution('b1520000-0000-4000-8000-000000000061','b1520000-0000-4000-8000-000000000071','b1520000-0000-4000-8000-000000000041');
select is(public.service_reconcile_confirmed_material_group('b1520000-0000-4000-8000-000000000011','b1520000-0000-4000-8000-000000000001','b1520000-0000-4000-8000-000000000051','b1520000-0000-4000-8000-000000000041','trash',null)->>'state','succeeded','all acknowledged members complete the original intent');
select is((select lifecycle from public.team_materials where id='b1520000-0000-4000-8000-000000000041'),'trashed','completion records the acknowledged lifecycle');
select is((select state from public.team_operations where id='b1520000-0000-4000-8000-000000000051'),'succeeded','same accepted parent receives completion');
select throws_ok($q$select public.service_reconcile_confirmed_material_group('b1520000-0000-4000-8000-000000000011','b1520000-0000-4000-8000-000000000001','b1520000-0000-4000-8000-000000000051','b1520000-0000-4000-8000-000000000041','trash',null)$q$,'55000','PROCESS_RESULT_UNCERTAIN','terminal receipt is not a current-generation success proof');
select ok(public.service_reconcile_confirmed_material_group('b1520000-0000-4000-8000-000000000011','b1520000-0000-4000-8000-000000000001','b1520000-0000-4000-8000-000000000053','b1520000-0000-4000-8000-000000000043','trash',null) is null,'partial acknowledgement never becomes completed');
select is((select state from public.team_operations where id='b1520000-0000-4000-8000-000000000053'),'running','partial original operation remains active');
select * from finish();
rollback;
