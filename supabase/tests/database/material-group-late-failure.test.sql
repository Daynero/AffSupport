begin;
select plan(9);
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('b1530000-0000-4000-8000-000000000001','authenticated','authenticated','overlap-native@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('b1530000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
 ('b1530000-0000-4000-8000-000000000011','Synthetic retry provenance','b1530000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('b1530000-0000-4000-8000-000000000011','b1530000-0000-4000-8000-000000000001','admin');
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('b1530000-0000-4000-8000-000000000021','b1530000-0000-4000-8000-000000000001','retry-synthetic','overlap-native@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('b1530000-0000-4000-8000-000000000031','b1530000-0000-4000-8000-000000000011','b1530000-0000-4000-8000-000000000021','retry-root','Synthetic root','my_drive','connected',now());

insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,mime_type)
select ('b1530000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
'b1530000-0000-4000-8000-000000000011','b1530000-0000-4000-8000-000000000031',
'dispatch-'||n,'retry-root','Synthetic dispatch '||n,'file','video/mp4'
from generate_series(41,44)n;
insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)
select ('b1530000-0000-4000-8000-'||lpad((n+10)::text,12,'0'))::uuid,
'b1530000-0000-4000-8000-000000000011','b1530000-0000-4000-8000-000000000001',
'trash','running',('b1530000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
'synthetic-dispatch-'||n,case when n=44 then 'request:legacy-dispatch' else 'group-v1:'||repeat('a',64)end
from generate_series(41,44)n;
insert into private.team_material_group_intents(id,team_id,source_material_id,operation_id,action,member_snapshot,state)
select ('b1530000-0000-4000-8000-'||lpad((n+20)::text,12,'0'))::uuid,
'b1530000-0000-4000-8000-000000000011',
('b1530000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
('b1530000-0000-4000-8000-'||lpad((n+10)::text,12,'0'))::uuid,'trash',
jsonb_build_array(jsonb_build_object('material_id',('b1530000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
'drive_file_id','dispatch-'||n,'resource_key',null,'parent_folder_id','retry-root','role','source')),'running'
from generate_series(41,44)n where n<>42;


select ok(not has_function_privilege('authenticated','public.service_mark_material_group_execution_reconciling(uuid,uuid,text)','execute'),'browser cannot report another executor failure');
select ok(has_function_privilege('service_role','public.service_mark_material_group_execution_reconciling(uuid,uuid,text)','execute'),'trusted service uses the owned failure seam');
select ok(not public.service_mark_material_group_reconciling('b1530000-0000-4000-8000-000000000061','DRIVE_UNAVAILABLE'),'legacy failure writer cannot change a managed intent');
select public.service_claim_material_group_execution('b1530000-0000-4000-8000-000000000061','b1530000-0000-4000-8000-000000000071');
select ok(public.service_mark_material_group_execution_reconciling('b1530000-0000-4000-8000-000000000061','b1530000-0000-4000-8000-000000000071','DRIVE_UNAVAILABLE'),'current open executor can retain its uncertain failure');
select ok(not public.service_mark_material_group_execution_reconciling('b1530000-0000-4000-8000-000000000061','b1530000-0000-4000-8000-000000000072','NOT_FOUND'),'replacement identity cannot alter the original failure');
select public.service_begin_material_group_dispatch('b1530000-0000-4000-8000-000000000061','b1530000-0000-4000-8000-000000000071','b1530000-0000-4000-8000-000000000041');
select public.service_checkpoint_material_group_execution('b1530000-0000-4000-8000-000000000061','b1530000-0000-4000-8000-000000000071','b1530000-0000-4000-8000-000000000041');
select public.service_complete_material_group_intent('b1530000-0000-4000-8000-000000000061');
select ok(not public.service_mark_material_group_execution_reconciling('b1530000-0000-4000-8000-000000000061','b1530000-0000-4000-8000-000000000071','DRIVE_UNAVAILABLE'),'late owner failure cannot change completed material');
select is((select placement_state from public.team_materials where id='b1530000-0000-4000-8000-000000000041'),'ready','late error retains ready placement');
select public.service_claim_material_group_execution('b1530000-0000-4000-8000-000000000063','b1530000-0000-4000-8000-000000000071');
select public.service_begin_material_group_dispatch('b1530000-0000-4000-8000-000000000063','b1530000-0000-4000-8000-000000000071','b1530000-0000-4000-8000-000000000043');
select public.service_checkpoint_material_group_execution('b1530000-0000-4000-8000-000000000063','b1530000-0000-4000-8000-000000000071','b1530000-0000-4000-8000-000000000043');
update public.team_materials set placement_state='moving' where id='b1530000-0000-4000-8000-000000000043';
select public.service_reconcile_confirmed_material_group('b1530000-0000-4000-8000-000000000011','b1530000-0000-4000-8000-000000000001','b1530000-0000-4000-8000-000000000053','b1530000-0000-4000-8000-000000000043','trash',null);
select ok((select state='succeeded' and execution_closed is true and dispatch_member is null from private.team_material_group_intents where id='b1530000-0000-4000-8000-000000000063'),'verified registration closes the finished marker without renewing provider permission');
select ok(public.service_mark_material_group_reconciling('b1530000-0000-4000-8000-000000000064','DRIVE_UNAVAILABLE'),'active legacy failure reporting remains available');
select * from finish();
rollback;
