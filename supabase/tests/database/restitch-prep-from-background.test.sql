begin;
select plan(12);
-- 071: a background re-stitch (catalog round, launch) stores what the agent read about its
-- source, through drive-ops, only for the operation's own source at its current Drive version.
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('c0710000-0000-4000-8000-000000000001','authenticated','authenticated','prep-background@test.invalid','{}','{}');
-- An admin account stands in for a paid space: private.can asks for workspace access first.
insert into public.admin_users(user_id) values('c0710000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
 ('c0710000-0000-4000-8000-000000000011','Synthetic background prep','c0710000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('c0710000-0000-4000-8000-000000000011','c0710000-0000-4000-8000-000000000001','admin');
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('c0710000-0000-4000-8000-000000000021','c0710000-0000-4000-8000-000000000001','prep-synthetic','prep-background@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('c0710000-0000-4000-8000-000000000031','c0710000-0000-4000-8000-000000000011','c0710000-0000-4000-8000-000000000021','prep-root','Synthetic root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,mime_type,drive_version)
values
 ('c0710000-0000-4000-8000-000000000041','c0710000-0000-4000-8000-000000000011','c0710000-0000-4000-8000-000000000031','prep-video-1','prep-root','Synthetic video 1','file','video/mp4','v7');
insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce,finished_at)
values
 ('c0710000-0000-4000-8000-000000000051','c0710000-0000-4000-8000-000000000011','c0710000-0000-4000-8000-000000000001','process','succeeded','c0710000-0000-4000-8000-000000000041','synthetic-prep-1','synthetic-prep-nonce-1',now()),
 ('c0710000-0000-4000-8000-000000000052','c0710000-0000-4000-8000-000000000011','c0710000-0000-4000-8000-000000000001','process','running','c0710000-0000-4000-8000-000000000041','synthetic-prep-2','synthetic-prep-nonce-2',null),
 ('c0710000-0000-4000-8000-000000000053','c0710000-0000-4000-8000-000000000011','c0710000-0000-4000-8000-000000000001','download','succeeded','c0710000-0000-4000-8000-000000000041','synthetic-prep-3','synthetic-prep-nonce-3',now());

create temporary table prep_input as select jsonb_build_object(
  'driveVersion','v7','detectorVersion',4,'detectedStartSeconds',0.5,'detectedEndSeconds',12,
  'profile',jsonb_build_object('path','/tmp/source.bin','width',1080,'height',1920)) as value;

select ok(not has_function_privilege('authenticated','public.service_record_material_restitch_prep(uuid,jsonb)','execute'),'a browser cannot write a preparation record through the background seam');
select ok(has_function_privilege('service_role','public.service_record_material_restitch_prep(uuid,jsonb)','execute'),'drive-ops may');

select ok(not public.service_record_material_restitch_prep('c0710000-0000-4000-8000-000000000052',(select value from prep_input)),'an operation still running stores nothing');
select ok(not public.service_record_material_restitch_prep('c0710000-0000-4000-8000-000000000053',(select value from prep_input)),'only a process operation stores a finding');
select ok(not public.service_record_material_restitch_prep('c0710000-0000-4000-8000-000000000051',(select value from prep_input)||'{"driveVersion":"v6"}'),'a finding about other bytes is ignored');
select ok(not public.service_record_material_restitch_prep('c0710000-0000-4000-8000-000000000051',(select value from prep_input)||'{"detectorVersion":0}'),'a finding without a detector is ignored');
select ok(not public.service_record_material_restitch_prep('c0710000-0000-4000-8000-000000000051',(select value from prep_input)||'{"profile":null}'),'a finding without a profile is ignored');

select ok(public.service_record_material_restitch_prep('c0710000-0000-4000-8000-000000000051',(select value from prep_input)),'a succeeded re-stitch stores what it read');
select is(
  (select row(drive_version,detector_version,detected_start_seconds,detected_end_seconds,(source_profile->>'width')::int,prepared_by)::text
   from public.team_material_restitch_prep where material_id='c0710000-0000-4000-8000-000000000041'),
  row('v7',4,0.5::numeric,12::numeric,1080,'c0710000-0000-4000-8000-000000000001'::uuid)::text,
  'the record is the material''s, keyed to the version read, by the operation''s actor');
select ok(not public.service_record_material_restitch_prep('c0710000-0000-4000-8000-000000000051',(select value from prep_input)||'{"detectedEndSeconds":99}'),'the same reading twice keeps the first');
select ok(public.service_record_material_restitch_prep('c0710000-0000-4000-8000-000000000051',(select value from prep_input)||'{"detectorVersion":5,"detectedEndSeconds":11}'),'a newer detector replaces it');

select ok(not public.service_record_material_restitch_prep('c0710000-0000-4000-8000-000000000051',(select value from prep_input)||'{"detectorVersion":6,"detectedStartSeconds":-1}'),'negative edges are ignored');
select * from finish();
rollback;
