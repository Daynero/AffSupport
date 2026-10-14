begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(10);

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
('bd370000-0000-4000-8000-000000000001','authenticated','authenticated','orphan-owner@example.test','{}','{}'),
('bd370000-0000-4000-8000-000000000002','authenticated','authenticated','orphan-other@example.test','{}','{}');
insert into public.admin_users(user_id) values ('bd370000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
('bd370000-0000-4000-8000-000000000010','Orphan fixture','bd370000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
('bd370000-0000-4000-8000-000000000010','bd370000-0000-4000-8000-000000000001','admin');
insert into private.google_drive_credentials
  (id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
('bd370000-0000-4000-8000-000000000011','bd370000-0000-4000-8000-000000000001',
 'orphan-test','orphan-owner@example.test',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections
  (id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,initial_sync_state) values
('bd370000-0000-4000-8000-000000000012','bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000011','orphan-root','Orphan root','my_drive','connected','ready');
insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind) values
('bd370000-0000-4000-8000-000000000021','bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000012','orphan-a','A','file'),
('bd370000-0000-4000-8000-000000000022','bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000012','orphan-b','B','file');
insert into public.team_tasks(id,team_id,created_by,title) values
('bd370000-0000-4000-8000-000000000030','bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000001','Task');
insert into public.team_task_attachments(team_id,task_id,material_id,position,attached_by) values
('bd370000-0000-4000-8000-000000000010','bd370000-0000-4000-8000-000000000030',
 'bd370000-0000-4000-8000-000000000021',0,'bd370000-0000-4000-8000-000000000001'),
('bd370000-0000-4000-8000-000000000010','bd370000-0000-4000-8000-000000000030',
 'bd370000-0000-4000-8000-000000000022',1,'bd370000-0000-4000-8000-000000000001');
insert into public.team_operations(id,team_id,actor_id,kind,state,result_material_id,
 idempotency_key,request_nonce,finished_at) values
('bd370000-0000-4000-8000-000000000040','bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000001','upload','succeeded',
 'bd370000-0000-4000-8000-000000000021','orphan-upload-key','orphan-upload-nonce',now());

select set_config('request.jwt.claim.sub','bd370000-0000-4000-8000-000000000002',true);
select throws_ok($$select public.mark_team_task_upload(
 'bd370000-0000-4000-8000-000000000010','bd370000-0000-4000-8000-000000000030',
 'bd370000-0000-4000-8000-000000000021','bd370000-0000-4000-8000-000000000040')$$,
 '42501','PERMISSION_DENIED','outsider cannot mark an upload');
select set_config('request.jwt.claim.sub','bd370000-0000-4000-8000-000000000001',true);
select throws_ok($$select public.mark_team_task_upload(
 'bd370000-0000-4000-8000-000000000010','bd370000-0000-4000-8000-000000000030',
 'bd370000-0000-4000-8000-000000000022','bd370000-0000-4000-8000-000000000040')$$,
 '22023','UNVERIFIED_UPLOAD','another material cannot inherit upload provenance');
select ok(public.mark_team_task_upload('bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000030','bd370000-0000-4000-8000-000000000021',
 'bd370000-0000-4000-8000-000000000040'),'exact successful upload marks the attachment');
select ok(public.mark_team_task_upload('bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000030','bd370000-0000-4000-8000-000000000021',
 'bd370000-0000-4000-8000-000000000040'),'mark replay is idempotent');
create temporary table detach_receipt as select public.detach_team_task_material_v2(
 'bd370000-0000-4000-8000-000000000010','bd370000-0000-4000-8000-000000000030',
 'bd370000-0000-4000-8000-000000000021') as result;
select is((select result->>'state' from detach_receipt),'waiting','verified upload gets a waiting intent');
select ok((select (result->>'undoDeadline')::timestamptz - (result->>'detachedAt')::timestamptz
 from detach_receipt) = interval '30 seconds','server gives exactly thirty seconds');
select is(public.detach_team_task_material_v2('bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000030','bd370000-0000-4000-8000-000000000021')->>'state',
 'already_detached','detach replay makes no second intent');
select is(public.detach_team_task_material_v2('bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000030','bd370000-0000-4000-8000-000000000022')->>'state',
 'cleanup_unverified','external material is retained');
insert into public.team_task_attachments(team_id,task_id,material_id,position,attached_by) values
('bd370000-0000-4000-8000-000000000010','bd370000-0000-4000-8000-000000000030',
 'bd370000-0000-4000-8000-000000000021',0,'bd370000-0000-4000-8000-000000000001');
select is((select state from private.team_task_orphan_intents where material_id=
 'bd370000-0000-4000-8000-000000000021'),'cancelled','reattachment cancels cleanup intent');
select ok(not has_table_privilege('authenticated','private.team_task_upload_markers','SELECT')
 and not has_table_privilege('authenticated','private.team_task_orphan_intents','SELECT'),
 'provenance and intents are private');
select * from finish();
rollback;
