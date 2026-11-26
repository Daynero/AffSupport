begin;
select plan(15);
-- Production 2026-11-26: set 3f284d98 was rebased from Drive version 4 to 6 by the rebase that
-- predates 20261224400000. The set moved and its window-bound authority and picture context did
-- not, so every call of it was refused with AUTH_REQUIRED. 20261224410000 brings those two
-- frozen copies to their own set's version — the one move the guards allow — and nothing else.
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('c1760000-0000-4000-8000-000000000001','authenticated','authenticated','heal-rebased@test.invalid','{}','{}');
insert into auth.sessions(id,user_id,created_at,updated_at) values('c1760000-0000-4000-8000-000000000002','c1760000-0000-4000-8000-000000000001',now(),now());
insert into public.admin_users(user_id) values('c1760000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values('c1760000-0000-4000-8000-000000000011','Synthetic heal','c1760000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('c1760000-0000-4000-8000-000000000011','c1760000-0000-4000-8000-000000000001','admin') on conflict do nothing;
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope)
 values('c1760000-0000-4000-8000-000000000021','c1760000-0000-4000-8000-000000000001','heal-rebased','heal-rebased@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)
 values('c1760000-0000-4000-8000-000000000031','c1760000-0000-4000-8000-000000000011','c1760000-0000-4000-8000-000000000021','heal-root','Synthetic root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version) values
 ('c1760000-0000-4000-8000-000000000041','c1760000-0000-4000-8000-000000000011','c1760000-0000-4000-8000-000000000031','heal-video','heal-root','Synthetic.mp4','file','video','video/mp4',4,repeat('c',32),'3'),
 ('c1760000-0000-4000-8000-000000000042','c1760000-0000-4000-8000-000000000011','c1760000-0000-4000-8000-000000000031','heal-image','heal-root','Synthetic.png','file','image','image/png',4,repeat('a',32),'1');
insert into public.team_restitch_sources(team_id,slot,material_id,kind,sort_order,added_by)
 values('c1760000-0000-4000-8000-000000000011','end','c1760000-0000-4000-8000-000000000042','file',1,'c1760000-0000-4000-8000-000000000001');
-- The set is made with the window open: its executor is the enrollment ...090, running in ...091.
create temp table heal_catalog as select public.service_begin_catalog_intent(
 'c1760000-0000-4000-8000-000000000011','c1760000-0000-4000-8000-000000000041','c1760000-0000-4000-8000-000000000001',
 'heal-rebased-catalog','{"catalogImageContractVersion":3}','c1760000-0000-4000-8000-000000000090') receipt;
select public.service_accept_catalog_video_set('c1760000-0000-4000-8000-000000000011','c1760000-0000-4000-8000-000000000001','c1760000-0000-4000-8000-000000000090',
 jsonb_build_object('setId','c1760000-0000-4000-8000-000000000080','catalogIntentId',(select receipt->>'id' from heal_catalog),'sourceMaterialId','c1760000-0000-4000-8000-000000000041','sourceVersion','3',
 'settings','{"configured":true,"operation":"restitch","sourceMode":"drive","fitMode":"cover","startEnabled":false,"endEnabled":true,"startDurationMode":"one-frame","customStartDurationMs":1,"finalDurationMode":"random-40-50","customFinalDurationSeconds":2700}'::jsonb,
 'settingsDigest',repeat('b',64),'requestedCount',1,'productCount',1,'recipeRevision',1,'seed',repeat('c',64)),
 '[{"index":0,"requestId":"c1760000-0000-4000-8000-000000000081"}]',
 '[{"recipeRowId":"c1760000-0000-4000-8000-000000000082","videoVariantIndex":0}]');
update private.catalog_video_sets set native_instance_id='c1760000-0000-4000-8000-000000000091' where id='c1760000-0000-4000-8000-000000000080';
insert into private.catalog_video_foreground_authorities(enrollment_id,video_set_id,team_id,actor_id,session_id,source_material_id,source_version,settings_digest,
  consumer_kind,original_key,canonical_key,original_request_id,admitted_at,native_instance_id,execution_native_instance_id,proof_hash,token_hash,challenge_until,expires_at,redeemed_at)
 values('c1760000-0000-4000-8000-000000000090','c1760000-0000-4000-8000-000000000080','c1760000-0000-4000-8000-000000000011','c1760000-0000-4000-8000-000000000001',
  'c1760000-0000-4000-8000-000000000002','c1760000-0000-4000-8000-000000000041','3',repeat('b',64),'create','heal-rebased-catalog','heal-rebased-catalog',
  'c1760000-0000-4000-8000-000000000093',clock_timestamp(),'c1760000-0000-4000-8000-000000000091','c1760000-0000-4000-8000-000000000091',
  decode(repeat('ab',32),'hex'),decode(repeat('ad',32),'hex'),clock_timestamp()+interval '2 minutes',clock_timestamp()+interval '1 day',clock_timestamp());

create function pg_temp.authorize() returns jsonb language sql as $$
 select public.service_authorize_catalog_video_executor('c1760000-0000-4000-8000-000000000080',decode(repeat('ad',32),'hex'),'c1760000-0000-4000-8000-000000000091',1);
$$;
create function pg_temp.versions() returns text language sql as $$
 select 'set '||s.source_version||', snapshot '||(s.source_snapshot->>'version')
  ||', authority '||(select f.source_version from private.catalog_video_foreground_authorities f where f.video_set_id=s.id)
  ||', context '||(select c.source_version from private.catalog_video_restitch_contexts c where c.video_set_id=s.id)
 from private.catalog_video_sets s where s.id='c1760000-0000-4000-8000-000000000080';
$$;
create function pg_temp.admission() returns jsonb language sql as $$
 select public.service_read_catalog_video_admission('c1760000-0000-4000-8000-000000000080',decode(repeat('ad',32),'hex'),'c1760000-0000-4000-8000-000000000091',1,0,'c1760000-0000-4000-8000-000000000081');
$$;
-- What the rebase before 20261224400000 did: the set and its snapshot move, the copies do not.
create function pg_temp.old_rebase(p_version text) returns void language sql as $$
 update public.team_materials set drive_version=p_version where id='c1760000-0000-4000-8000-000000000041';
 update private.catalog_video_sets set source_version=p_version,source_snapshot=jsonb_set(source_snapshot,'{version}',to_jsonb(p_version)),updated_at=clock_timestamp()
  where id='c1760000-0000-4000-8000-000000000080';
$$;
create temp table untouched as select f.*::text authority from private.catalog_video_foreground_authorities f where f.video_set_id='c1760000-0000-4000-8000-000000000080';

select is(pg_temp.versions(),'set 3, snapshot 3, authority 3, context 3','a set in step with its copies');
select is(private.heal_rebased_foreground_sets(),0,'leaves a set in step alone');
select is((select f.*::text from private.catalog_video_foreground_authorities f where f.video_set_id='c1760000-0000-4000-8000-000000000080'),(select authority from untouched),'and does not touch its authority at all');

select pg_temp.old_rebase('6');
select is(pg_temp.versions(),'set 6, snapshot 6, authority 3, context 3','the incident: the set was rebased and its copies stayed behind');
select throws_like($$select pg_temp.admission()$$,'%AUTH_REQUIRED%','so every call of the set is refused');

select is(private.heal_rebased_foreground_sets(),2,'the heal moves the authority and the context');
select is(pg_temp.versions(),'set 6, snapshot 6, authority 6, context 6','both copies now hold their set''s version');
select lives_ok($$select pg_temp.authorize()$$,'the window-bound executor is authorised again');
select is(pg_temp.admission()->>'sourceVersion','6','and the admission read answers instead of AUTH_REQUIRED');
select is((select f.settings_digest||f.token_hash::text||f.original_key from private.catalog_video_foreground_authorities f where f.video_set_id='c1760000-0000-4000-8000-000000000080'),
 (select repeat('b',64)||decode(repeat('ad',32),'hex')::text||'heal-rebased-catalog'),'nothing else on the authority moved');
select is(private.heal_rebased_foreground_sets(),0,'a second run finds nothing to do');

-- A finished set keeps its copies as they were.
select pg_temp.old_rebase('8');
update private.catalog_video_sets set state='canceled' where id='c1760000-0000-4000-8000-000000000080';
select is(private.heal_rebased_foreground_sets(),0,'a canceled set is not healed');
select is(pg_temp.versions(),'set 8, snapshot 8, authority 6, context 6','its copies stay where they were');

select ok(not has_function_privilege('service_role','private.heal_rebased_foreground_sets()','execute'),'the heal is not the service''s to call');
select ok(not has_function_privilege('authenticated','private.heal_rebased_foreground_sets()','execute'),'nor a signed-in person''s');
select * from finish();
rollback;
