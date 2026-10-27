begin;
select plan(11);
-- Synthetic fixture, loaded only on the owned disposable previous-schema clone.
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
values('81000000-0000-4000-8000-000000000001','authenticated','authenticated','retirement@test.invalid','{}','{}') on conflict (id) do nothing;
insert into public.admin_users(user_id) values('81000000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id)
values('81000000-0000-4000-8000-000000000002','Synthetic retirement','81000000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role)
values('81000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000001','admin');
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope)
values('81000000-0000-4000-8000-000000000003','81000000-0000-4000-8000-000000000001','synthetic','retirement@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)
values('81000000-0000-4000-8000-000000000004','81000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000003','synthetic-root','Synthetic','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,mime_type,drive_version)
values
('81000000-0000-4000-8000-000000000005','81000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000004','synthetic-source','source.mp4','file','video/mp4','v1'),
('81000000-0000-4000-8000-000000000006','81000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000004','synthetic-text','text.txt','file','text/plain','v1');

insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)
values('81000000-0000-4000-8000-000000000009','81000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000001','process','running','81000000-0000-4000-8000-000000000005','synthetic-retired-operation','synthetic-retired-nonce');

select set_config('request.jwt.claim.sub','81000000-0000-4000-8000-000000000001',true);
select throws_ok($$select public.scan_library_requirements('81000000-0000-4000-8000-000000000002','uk',null,true,array['transcription','translation']::text[])$$,'P0001','FEATURE_RETIRED','mixed retired scan is refused atomically');
select is((select count(*) from public.team_library_requirements where team_id='81000000-0000-4000-8000-000000000002'),0::bigint,'refusal did not enqueue an active subset');
select throws_ok($$insert into public.team_library_requirements(team_id,source_material_id,source_version,kind,variant) values('81000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000005','v1','translation','uk')$$,'P0001','FEATURE_RETIRED','stale direct writer cannot create retired requirement');
select throws_ok($$select public.claim_library_job('81000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000011',array['translation']::text[],'uk')$$,'P0001','FEATURE_RETIRED','retired claim is a stable refusal');
select lives_ok($$select public.scan_library_requirements('81000000-0000-4000-8000-000000000002','uk')$$,'default scan accepts active work');
select is((select count(*) from public.team_library_requirements where team_id='81000000-0000-4000-8000-000000000002' and kind='translation'),0::bigint,'default scan creates no retired work');
select throws_ok($$select public.service_set_team_operation_intent('81000000-0000-4000-8000-000000000009','81000000-0000-4000-8000-000000000001','x.txt','text/plain',16,null,null,'translation',5)$$,'P0001','FEATURE_RETIRED','new generic process binding is fenced');
select ok(not has_table_privilege('anon','public.analytics_translation_retirement','select'),'anonymous role cannot read retirement projection');
select ok(not has_table_privilege('authenticated','public.analytics_translation_retirement','select'),'browser role cannot read retirement projection');
select ok(has_table_privilege('service_role','public.analytics_translation_retirement','select'),'service diagnostics may read projection');
select is((select count(*) from information_schema.columns where table_schema='public' and table_name='analytics_translation_retirement' and column_name in ('lease_token','lease_token_hash','drive_file_id','name','text','expected_name')),0::bigint,'projection exposes no content or provider capabilities');
select * from finish();
rollback;
