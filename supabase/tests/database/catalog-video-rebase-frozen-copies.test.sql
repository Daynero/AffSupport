begin;
select plan(24);
-- Production 2026-11-26 (set ccd19207): Drive moved the video from version 3 to 5 while its
-- catalog was being made with the window open (Soty's own sharing and R2 copy do that). The
-- rebase of 20261215110000 moved the set and left its window-bound authority and its picture
-- context at 3, so every later call of the set was refused for good. (20261224400000)
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('c1750000-0000-4000-8000-000000000001','authenticated','authenticated','rebase-frozen@test.invalid','{}','{}');
insert into auth.sessions(id,user_id,created_at,updated_at) values('c1750000-0000-4000-8000-000000000002','c1750000-0000-4000-8000-000000000001',now(),now());
insert into public.admin_users(user_id) values('c1750000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values('c1750000-0000-4000-8000-000000000011','Synthetic rebase','c1750000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('c1750000-0000-4000-8000-000000000011','c1750000-0000-4000-8000-000000000001','admin') on conflict do nothing;
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope)
 values('c1750000-0000-4000-8000-000000000021','c1750000-0000-4000-8000-000000000001','rebase-frozen','rebase-frozen@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)
 values('c1750000-0000-4000-8000-000000000031','c1750000-0000-4000-8000-000000000011','c1750000-0000-4000-8000-000000000021','rebase-root','Synthetic root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version) values
 ('c1750000-0000-4000-8000-000000000041','c1750000-0000-4000-8000-000000000011','c1750000-0000-4000-8000-000000000031','rebase-video','rebase-root','Synthetic.mp4','file','video','video/mp4',4,repeat('c',32),'3'),
 ('c1750000-0000-4000-8000-000000000042','c1750000-0000-4000-8000-000000000011','c1750000-0000-4000-8000-000000000031','rebase-image','rebase-root','Synthetic.png','file','image','image/png',4,repeat('a',32),'1');
insert into public.team_restitch_sources(team_id,slot,material_id,kind,sort_order,added_by)
 values('c1750000-0000-4000-8000-000000000011','end','c1750000-0000-4000-8000-000000000042','file',1,'c1750000-0000-4000-8000-000000000001');
-- The set is made with the window open: its executor is the enrollment ...090, running in ...091.
create temp table rebase_catalog as select public.service_begin_catalog_intent(
 'c1750000-0000-4000-8000-000000000011','c1750000-0000-4000-8000-000000000041','c1750000-0000-4000-8000-000000000001',
 'rebase-frozen-catalog','{"catalogImageContractVersion":3}','c1750000-0000-4000-8000-000000000090') receipt;
select public.service_accept_catalog_video_set('c1750000-0000-4000-8000-000000000011','c1750000-0000-4000-8000-000000000001','c1750000-0000-4000-8000-000000000090',
 jsonb_build_object('setId','c1750000-0000-4000-8000-000000000080','catalogIntentId',(select receipt->>'id' from rebase_catalog),'sourceMaterialId','c1750000-0000-4000-8000-000000000041','sourceVersion','3',
 'settings','{"configured":true,"operation":"restitch","sourceMode":"drive","fitMode":"cover","startEnabled":false,"endEnabled":true,"startDurationMode":"one-frame","customStartDurationMs":1,"finalDurationMode":"random-40-50","customFinalDurationSeconds":2700}'::jsonb,
 'settingsDigest',repeat('b',64),'requestedCount',1,'productCount',1,'recipeRevision',1,'seed',repeat('c',64)),
 '[{"index":0,"requestId":"c1750000-0000-4000-8000-000000000081"}]',
 '[{"recipeRowId":"c1750000-0000-4000-8000-000000000082","videoVariantIndex":0}]');
update private.catalog_video_sets set native_instance_id='c1750000-0000-4000-8000-000000000091' where id='c1750000-0000-4000-8000-000000000080';
insert into private.catalog_video_foreground_authorities(enrollment_id,video_set_id,team_id,actor_id,session_id,source_material_id,source_version,settings_digest,
  consumer_kind,original_key,canonical_key,original_request_id,admitted_at,native_instance_id,execution_native_instance_id,proof_hash,token_hash,challenge_until,expires_at,redeemed_at)
 values('c1750000-0000-4000-8000-000000000090','c1750000-0000-4000-8000-000000000080','c1750000-0000-4000-8000-000000000011','c1750000-0000-4000-8000-000000000001',
  'c1750000-0000-4000-8000-000000000002','c1750000-0000-4000-8000-000000000041','3',repeat('b',64),'create','rebase-frozen-catalog','rebase-frozen-catalog',
  'c1750000-0000-4000-8000-000000000093',clock_timestamp(),'c1750000-0000-4000-8000-000000000091','c1750000-0000-4000-8000-000000000091',
  decode(repeat('ab',32),'hex'),decode(repeat('ad',32),'hex'),clock_timestamp()+interval '2 minutes',clock_timestamp()+interval '1 day',clock_timestamp());

create function pg_temp.authorize() returns jsonb language sql as $$
 select public.service_authorize_catalog_video_executor('c1750000-0000-4000-8000-000000000080',decode(repeat('ad',32),'hex'),'c1750000-0000-4000-8000-000000000091',1);
$$;
create function pg_temp.rebase(p_version text,p_checksum text) returns boolean language sql as $$
 select public.service_rebase_catalog_video_source('c1750000-0000-4000-8000-000000000080',decode(repeat('ad',32),'hex'),'c1750000-0000-4000-8000-000000000091',1,p_version,p_checksum);
$$;
create function pg_temp.versions() returns text language sql as $$
 select 'set '||s.source_version||', snapshot '||(s.source_snapshot->>'version')
  ||', authority '||(select f.source_version from private.catalog_video_foreground_authorities f where f.video_set_id=s.id)
  ||', context '||(select c.source_version from private.catalog_video_restitch_contexts c where c.video_set_id=s.id)
 from private.catalog_video_sets s where s.id='c1750000-0000-4000-8000-000000000080';
$$;
select is(pg_temp.versions(),'set 3, snapshot 3, authority 3, context 3','everything is frozen at version 3 when the set is admitted');
select is(pg_temp.authorize()->>'executionMode','paired_session','the window-bound executor is authorised');

-- A real change is still refused, and nothing moves.
update public.team_materials set drive_version='4',checksum=repeat('d',32) where id='c1750000-0000-4000-8000-000000000041';
select throws_ok($$select pg_temp.rebase('4',repeat('d',32))$$,'55000','SOURCE_CHANGED','other bytes are not rebased');
select is(pg_temp.versions(),'set 3, snapshot 3, authority 3, context 3','a refused rebase leaves every copy where it was');

-- The incident: the same bytes under version 5.
update public.team_materials set drive_version='5',checksum=repeat('c',32) where id='c1750000-0000-4000-8000-000000000041';
select is(pg_temp.rebase('5',repeat('c',32)),true,'the same bytes under a newer Drive version rebase the set');
select is(pg_temp.versions(),'set 5, snapshot 5, authority 5, context 5','the authority and the picture context move with the set');
select lives_ok($$select pg_temp.authorize()$$,'the executor is still authorised after the rebase');
select is(public.service_read_catalog_video_admission('c1750000-0000-4000-8000-000000000080',decode(repeat('ad',32),'hex'),'c1750000-0000-4000-8000-000000000091',1,0,'c1750000-0000-4000-8000-000000000081')->>'sourceVersion',
 '5','the read that follows the rebase answers with the new version (it was refused on production)');
select is(pg_temp.rebase('5',repeat('c',32)),true,'a repeated rebase to the same version changes nothing');

-- The next video is admitted at version 5 and its pictures are drawn in the same context.
insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce) values(
 'c1750000-0000-4000-8000-000000000083','c1750000-0000-4000-8000-000000000011','c1750000-0000-4000-8000-000000000001','process','running','c1750000-0000-4000-8000-000000000041',
 'catalog-variant:c1750000-0000-4000-8000-000000000081','catalog-variant:c1750000-0000-4000-8000-000000000081');
insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version,expected_source_drive_file_id,expected_source_checksum) values(
 'c1750000-0000-4000-8000-000000000083','c1750000-0000-4000-8000-000000000011','restitch','5','rebase-video',repeat('c',32));
update private.catalog_video_variants set state='working',operation_id='c1750000-0000-4000-8000-000000000083' where video_set_id='c1750000-0000-4000-8000-000000000080';
select lives_ok($$select public.service_accept_catalog_video_restitch_alias('c1750000-0000-4000-8000-000000000080',decode(repeat('ad',32),'hex'),'c1750000-0000-4000-8000-000000000091',1,0,
 'c1750000-0000-4000-8000-000000000081','c1750000-0000-4000-8000-000000000083')$$,'the process alias of the next video is accepted after the rebase');
select is((select source_version from private.restitch_process_aliases where root_operation_id='c1750000-0000-4000-8000-000000000083'),'5','the alias is bound to the rebased version');
select is((select count(*) from private.restitch_selection_candidates where root_operation_id='c1750000-0000-4000-8000-000000000083'),1::bigint,'and holds the set''s picture');

-- A second move while that video is in flight carries its intent along as before.
update public.team_materials set drive_version='7' where id='c1750000-0000-4000-8000-000000000041';
select is(pg_temp.rebase('7',repeat('c',32)),true,'a later move rebases again');
select is(pg_temp.versions(),'set 7, snapshot 7, authority 7, context 7','every copy follows again');
select is((select expected_source_version from private.team_operation_intents where operation_id='c1750000-0000-4000-8000-000000000083'),'7','the admitted video''s intent follows, as it did');
select lives_ok($$select pg_temp.authorize()$$,'and the executor stays authorised');

-- The copies are still frozen: the only move is the source version, and only to the set's own.
select throws_ok($$update private.catalog_video_foreground_authorities set source_version='9' where video_set_id='c1750000-0000-4000-8000-000000000080'$$,
 '55000','REQUEST_REUSE_CONFLICT','an authority cannot take a version its set does not hold');
select throws_ok($$update private.catalog_video_foreground_authorities set settings_digest=repeat('e',64) where video_set_id='c1750000-0000-4000-8000-000000000080'$$,
 '55000','REQUEST_REUSE_CONFLICT','nor change its settings');
select throws_ok($$update private.catalog_video_foreground_authorities set video_set_id=null,source_version=null,settings_digest=null,challenge_until=null,redeemed_at=null where video_set_id='c1750000-0000-4000-8000-000000000080'$$,
 '55000','REQUEST_REUSE_CONFLICT','nor leave its set');
select throws_ok($$update private.catalog_video_restitch_contexts set source_version='9' where video_set_id='c1750000-0000-4000-8000-000000000080'$$,
 '55000','WRONG_STATE','a context cannot take a version its set does not hold');
select throws_ok($$update private.catalog_video_restitch_contexts set settings_digest=repeat('e',64) where video_set_id='c1750000-0000-4000-8000-000000000080'$$,
 '55000','WRONG_STATE','nor change anything else');
select throws_ok($$update private.catalog_video_restitch_contexts set source_version='7',defaults='{}'::jsonb where video_set_id='c1750000-0000-4000-8000-000000000080'$$,
 '55000','WRONG_STATE','not even together with the version it may hold');
select throws_ok($$update private.restitch_process_aliases set source_version='7' where root_operation_id='c1750000-0000-4000-8000-000000000083'$$,
 '55000','WRONG_STATE','an accepted alias stays exactly as accepted');
select ok(not has_function_privilege('service_role','private.guard_catalog_video_context_immutable()','execute'),'the guard is nobody''s to call');
select * from finish();
rollback;
