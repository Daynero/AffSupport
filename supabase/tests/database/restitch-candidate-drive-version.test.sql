begin;
select plan(13);
-- Incident 2026-11-26: Google Drive raises the version of a freshly uploaded picture by itself
-- (1 -> 2) and leaves its bytes alone. A set admitted before the bump must still hand its pictures
-- to a variant admitted after it; changed content and a changed VIDEO are refused as before.
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('c1710000-0000-4000-8000-000000000001','authenticated','authenticated','version-bump-owner@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('c1710000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values('c1710000-0000-4000-8000-000000000011','Synthetic version bump','c1710000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('c1710000-0000-4000-8000-000000000011','c1710000-0000-4000-8000-000000000001','admin') on conflict do nothing;
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope)
 values('c1710000-0000-4000-8000-000000000021','c1710000-0000-4000-8000-000000000001','version-bump-synthetic','version-bump-owner@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)
 values('c1710000-0000-4000-8000-000000000031','c1710000-0000-4000-8000-000000000011','c1710000-0000-4000-8000-000000000021','bump-root','Synthetic root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version) values
 ('c1710000-0000-4000-8000-000000000041','c1710000-0000-4000-8000-000000000011','c1710000-0000-4000-8000-000000000031','bump-video','bump-root','Synthetic.mp4','file','video','video/mp4',4,repeat('c',32),'1'),
 ('c1710000-0000-4000-8000-000000000042','c1710000-0000-4000-8000-000000000011','c1710000-0000-4000-8000-000000000031','bump-start','bump-root','Start.png','file','image','image/png',4,repeat('a',32),'1'),
 ('c1710000-0000-4000-8000-000000000043','c1710000-0000-4000-8000-000000000011','c1710000-0000-4000-8000-000000000031','bump-end','bump-root','End.png','file','image','image/png',4,repeat('b',32),'1');
insert into public.team_restitch_sources(team_id,slot,material_id,kind,sort_order,added_by) values
 ('c1710000-0000-4000-8000-000000000011','start','c1710000-0000-4000-8000-000000000042','file',1,'c1710000-0000-4000-8000-000000000001'),
 ('c1710000-0000-4000-8000-000000000011','end','c1710000-0000-4000-8000-000000000043','file',1,'c1710000-0000-4000-8000-000000000001');
create temp table bump_catalog as select public.service_begin_catalog_intent(
 'c1710000-0000-4000-8000-000000000011','c1710000-0000-4000-8000-000000000041','c1710000-0000-4000-8000-000000000001',
 'version-bump-catalog','{"catalogImageContractVersion":3}','c1710000-0000-4000-8000-000000000090') receipt;
-- The set is admitted while every picture is still at version 1.
select public.service_accept_catalog_video_set('c1710000-0000-4000-8000-000000000011','c1710000-0000-4000-8000-000000000001','c1710000-0000-4000-8000-000000000090',
 jsonb_build_object('setId','c1710000-0000-4000-8000-000000000080','catalogIntentId',(select receipt->>'id' from bump_catalog),'sourceMaterialId','c1710000-0000-4000-8000-000000000041','sourceVersion','1',
 'settings','{"configured":true,"operation":"restitch","sourceMode":"drive","fitMode":"cover","startEnabled":true,"endEnabled":true,"startDurationMode":"one-frame","customStartDurationMs":1,"finalDurationMode":"random-40-50","customFinalDurationSeconds":2700}'::jsonb,
 'settingsDigest',repeat('b',64),'requestedCount',1,'productCount',1,'recipeRevision',1,'seed',repeat('c',64)),
 '[{"index":0,"requestId":"c1710000-0000-4000-8000-000000000081"}]',
 '[{"recipeRowId":"c1710000-0000-4000-8000-000000000082","videoVariantIndex":0}]');
insert into private.team_recovery_delegations(id,team_id,actor_id,installation_id,refresh_hash) values(
 'c1710000-0000-4000-8000-000000000092','c1710000-0000-4000-8000-000000000011','c1710000-0000-4000-8000-000000000001','c1710000-0000-4000-8000-000000000090',decode(repeat('bb',32),'hex'));
insert into private.team_recovery_credentials(hash,delegation_id,version,audience,expires_at) values(decode(repeat('ac',32),'hex'),'c1710000-0000-4000-8000-000000000092',1,'claim',clock_timestamp()+interval '1 hour');
insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce) values(
 'c1710000-0000-4000-8000-000000000083','c1710000-0000-4000-8000-000000000011','c1710000-0000-4000-8000-000000000001','process','running','c1710000-0000-4000-8000-000000000041',
 'catalog-variant:c1710000-0000-4000-8000-000000000081','catalog-variant:c1710000-0000-4000-8000-000000000081');
insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version,expected_source_drive_file_id,expected_source_checksum) values(
 'c1710000-0000-4000-8000-000000000083','c1710000-0000-4000-8000-000000000011','restitch','1','bump-video',repeat('c',32));
update private.catalog_video_variants set state='working',operation_id='c1710000-0000-4000-8000-000000000083' where video_set_id='c1710000-0000-4000-8000-000000000080';
select is((select array_agg(slot||':'||drive_version order by slot) from private.catalog_video_restitch_candidates where video_set_id='c1710000-0000-4000-8000-000000000080'),
 array['end:1','start:1'],'both pictures are frozen at version 1 when the set is admitted');

create function pg_temp.accept() returns jsonb language sql as $$
 select public.service_accept_catalog_video_restitch_alias(
  'c1710000-0000-4000-8000-000000000080',decode(repeat('ac',32),'hex'),'c1710000-0000-4000-8000-000000000091',1,0,
  'c1710000-0000-4000-8000-000000000081','c1710000-0000-4000-8000-000000000083');
$$;

-- 1. The VIDEO keeps its strict version policy: a version change alone refuses the alias.
update public.team_materials set drive_version='2' where id='c1710000-0000-4000-8000-000000000041';
select throws_ok($$select pg_temp.accept()$$,'55000','SOURCE_CHANGED','a video whose version moved is refused even with the same checksum');
update public.team_materials set drive_version='1' where id='c1710000-0000-4000-8000-000000000041';

-- 2. A picture whose content changed is refused, whatever its version says.
update public.team_materials set checksum=repeat('d',32),drive_version='2' where id='c1710000-0000-4000-8000-000000000042';
select throws_ok($$select pg_temp.accept()$$,'55000','SOURCE_CHANGED','a picture with another checksum is refused');
update public.team_materials set checksum=repeat('a',32),size_bytes=5 where id='c1710000-0000-4000-8000-000000000042';
select throws_ok($$select pg_temp.accept()$$,'55000','SOURCE_CHANGED','a picture with another size is refused');
update public.team_materials set size_bytes=4,mime_type='image/jpeg' where id='c1710000-0000-4000-8000-000000000042';
select throws_ok($$select pg_temp.accept()$$,'55000','SOURCE_CHANGED','a picture with another MIME type is refused');
-- 3. Content that cannot be proved is not waved through: no checksum means the old strictness.
update public.team_materials set mime_type='image/png',checksum=null where id='c1710000-0000-4000-8000-000000000042';
select throws_ok($$select pg_temp.accept()$$,'55000','SOURCE_CHANGED','a picture without a checksum is refused');
update public.team_materials set checksum=repeat('a',32),drive_version=null where id='c1710000-0000-4000-8000-000000000042';
select throws_ok($$select pg_temp.accept()$$,'55000','SOURCE_CHANGED','a picture without a version is refused');
-- 4. A picture that left the space is refused.
update public.team_materials set drive_version='2',lifecycle='trashed',trashed_at=clock_timestamp() where id='c1710000-0000-4000-8000-000000000042';
select throws_ok($$select pg_temp.accept()$$,'55000','SOURCE_CHANGED','a trashed picture is refused');
update public.team_materials set lifecycle='active',trashed_at=null where id='c1710000-0000-4000-8000-000000000042';
select is((select count(*) from private.restitch_selection_candidates where root_operation_id='c1710000-0000-4000-8000-000000000083'),0::bigint,'a refused alias leaves no candidate behind');

-- 5. The incident: Drive raised both fresh pictures to version 2, the bytes are the same.
update public.team_materials set drive_version='2' where id in('c1710000-0000-4000-8000-000000000042','c1710000-0000-4000-8000-000000000043');
select lives_ok($$select pg_temp.accept()$$,'the same content under a newer Drive version is still the same candidate');
select is((select array_agg(slot||':'||drive_version||':'||checksum order by slot) from private.restitch_selection_candidates where root_operation_id='c1710000-0000-4000-8000-000000000083'),
 array['end:2:'||repeat('b',32),'start:2:'||repeat('a',32)],'the variant holds both pictures, at the version that carried the content');
select is((select array_agg(slot||':'||drive_version order by slot) from private.catalog_video_restitch_candidates where video_set_id='c1710000-0000-4000-8000-000000000080'),
 array['end:1','start:1'],'the set keeps the snapshot it was admitted with');
select is((select state from public.team_operations where id='c1710000-0000-4000-8000-000000000083'),'running','the process carries on');
select * from finish();
rollback;
