begin;
select plan(10);

-- 057 (20261226220000): what a finished run in an R2 space leaves, as on Drive. A transcription's
-- text is kept for search while the file holds the bytes it was read from; a re-stitch finding is
-- recorded against the content id of the source it read. Drive keeps its own functions
-- (restitch-prep-from-background.test.sql covers the Drive recorder, unchanged).

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05742000-0000-4000-8000-000000000001','authenticated','authenticated','runs-owner@test.invalid','{}','{}');
insert into public.storage_r2_pilots(user_id,max_space_bytes) values('05742000-0000-4000-8000-000000000001',1000000000);
insert into public.teams(id,name,owner_id,storage_backend,storage_pilot) values
 ('05742000-0000-4000-8000-000000000011','Runs R2','05742000-0000-4000-8000-000000000001','r2',true);
insert into public.team_members(team_id,user_id,base_role) values
 ('05742000-0000-4000-8000-000000000011','05742000-0000-4000-8000-000000000001','admin')
 on conflict do nothing;
insert into public.team_materials(id,team_id,name,kind) values
 ('05742000-0000-4000-8000-000000000101','05742000-0000-4000-8000-000000000011','Runs R2','folder');
update public.teams set storage_root_material_id='05742000-0000-4000-8000-000000000101'
 where id='05742000-0000-4000-8000-000000000011';
insert into public.space_objects(id,team_id,content_id,byte_size,content_type,r2_key) values
 ('05742000-0000-4000-8000-000000000201','05742000-0000-4000-8000-000000000011',repeat('1',64),1000,'video/mp4',
  't/05742000-0000-4000-8000-000000000011/o/'||repeat('1',64)),
 ('05742000-0000-4000-8000-000000000202','05742000-0000-4000-8000-000000000011',repeat('2',64),10,'text/plain',
  't/05742000-0000-4000-8000-000000000011/o/'||repeat('2',64));
insert into public.team_materials(id,team_id,parent_folder_id,name,kind,category,mime_type,file_extension,space_object_id) values
 ('05742000-0000-4000-8000-000000000103','05742000-0000-4000-8000-000000000011',
  '05742000-0000-4000-8000-000000000101','Clip.mp4','file','video','video/mp4','mp4','05742000-0000-4000-8000-000000000201'),
 ('05742000-0000-4000-8000-000000000104','05742000-0000-4000-8000-000000000011',
  '05742000-0000-4000-8000-000000000101','Clip.txt','file','transcript','text/plain','txt','05742000-0000-4000-8000-000000000202');

-- 1. Transcript text --------------------------------------------------------------------
select ok(not public.service_commit_space_transcript('05742000-0000-4000-8000-000000000104',repeat('9',64),'txt','full','hello',5),
 'a commit for other bytes than the file holds changes nothing');
select ok(not public.service_commit_space_transcript('05742000-0000-4000-8000-000000000103',repeat('1',64),'mp4','full','hello',5),
 'nor does one for a file that is not a transcript');
select ok(public.service_commit_space_transcript('05742000-0000-4000-8000-000000000104',repeat('2',64),'txt','full','hello',5),
 'the text of a transcription result is kept');
select is((select transcript_text||'|'||transcript_ingest_state||'|'||coalesce(transcript_source_version,'-')
  from public.team_materials where id='05742000-0000-4000-8000-000000000104'),
 'hello|full|-','with no Drive version to name its source by');
select is((select count(*)::integer from public.team_catalog_events where material_id='05742000-0000-4000-8000-000000000104'
  and event_kind='upserted'),1,'and the search index hears of it');
select throws_ok($$select public.service_commit_space_transcript('05742000-0000-4000-8000-000000000104','x','txt','full','hello',5)$$,
 '22023','INVALID_INPUT','a malformed content id is refused');
select ok(not has_function_privilege('authenticated','public.service_commit_space_transcript(uuid,text,text,text,text,integer,text)','execute'),
 'only the service may commit a transcript');

-- 2. Re-stitch finding ------------------------------------------------------------------
insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce,finished_at) values
 ('05742000-0000-4000-8000-000000000301','05742000-0000-4000-8000-000000000011','05742000-0000-4000-8000-000000000001',
  'process','succeeded','05742000-0000-4000-8000-000000000103','synthetic-r2-prep-1','synthetic-r2-prep-nonce-1',now());
select ok(not public.service_record_material_restitch_prep('05742000-0000-4000-8000-000000000301',
 jsonb_build_object('detectorVersion',2,'detectedStartSeconds',0.5,'detectedEndSeconds',8,'profile','{}'::jsonb,'driveVersion',repeat('9',64))),
 'a finding about other bytes than the source holds is not kept');
select ok(public.service_record_material_restitch_prep('05742000-0000-4000-8000-000000000301',
 jsonb_build_object('detectorVersion',2,'detectedStartSeconds',0.5,'detectedEndSeconds',8,'profile','{}'::jsonb,'driveVersion',repeat('1',64))),
 'a finding about the R2 source, named by its content id, is kept');
select is((select drive_version||'|'||detector_version from public.team_material_restitch_prep
  where material_id='05742000-0000-4000-8000-000000000103'),repeat('1',64)||'|2',
 'against the content id of the bytes it describes');

select * from finish();
rollback;
