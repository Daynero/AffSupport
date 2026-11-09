begin;
select plan(9);
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('c1700000-0000-4000-8000-000000000001','authenticated','authenticated','selection-owner@test.invalid','{}','{}'),
 ('c1700000-0000-4000-8000-000000000002','authenticated','authenticated','selection-actor@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('c1700000-0000-4000-8000-000000000001'),('c1700000-0000-4000-8000-000000000002');
insert into public.teams(id,name,owner_id) values('c1700000-0000-4000-8000-000000000011','Synthetic bounded selection','c1700000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('c1700000-0000-4000-8000-000000000011','c1700000-0000-4000-8000-000000000001','admin'),
 ('c1700000-0000-4000-8000-000000000011','c1700000-0000-4000-8000-000000000002','admin');
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope)
 values('c1700000-0000-4000-8000-000000000021','c1700000-0000-4000-8000-000000000001','selection-synthetic','selection-owner@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)
 values('c1700000-0000-4000-8000-000000000031','c1700000-0000-4000-8000-000000000011','c1700000-0000-4000-8000-000000000021','selection-root','Synthetic root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version) values
 ('c1700000-0000-4000-8000-000000000041','c1700000-0000-4000-8000-000000000011','c1700000-0000-4000-8000-000000000031','selection-video','selection-root','Synthetic.mp4','file','video','video/mp4',4,repeat('c',32),'1'),
 ('c1700000-0000-4000-8000-000000000042','c1700000-0000-4000-8000-000000000011','c1700000-0000-4000-8000-000000000031','selection-image','selection-root','Synthetic.png','file','image','image/png',4,repeat('a',32),'1'),
 ('c1700000-0000-4000-8000-000000000045','c1700000-0000-4000-8000-000000000011','c1700000-0000-4000-8000-000000000031','selection-image-two','selection-root','Synthetic-two.png','file','image','image/png',4,repeat('b',32),'1');


insert into public.team_restitch_sources(team_id,slot,material_id,kind,sort_order,added_by)
 values('c1700000-0000-4000-8000-000000000011','end','c1700000-0000-4000-8000-000000000042','file',1,'c1700000-0000-4000-8000-000000000001');
create temp table process_alias_catalog as select public.service_begin_catalog_intent(
 'c1700000-0000-4000-8000-000000000011','c1700000-0000-4000-8000-000000000041','c1700000-0000-4000-8000-000000000001',
 'native-alias-original-catalog','{}','c1700000-0000-4000-8000-000000000090') receipt;
select public.service_accept_catalog_video_set('c1700000-0000-4000-8000-000000000011','c1700000-0000-4000-8000-000000000001','c1700000-0000-4000-8000-000000000090',
 jsonb_build_object('setId','c1700000-0000-4000-8000-000000000080','catalogIntentId',(select receipt->>'id' from process_alias_catalog),'sourceMaterialId','c1700000-0000-4000-8000-000000000041','sourceVersion','1',
 'settings','{"configured":true,"operation":"restitch","sourceMode":"drive","fitMode":"cover","startEnabled":false,"endEnabled":true,"startDurationMode":"one-frame","customStartDurationMs":1,"finalDurationMode":"random-40-50","customFinalDurationSeconds":2700}'::jsonb,
 'settingsDigest',repeat('b',64),'requestedCount',1,'productCount',1,'recipeRevision',1,'seed',repeat('c',64)),
 '[{"index":0,"requestId":"c1700000-0000-4000-8000-000000000081"}]',
 '[{"recipeRowId":"c1700000-0000-4000-8000-000000000082","videoVariantIndex":0}]');
insert into private.team_recovery_delegations(id,team_id,actor_id,installation_id,refresh_hash) values(
 'c1700000-0000-4000-8000-000000000092','c1700000-0000-4000-8000-000000000011','c1700000-0000-4000-8000-000000000001','c1700000-0000-4000-8000-000000000090',decode(repeat('bb',32),'hex'));
insert into private.team_recovery_credentials(hash,delegation_id,version,audience,expires_at) values(decode(repeat('aa',32),'hex'),'c1700000-0000-4000-8000-000000000092',1,'claim',clock_timestamp()+interval '1 hour');
insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce) values(
 'c1700000-0000-4000-8000-000000000083','c1700000-0000-4000-8000-000000000011','c1700000-0000-4000-8000-000000000001','process','running','c1700000-0000-4000-8000-000000000041',
 'catalog-variant:c1700000-0000-4000-8000-000000000081','catalog-variant:c1700000-0000-4000-8000-000000000081');
insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version,expected_source_drive_file_id,expected_source_checksum) values(
 'c1700000-0000-4000-8000-000000000083','c1700000-0000-4000-8000-000000000011','restitch','1','selection-video',repeat('c',32));
update private.catalog_video_variants set state='working',operation_id='c1700000-0000-4000-8000-000000000083' where video_set_id='c1700000-0000-4000-8000-000000000080';
select is((select count(*) from private.catalog_video_restitch_candidates where video_set_id='c1700000-0000-4000-8000-000000000080'),1::bigint,'original pool captured at set admission');
delete from public.team_restitch_sources where team_id='c1700000-0000-4000-8000-000000000011';
create temp table process_alias_receipt as select public.service_accept_catalog_video_restitch_alias(
 'c1700000-0000-4000-8000-000000000080',decode(repeat('aa',32),'hex'),'c1700000-0000-4000-8000-000000000091',1,0,
 'c1700000-0000-4000-8000-000000000081','c1700000-0000-4000-8000-000000000083') receipt;
select is((select receipt#>>'{recipe,logicalKind}' from process_alias_receipt),'process','logical process kind is explicit');
select is((select count(*) from private.restitch_selection_candidates where root_operation_id='c1700000-0000-4000-8000-000000000083'),1::bigint,'later pool deletion does not redraw accepted manifest');
select is(public.service_accept_catalog_video_restitch_alias('c1700000-0000-4000-8000-000000000080',decode(repeat('aa',32),'hex'),'c1700000-0000-4000-8000-000000000091',1,0,'c1700000-0000-4000-8000-000000000081','c1700000-0000-4000-8000-000000000083')->'recipe',
 (select receipt->'recipe' from process_alias_receipt),'replay retains sampled duration and recipe');
select ok(not has_table_privilege('service_role','private.restitch_process_aliases','select,insert,update,delete'),'alias rows remain private');
select ok(has_function_privilege('service_role','public.service_accept_catalog_video_restitch_alias(uuid,bytea,uuid,integer,integer,uuid,uuid)','execute') and not has_function_privilege('authenticated','public.service_accept_catalog_video_restitch_alias(uuid,bytea,uuid,integer,integer,uuid,uuid)','execute'),'only service factory accepts alias');
select throws_ok($$select public.service_accept_catalog_video_restitch_alias('c1700000-0000-4000-8000-000000000080',decode(repeat('aa',32),'hex'),'c1700000-0000-4000-8000-000000000099',1,0,'c1700000-0000-4000-8000-000000000081','c1700000-0000-4000-8000-000000000083')$$,'42501','PERMISSION_DENIED','different boot cannot adopt alias');
update public.team_materials set drive_version='2' where id='c1700000-0000-4000-8000-000000000041';
select throws_ok($$select private.require_restitch_executor('c1700000-0000-4000-8000-000000000083','c1700000-0000-4000-8000-000000000011','c1700000-0000-4000-8000-000000000001',null,null,true)$$,'55000','RESTITCH_SOURCES_INVALID','process source retains raw version policy');
select is((select state from public.team_operations where id='c1700000-0000-4000-8000-000000000083'),'running','selection admission never terminates canonical process');
select * from finish();
rollback;
