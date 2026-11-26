begin;
select plan(12);

select ok(not has_function_privilege('authenticated','public.service_release_own_process_reservation(uuid,uuid,uuid,uuid,text)','execute'),'clients cannot release reservations');
select ok(not has_function_privilege('anon','public.service_release_own_process_reservation(uuid,uuid,uuid,uuid,text)','execute'),'anonymous callers cannot release reservations');

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('b1460000-0000-4000-8000-000000000001','authenticated','authenticated','retry-owner@test.invalid','{}','{}'),
 ('b1460000-0000-4000-8000-000000000002','authenticated','authenticated','retry-other@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('b1460000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
 ('b1460000-0000-4000-8000-000000000011','Synthetic retry takeover','b1460000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('b1460000-0000-4000-8000-000000000011','b1460000-0000-4000-8000-000000000001','admin'),
 ('b1460000-0000-4000-8000-000000000011','b1460000-0000-4000-8000-000000000002','admin');
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('b1460000-0000-4000-8000-000000000021','b1460000-0000-4000-8000-000000000001','synthetic-retry','retry-owner@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('b1460000-0000-4000-8000-000000000031','b1460000-0000-4000-8000-000000000011','b1460000-0000-4000-8000-000000000021','retry-root','Synthetic root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,mime_type,category) values
 ('b1460000-0000-4000-8000-000000000041','b1460000-0000-4000-8000-000000000011','b1460000-0000-4000-8000-000000000031','retry-video-a','MA 19.mp4','file','video/mp4','video'),
 ('b1460000-0000-4000-8000-000000000042','b1460000-0000-4000-8000-000000000011','b1460000-0000-4000-8000-000000000031','retry-video-b','MA 20.mp4','file','video/mp4','video');

-- 51: the stalled manual run (production shape). 52: a library job. 53: another person's run.
-- 54: a manual run whose upload already started. 55: the same person, another source.
insert into public.team_operations(id,team_id,actor_id,kind,state,stage,source_material_id,idempotency_key,request_nonce,reserved_name_key,reservation_expires_at)
 values
 ('b1460000-0000-4000-8000-000000000051','b1460000-0000-4000-8000-000000000011','b1460000-0000-4000-8000-000000000001','process','running','awaiting_agent',
  'b1460000-0000-4000-8000-000000000041','061d8ccc-5e77-4f80-85f1-ce514d93fce3','request:a','ma 19.txt',now()+interval '30 minutes'),
 ('b1460000-0000-4000-8000-000000000052','b1460000-0000-4000-8000-000000000011','b1460000-0000-4000-8000-000000000001','process','running','awaiting_agent',
  'b1460000-0000-4000-8000-000000000041','library.process.b','request:b','ma 19 library.txt',now()+interval '30 minutes'),
 ('b1460000-0000-4000-8000-000000000053','b1460000-0000-4000-8000-000000000011','b1460000-0000-4000-8000-000000000002','process','running','awaiting_agent',
  'b1460000-0000-4000-8000-000000000041','1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d','request:c','ma 19 other.txt',now()+interval '30 minutes'),
 ('b1460000-0000-4000-8000-000000000054','b1460000-0000-4000-8000-000000000011','b1460000-0000-4000-8000-000000000001','process','running','uploading',
  'b1460000-0000-4000-8000-000000000042','2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e','request:d','ma 20.txt',now()+interval '30 minutes'),
 ('b1460000-0000-4000-8000-000000000055','b1460000-0000-4000-8000-000000000011','b1460000-0000-4000-8000-000000000001','process','running','awaiting_agent',
  'b1460000-0000-4000-8000-000000000042','3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f','request:e','ma 20 copy.txt',now()+interval '30 minutes');
insert into private.team_operation_intents(operation_id,team_id,expected_name,mime_type,expected_size,tool_id,tool_contract_version)
 values('b1460000-0000-4000-8000-000000000054','b1460000-0000-4000-8000-000000000011','MA 20.txt','text/plain',16,'transcription',1);
insert into private.team_transfer_grants(token_hash,operation_id,team_id,actor_id,purpose,tool_id,max_range_bytes,expires_at,max_uses)
 select decode(md5(id::text)||md5(id::text||':grant'),'hex'),id,team_id,actor_id,'finalize','transcription',2097152,now()+interval '1 hour',4
 from public.team_operations where team_id='b1460000-0000-4000-8000-000000000011';
select is(public.service_prepare_process_upload('b1460000-0000-4000-8000-000000000054','b1460000-0000-4000-8000-000000000001',
 'b1460000-0000-4000-8000-000000000031','retry-upload-started',repeat('a',32))->>'fileId','retry-upload-started','fixture upload is bound');
select is(public.service_start_process_upload('b1460000-0000-4000-8000-000000000054','b1460000-0000-4000-8000-000000000001'),true,'fixture upload has started');

select is(public.service_release_own_process_reservation('b1460000-0000-4000-8000-000000000011','b1460000-0000-4000-8000-000000000002',
 'b1460000-0000-4000-8000-000000000041',null,'ma 19.txt'),null,'another person cannot take a run over');
select is(public.service_release_own_process_reservation('b1460000-0000-4000-8000-000000000011','b1460000-0000-4000-8000-000000000001',
 'b1460000-0000-4000-8000-000000000042',null,'ma 19.txt'),null,'a run of another file keeps its name');
select is(public.service_release_own_process_reservation('b1460000-0000-4000-8000-000000000011','b1460000-0000-4000-8000-000000000001',
 'b1460000-0000-4000-8000-000000000041',null,'ma 19 library.txt'),null,'a library job is never taken over');
select is(public.service_release_own_process_reservation('b1460000-0000-4000-8000-000000000011','b1460000-0000-4000-8000-000000000001',
 'b1460000-0000-4000-8000-000000000042',null,'ma 20.txt'),null,'a run already writing to Drive keeps its name');

select is(public.service_release_own_process_reservation('b1460000-0000-4000-8000-000000000011','b1460000-0000-4000-8000-000000000001',
 'b1460000-0000-4000-8000-000000000041',null,'ma 19.txt'),'b1460000-0000-4000-8000-000000000051'::uuid,'the person’s own stalled run is taken over');
select is((select state||':'||(reservation_released_at is not null)::text from public.team_operations where id='b1460000-0000-4000-8000-000000000051'),
 'canceled:true','it is cancelled and its name is free');
select ok(not exists(select 1 from private.team_transfer_grants where operation_id='b1460000-0000-4000-8000-000000000051' and revoked_at is null),
 'a late agent cannot finish it');
select is((select count(*)::integer from public.team_operations where team_id='b1460000-0000-4000-8000-000000000011' and state='running'),4,
 'nothing else was touched');

select * from finish();
rollback;
