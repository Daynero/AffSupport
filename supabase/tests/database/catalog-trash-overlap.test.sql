begin;
select plan(9);
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('b1490000-0000-4000-8000-000000000001','authenticated','authenticated','overlap-native@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('b1490000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
 ('b1490000-0000-4000-8000-000000000011','Synthetic retry provenance','b1490000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('b1490000-0000-4000-8000-000000000011','b1490000-0000-4000-8000-000000000001','admin');
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('b1490000-0000-4000-8000-000000000021','b1490000-0000-4000-8000-000000000001','retry-synthetic','overlap-native@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('b1490000-0000-4000-8000-000000000031','b1490000-0000-4000-8000-000000000011','b1490000-0000-4000-8000-000000000021','retry-root','Synthetic root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,mime_type) values
 ('b1490000-0000-4000-8000-000000000041','b1490000-0000-4000-8000-000000000011','b1490000-0000-4000-8000-000000000031','retry-file','retry-root','Synthetic file','file','image/png');
select set_config('request.jwt.claim.sub','b1490000-0000-4000-8000-000000000001',true);

insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,mime_type) values
 ('b1490000-0000-4000-8000-000000000042','b1490000-0000-4000-8000-000000000011','b1490000-0000-4000-8000-000000000031','overlap-folder','retry-root','Synthetic folder','folder','application/vnd.google-apps.folder'),
 ('b1490000-0000-4000-8000-000000000043','b1490000-0000-4000-8000-000000000011','b1490000-0000-4000-8000-000000000031','other-folder','retry-root','Other folder','folder','application/vnd.google-apps.folder'),
 ('b1490000-0000-4000-8000-000000000044','b1490000-0000-4000-8000-000000000011','b1490000-0000-4000-8000-000000000031','other-child','other-folder','Other child','file','image/png'),
 ('b1490000-0000-4000-8000-000000000045','b1490000-0000-4000-8000-000000000011','b1490000-0000-4000-8000-000000000031','independent-file','retry-root','Independent file','file','image/png'),
 ('b1490000-0000-4000-8000-000000000046','b1490000-0000-4000-8000-000000000011','b1490000-0000-4000-8000-000000000031','completed-file','retry-root','Completed file','file','image/png');
update public.team_materials set parent_folder_id='overlap-folder' where id='b1490000-0000-4000-8000-000000000041';
do $$begin perform public.start_team_bulk_trash('b1490000-0000-4000-8000-000000000011','b1490000-0000-4000-8000-000000000051',array['b1490000-0000-4000-8000-000000000041']::uuid[]);end$$;
select throws_ok($$select public.start_team_bulk_trash('b1490000-0000-4000-8000-000000000011','b1490000-0000-4000-8000-000000000052',array['b1490000-0000-4000-8000-000000000041']::uuid[])$$,'55000','PROCESS_RESULT_UNCERTAIN','a replacement group cannot overlap an accepted queued item');
select throws_ok($$select public.start_team_bulk_trash_as_actor('b1490000-0000-4000-8000-000000000011','b1490000-0000-4000-8000-000000000053',array['b1490000-0000-4000-8000-000000000042']::uuid[],'b1490000-0000-4000-8000-000000000001')$$,'55000','PROCESS_RESULT_UNCERTAIN','a selected parent cannot bypass its unresolved child');
select is(public.start_team_bulk_trash('b1490000-0000-4000-8000-000000000011','b1490000-0000-4000-8000-000000000051',array['b1490000-0000-4000-8000-000000000041']::uuid[])->>'id','b1490000-0000-4000-8000-000000000051','the original immutable request remains replayable');
do $$begin perform public.start_team_bulk_trash('b1490000-0000-4000-8000-000000000011','b1490000-0000-4000-8000-000000000054',array['b1490000-0000-4000-8000-000000000043']::uuid[]);end$$;
select throws_ok($$select public.start_team_bulk_trash('b1490000-0000-4000-8000-000000000011','b1490000-0000-4000-8000-000000000055',array['b1490000-0000-4000-8000-000000000044']::uuid[])$$,'55000','PROCESS_RESULT_UNCERTAIN','a child cannot bypass its unresolved selected parent');
select lives_ok($$select public.start_team_bulk_trash('b1490000-0000-4000-8000-000000000011','b1490000-0000-4000-8000-000000000056',array['b1490000-0000-4000-8000-000000000045']::uuid[])$$,'unrelated items can still be accepted');
insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce,error_code,finished_at) values
 ('b1490000-0000-4000-8000-000000000061','b1490000-0000-4000-8000-000000000011','b1490000-0000-4000-8000-000000000001','trash','failed','b1490000-0000-4000-8000-000000000041','b1490000-0000-4000-8000-000000000051:b1490000-0000-4000-8000-000000000041','synthetic-overlap-request','PROCESS_RESULT_UNCERTAIN',now());
