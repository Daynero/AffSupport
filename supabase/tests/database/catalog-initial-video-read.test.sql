begin;
select plan(14);
-- Hotfix 20261224360000: 072 (20261224210000) declared a PL/pgSQL variable `s` next to the table
-- alias `s` of the agentSilent check, so every read of a launch whose catalog video was still
-- being prepared raised 42702 «column reference "s.id" is ambiguous» and the launch stopped with
-- «Сервер відповів несподівано». No test read a preparing video through this function before.
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('c1720000-0000-4000-8000-000000000001','authenticated','authenticated','initial-video-read@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('c1720000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values('c1720000-0000-4000-8000-000000000011','Synthetic initial video read','c1720000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('c1720000-0000-4000-8000-000000000011','c1720000-0000-4000-8000-000000000001','admin') on conflict do nothing;
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope)
 values('c1720000-0000-4000-8000-000000000021','c1720000-0000-4000-8000-000000000001','initial-video-read','initial-video-read@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)
 values('c1720000-0000-4000-8000-000000000031','c1720000-0000-4000-8000-000000000011','c1720000-0000-4000-8000-000000000021','read-root','Synthetic root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version) values
 ('c1720000-0000-4000-8000-000000000041','c1720000-0000-4000-8000-000000000011','c1720000-0000-4000-8000-000000000031','read-video','read-root','Synthetic.mp4','file','video','video/mp4',4,repeat('c',32),'1'),
 ('c1720000-0000-4000-8000-000000000042','c1720000-0000-4000-8000-000000000011','c1720000-0000-4000-8000-000000000031','read-image','read-root','Synthetic.png','file','image','image/png',4,repeat('a',32),'1');
insert into public.team_restitch_sources(team_id,slot,material_id,kind,sort_order,added_by)
 values('c1720000-0000-4000-8000-000000000011','end','c1720000-0000-4000-8000-000000000042','file',1,'c1720000-0000-4000-8000-000000000001');
create temp table read_catalog as select public.service_begin_catalog_intent(
 'c1720000-0000-4000-8000-000000000011','c1720000-0000-4000-8000-000000000041','c1720000-0000-4000-8000-000000000001',
 'initial-video-read-catalog','{"catalogImageContractVersion":3}','c1720000-0000-4000-8000-000000000090') receipt;
select public.service_accept_catalog_video_set('c1720000-0000-4000-8000-000000000011','c1720000-0000-4000-8000-000000000001','c1720000-0000-4000-8000-000000000090',
 jsonb_build_object('setId','c1720000-0000-4000-8000-000000000080','catalogIntentId',(select receipt->>'id' from read_catalog),'sourceMaterialId','c1720000-0000-4000-8000-000000000041','sourceVersion','1',
 'settings','{"configured":true,"operation":"restitch","sourceMode":"drive","fitMode":"cover","startEnabled":false,"endEnabled":true,"startDurationMode":"one-frame","customStartDurationMs":1,"finalDurationMode":"random-40-50","customFinalDurationSeconds":2700}'::jsonb,
 'settingsDigest',repeat('b',64),'requestedCount',1,'productCount',1,'recipeRevision',1,'seed',repeat('c',64)),
 '[{"index":0,"requestId":"c1720000-0000-4000-8000-000000000081"}]',
 '[{"recipeRowId":"c1720000-0000-4000-8000-000000000082","videoVariantIndex":0}]');
select is((select state||':'||(native_instance_id is null)::text||':'||(executor_id is not null)::text from private.catalog_video_sets where id='c1720000-0000-4000-8000-000000000080'),
 'accepted:true:true','the set is accepted for an executor nobody has taken yet');

-- The reader under test wraps this one. It is replaced for the transaction so the wrapper sees
-- exactly the answer a preparing launch gives; the key carries the state to answer with.
create or replace function public.service_read_initial_catalog_video_before_foreground(p_team uuid,p_actor uuid,p_key text)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('outcome','preparing_video','catalogIntentId','c1720000-0000-4000-8000-000000000070',
  'videoSetId','c1720000-0000-4000-8000-000000000080','requestedCount',1,'registeredCount',0,'state',p_key);
$$;
create function pg_temp.read_video(p_state text) returns jsonb language sql as $$
 select public.service_read_initial_catalog_video('c1720000-0000-4000-8000-000000000011','c1720000-0000-4000-8000-000000000001',p_state);
$$;

-- 1. The regression: a preparing (or unknown) video is read, not refused with 42702.
select lives_ok($$select pg_temp.read_video('preparing')$$,'a preparing catalog video is read');
select lives_ok($$select pg_temp.read_video('unknown')$$,'a catalog video in an unknown state is read');
select is(pg_temp.read_video('preparing'),
 jsonb_build_object('outcome','preparing_video','catalogIntentId','c1720000-0000-4000-8000-000000000070','videoSetId','c1720000-0000-4000-8000-000000000080','requestedCount',1,'registeredCount',0,'state','preparing'),
 'a fresh set adds nothing to the answer');

-- 2. agentSilent: a working variant whose process gave no sign of life for two minutes.
insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce,created_at,updated_at) values(
 'c1720000-0000-4000-8000-000000000083','c1720000-0000-4000-8000-000000000011','c1720000-0000-4000-8000-000000000001','process','running','c1720000-0000-4000-8000-000000000041',
 'catalog-variant:c1720000-0000-4000-8000-000000000081','catalog-variant:c1720000-0000-4000-8000-000000000081',clock_timestamp()-interval '5 minutes',clock_timestamp()-interval '5 minutes');
update private.catalog_video_variants set state='working',operation_id='c1720000-0000-4000-8000-000000000083' where video_set_id='c1720000-0000-4000-8000-000000000080';
select ok(private.catalog_video_variant_last_life('c1720000-0000-4000-8000-000000000080',0,'c1720000-0000-4000-8000-000000000083')<=clock_timestamp()-interval '2 minutes','the variant has been silent for more than two minutes');
select is(pg_temp.read_video('preparing')->>'agentSilent','true','a silent working variant is reported while preparing');
select is(pg_temp.read_video('unknown')->>'agentSilent','true','a silent working variant is reported while unknown');
select ok(not pg_temp.read_video('ready') ? 'agentSilent','a ready video says nothing about silence');
update private.catalog_video_variants set heartbeat_at=clock_timestamp() where video_set_id='c1720000-0000-4000-8000-000000000080';
select ok(not pg_temp.read_video('preparing') ? 'agentSilent','a variant that just gave a sign of life is not silent');

-- 3. 072: a set handed to background work that nobody has taken for three minutes says why.
select ok(not pg_temp.read_video('preparing') ?| array['waitReason','backgroundStalled'],'a set accepted a moment ago is simply preparing');
update private.catalog_video_sets set created_at=clock_timestamp()-interval '5 minutes' where id='c1720000-0000-4000-8000-000000000080';
select is(pg_temp.read_video('preparing')->>'waitReason','AGENT_REQUIRED','without a living delegation the set waits for the agent');
insert into private.team_recovery_delegations(id,team_id,actor_id,installation_id,refresh_hash) values(
 'c1720000-0000-4000-8000-000000000092','c1720000-0000-4000-8000-000000000011','c1720000-0000-4000-8000-000000000001','c1720000-0000-4000-8000-000000000090',decode(repeat('bd',32),'hex'));
select is(pg_temp.read_video('preparing')->>'backgroundStalled','true','a delegation that never claimed since the set was accepted is a stalled background');
update private.team_recovery_delegations set last_claim_at=clock_timestamp() where id='c1720000-0000-4000-8000-000000000092';
select ok(not pg_temp.read_video('preparing') ?| array['waitReason','backgroundStalled'],'a delegation that claimed after the set was accepted is at work');
update public.team_drive_connections set state='needs_reauth' where id='c1720000-0000-4000-8000-000000000031';
select is(pg_temp.read_video('preparing')->>'waitReason','NEEDS_REAUTH','a Drive that needs sign-in is named before anything else');
select * from finish();
rollback;
