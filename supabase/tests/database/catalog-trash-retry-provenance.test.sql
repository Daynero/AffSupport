begin;
select plan(7);
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('b1480000-0000-4000-8000-000000000001','authenticated','authenticated','retry-native@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('b1480000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
 ('b1480000-0000-4000-8000-000000000011','Synthetic retry provenance','b1480000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('b1480000-0000-4000-8000-000000000011','b1480000-0000-4000-8000-000000000001','admin');
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('b1480000-0000-4000-8000-000000000021','b1480000-0000-4000-8000-000000000001','retry-synthetic','retry-native@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('b1480000-0000-4000-8000-000000000031','b1480000-0000-4000-8000-000000000011','b1480000-0000-4000-8000-000000000021','retry-root','Synthetic root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,mime_type) values
 ('b1480000-0000-4000-8000-000000000041','b1480000-0000-4000-8000-000000000011','b1480000-0000-4000-8000-000000000031','retry-file','retry-root','Synthetic file','file','image/png');
select set_config('request.jwt.claim.sub','b1480000-0000-4000-8000-000000000001',true);
do $$begin perform public.start_team_bulk_trash(
 'b1480000-0000-4000-8000-000000000011','b1480000-0000-4000-8000-000000000051',array['b1480000-0000-4000-8000-000000000041']::uuid[]);end$$;
insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce,error_code,finished_at)
 values('b1480000-0000-4000-8000-000000000061','b1480000-0000-4000-8000-000000000011','b1480000-0000-4000-8000-000000000001','trash','failed',
 'b1480000-0000-4000-8000-000000000041','b1480000-0000-4000-8000-000000000051:b1480000-0000-4000-8000-000000000041','synthetic-retry-request','PROCESS_RESULT_UNCERTAIN',now());
select throws_ok($$select public.prepare_team_bulk_trash_item('b1480000-0000-4000-8000-000000000011','b1480000-0000-4000-8000-000000000051','b1480000-0000-4000-8000-000000000041')$$,
 '55000','PROCESS_RESULT_UNCERTAIN','historical terminal does not permit another provider key');
select is((select attempt from private.team_bulk_trash_items where group_id='b1480000-0000-4000-8000-000000000051'),1,'unknown provenance retains attempt');
-- Model a separate fresh preflight operation, not a production state repair.
delete from public.team_operations where id='b1480000-0000-4000-8000-000000000061';
insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)
 values('b1480000-0000-4000-8000-000000000062','b1480000-0000-4000-8000-000000000011','b1480000-0000-4000-8000-000000000001','trash','pending',
 'b1480000-0000-4000-8000-000000000041','b1480000-0000-4000-8000-000000000051:b1480000-0000-4000-8000-000000000041','synthetic-retry-request');
select is(public.service_fail_drive_mutation_preflight('b1480000-0000-4000-8000-000000000062','b1480000-0000-4000-8000-000000000001','NOT_FOUND',false),true,'fresh pending metadata refusal is proven under lock');
select is((select stage from public.team_operations where id='b1480000-0000-4000-8000-000000000062'),'preflight_refused','provenance is explicit');
do $$begin perform public.prepare_team_bulk_trash_item('b1480000-0000-4000-8000-000000000011','b1480000-0000-4000-8000-000000000051','b1480000-0000-4000-8000-000000000041');end$$;
select is((select attempt from private.team_bulk_trash_items where group_id='b1480000-0000-4000-8000-000000000051'),2,'only a proven refusal advances attempt');
select ok(not has_function_privilege('authenticated','public.service_fail_drive_mutation_preflight(uuid,uuid,text,boolean)','execute'),'browser cannot create refusal provenance');
select ok(not has_function_privilege('anon','public.prepare_team_bulk_trash_item(uuid,uuid,uuid)','execute'),'anonymous callers cannot prepare retries');
select * from finish();
rollback;
