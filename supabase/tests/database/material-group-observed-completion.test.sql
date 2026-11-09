begin;
select plan(6);
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('b1540000-0000-4000-8000-000000000001','authenticated','authenticated','overlap-native@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('b1540000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
 ('b1540000-0000-4000-8000-000000000011','Synthetic retry provenance','b1540000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('b1540000-0000-4000-8000-000000000011','b1540000-0000-4000-8000-000000000001','admin');
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('b1540000-0000-4000-8000-000000000021','b1540000-0000-4000-8000-000000000001','retry-synthetic','overlap-native@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('b1540000-0000-4000-8000-000000000031','b1540000-0000-4000-8000-000000000011','b1540000-0000-4000-8000-000000000021','retry-root','Synthetic root','my_drive','connected',now());

insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,mime_type)
select ('b1540000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
'b1540000-0000-4000-8000-000000000011','b1540000-0000-4000-8000-000000000031',
'dispatch-'||n,'retry-root','Synthetic dispatch '||n,'file','video/mp4'
from generate_series(41,44)n;
insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)
select ('b1540000-0000-4000-8000-'||lpad((n+10)::text,12,'0'))::uuid,
'b1540000-0000-4000-8000-000000000011','b1540000-0000-4000-8000-000000000001',
'trash','running',('b1540000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
'synthetic-dispatch-'||n,case when n=44 then 'request:legacy-dispatch' else 'group-v1:'||repeat('a',64)end
from generate_series(41,44)n;
insert into private.team_material_group_intents(id,team_id,source_material_id,operation_id,action,member_snapshot,state)
select ('b1540000-0000-4000-8000-'||lpad((n+20)::text,12,'0'))::uuid,
'b1540000-0000-4000-8000-000000000011',
('b1540000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
('b1540000-0000-4000-8000-'||lpad((n+10)::text,12,'0'))::uuid,'trash',
jsonb_build_array(jsonb_build_object('material_id',('b1540000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
'drive_file_id','dispatch-'||n,'resource_key',null,'parent_folder_id','retry-root','role','source')),'running'
from generate_series(41,44)n where n<>42;


select public.service_claim_material_group_execution('b1540000-0000-4000-8000-000000000061','b1540000-0000-4000-8000-000000000071');
select public.service_begin_material_group_dispatch('b1540000-0000-4000-8000-000000000061','b1540000-0000-4000-8000-000000000071','b1540000-0000-4000-8000-000000000041');
select public.service_checkpoint_material_group_execution('b1540000-0000-4000-8000-000000000061','b1540000-0000-4000-8000-000000000071','b1540000-0000-4000-8000-000000000041');
update public.team_materials set lifecycle='trashed',trashed_at=now(),placement_state='moving' where id='b1540000-0000-4000-8000-000000000041';
select is((select count(*) from public.service_get_material_operation_context('b1540000-0000-4000-8000-000000000011','b1540000-0000-4000-8000-000000000041','b1540000-0000-4000-8000-000000000001','delete',false)),0::bigint,'ordinary active-only context omits a target already observed as trashed');
select is((select count(*) from public.service_get_material_operation_context('b1540000-0000-4000-8000-000000000011','b1540000-0000-4000-8000-000000000041','b1540000-0000-4000-8000-000000000001','delete',true)),1::bigint,'authorized recovery context includes the acknowledged target');
select is(public.service_reconcile_confirmed_material_group('b1540000-0000-4000-8000-000000000011','b1540000-0000-4000-8000-000000000001','b1540000-0000-4000-8000-000000000051','b1540000-0000-4000-8000-000000000041','trash',null)->>'state','succeeded','observed trash completes the same acknowledged intent');
select ok((select execution_closed is true and dispatch_member is null from private.team_material_group_intents where id='b1540000-0000-4000-8000-000000000061'),'observed result closes without another provider permission');
insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce) values
('b1540000-0000-4000-8000-000000000091','b1540000-0000-4000-8000-000000000011','b1540000-0000-4000-8000-000000000001','restore','running','b1540000-0000-4000-8000-000000000041','synthetic-observed-restore','group-v1:'||repeat('b',64));
create temporary table observed_restore as select * from public.service_create_material_lifecycle_intent('b1540000-0000-4000-8000-000000000011','b1540000-0000-4000-8000-000000000001','b1540000-0000-4000-8000-000000000091','b1540000-0000-4000-8000-000000000041','restore',null);
select public.service_claim_material_group_execution((select intent_id from observed_restore),'b1540000-0000-4000-8000-000000000071');
select public.service_begin_material_group_dispatch((select intent_id from observed_restore),'b1540000-0000-4000-8000-000000000071','b1540000-0000-4000-8000-000000000041');
select public.service_checkpoint_material_group_execution((select intent_id from observed_restore),'b1540000-0000-4000-8000-000000000071','b1540000-0000-4000-8000-000000000041');
update public.team_materials set lifecycle='active',trashed_at=null where id='b1540000-0000-4000-8000-000000000041';
select is(public.service_reconcile_confirmed_material_group('b1540000-0000-4000-8000-000000000011','b1540000-0000-4000-8000-000000000001','b1540000-0000-4000-8000-000000000091','b1540000-0000-4000-8000-000000000041','restore',null)->>'state','succeeded','observed active target completes the original restore');
select ok((select lifecycle='active' and placement_state='ready' from public.team_materials where id='b1540000-0000-4000-8000-000000000041'),'restore retains the active observed result');
select * from finish();
rollback;