select throws_ok($$select public.start_team_bulk_trash('b1490000-0000-4000-8000-000000000011','b1490000-0000-4000-8000-000000000057',array['b1490000-0000-4000-8000-000000000041']::uuid[])$$,'55000','PROCESS_RESULT_UNCERTAIN','a failed terminal without quiescence cannot bypass the original request');
-- Frozen lifecycle membership also protects a file outside the current parent tree.
insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,mime_type) values
 ('b1490000-0000-4000-8000-000000000047','b1490000-0000-4000-8000-000000000011','b1490000-0000-4000-8000-000000000031','frozen-child','retry-root','Frozen child','file','image/png');
insert into private.team_material_group_intents(team_id,source_material_id,operation_id,action,member_snapshot,state) values
 ('b1490000-0000-4000-8000-000000000011','b1490000-0000-4000-8000-000000000041','b1490000-0000-4000-8000-000000000061','trash',
 '[{"material_id":"b1490000-0000-4000-8000-000000000041","drive_file_id":"retry-file","role":"source"},{"material_id":"b1490000-0000-4000-8000-000000000047","drive_file_id":"frozen-child","role":"transcript"}]'::jsonb,'reconciling');
select throws_ok($$select public.start_team_bulk_trash('b1490000-0000-4000-8000-000000000011','b1490000-0000-4000-8000-000000000060',array['b1490000-0000-4000-8000-000000000047']::uuid[])$$,'55000','PROCESS_RESULT_UNCERTAIN','frozen unresolved lifecycle membership survives parent changes');
do $$begin perform public.start_team_bulk_trash('b1490000-0000-4000-8000-000000000011','b1490000-0000-4000-8000-000000000058',array['b1490000-0000-4000-8000-000000000046']::uuid[]);end$$;
-- A synthetic already-confirmed trash receipt with an active restored material.
insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce,finished_at) values
 ('b1490000-0000-4000-8000-000000000062','b1490000-0000-4000-8000-000000000011','b1490000-0000-4000-8000-000000000001','trash','succeeded','b1490000-0000-4000-8000-000000000046','b1490000-0000-4000-8000-000000000058:b1490000-0000-4000-8000-000000000046','synthetic-completed-request',now());
select lives_ok($$select public.start_team_bulk_trash('b1490000-0000-4000-8000-000000000011','b1490000-0000-4000-8000-000000000059',array['b1490000-0000-4000-8000-000000000046']::uuid[])$$,'a confirmed old receipt does not permanently block a restored active file');
select is((select count(*)::integer from private.team_bulk_trash_groups where id in ('b1490000-0000-4000-8000-000000000052','b1490000-0000-4000-8000-000000000053','b1490000-0000-4000-8000-000000000055','b1490000-0000-4000-8000-000000000057','b1490000-0000-4000-8000-000000000060')),0,'refused replacements create no extra group');
select * from finish();
rollback;
