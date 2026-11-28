begin;
select plan(40);

-- 057 T101 (20261226300000): a catalog of an R2 space publishes its video link later. The link
-- registers a scheduled policy and a waiting job in its own transaction (no Drive read-back, no
-- legacy adoption); the updater keeps the video cells meanwhile; only the feed's own claim takes
-- the job, and only once it is due; its context names the feed and the R2 copy, which must be ready;
-- the generic reserve/dispatch/settle publish it; cancel and reschedule are the manager's actions;
-- deleting the catalog for good takes the publication with it. Drive answers as before.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05791010-0000-4000-8000-000000000001','authenticated','authenticated','scheduled-owner@test.invalid','{}','{}');
insert into public.storage_r2_pilots(user_id,max_space_bytes) values ('05791010-0000-4000-8000-000000000001',1000000000);
insert into public.teams(id,name,owner_id,storage_backend,storage_pilot) values
 ('05791010-0000-4000-8000-000000000011','Scheduled R2','05791010-0000-4000-8000-000000000001','r2',true);
insert into public.teams(id,name,owner_id) values
 ('05791010-0000-4000-8000-000000000012','Scheduled Drive','05791010-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('05791010-0000-4000-8000-000000000011','05791010-0000-4000-8000-000000000001','admin'),
 ('05791010-0000-4000-8000-000000000012','05791010-0000-4000-8000-000000000001','admin')
 on conflict do nothing;
insert into public.team_materials(id,team_id,name,kind) values
 ('05791010-0000-4000-8000-000000000101','05791010-0000-4000-8000-000000000011','Scheduled R2','folder');
update public.teams set storage_root_material_id='05791010-0000-4000-8000-000000000101'
 where id='05791010-0000-4000-8000-000000000011';
insert into public.space_objects(id,team_id,content_id,byte_size,content_type,r2_key,state) values
 ('05791010-0000-4000-8000-000000000201','05791010-0000-4000-8000-000000000011',repeat('3',64),5000,'video/mp4',
  't/05791010-0000-4000-8000-000000000011/o/'||repeat('3',64),'committed');
insert into public.team_materials(id,team_id,parent_folder_id,name,kind,category,mime_type,space_object_id,size_bytes) values
 ('05791010-0000-4000-8000-000000000103','05791010-0000-4000-8000-000000000011',
  '05791010-0000-4000-8000-000000000101','clip.mp4','file','video','video/mp4','05791010-0000-4000-8000-000000000201',5000);
update private.catalog_video_r2_config set enabled=true, public_origin='https://videos.test', policy_confirmed_at=now();

create temporary table seen(label text, value jsonb);
create function pg_temp.v(p_label text) returns jsonb language sql as $$ select value from seen where label=p_label order by ctid desc limit 1 $$;
create function pg_temp.team() returns uuid language sql as $$ select '05791010-0000-4000-8000-000000000011'::uuid $$;
create function pg_temp.owner() returns uuid language sql as $$ select '05791010-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.video() returns uuid language sql as $$ select '05791010-0000-4000-8000-000000000103'::uuid $$;
create function pg_temp.worker() returns uuid language sql as $$ select '05791010-0000-4000-8000-0000000000f1'::uuid $$;
create function pg_temp.catalog() returns uuid language sql as $$ select (pg_temp.v('commit')->>'materialId')::uuid $$;
create function pg_temp.job() returns private.catalog_video_publication_jobs language sql as $$
  select * from private.catalog_video_publication_jobs where catalog_material_id=pg_temp.catalog() order by revision desc limit 1 $$;
create function pg_temp.policy() returns private.catalog_video_publication_policies language sql as $$
  select * from private.catalog_video_publication_policies where catalog_material_id=pg_temp.catalog() $$;
create function pg_temp.r2_claim() returns jsonb language sql as $$
  select public.service_claim_space_catalog_publication_jobs(pg_temp.worker(), 3)->'items' $$;
create function pg_temp.publication(p_due timestamptz) returns jsonb language sql as $$
  select jsonb_build_object('mode','scheduled','localDateTime','2026-12-01T10:00','timeZone','Europe/Kyiv',
    'resolvedOffset','+02:00','dueAt',to_char(p_due at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) $$;

-- The creation: its intent with the accepted plan, the feed committed by its operation.
insert into seen select 'publication', pg_temp.publication(now() + interval '1 day');
insert into private.catalog_generation_intents(id,team_id,video_material_id,actor_id,request_key,request_digest,request_payload,checkpoint,variant,state) values
 ('05791010-0000-4000-8000-0000000000a1',pg_temp.team(),pg_temp.video(),pg_temp.owner(),
  'product-catalog:05791010-0000-4000-8000-0000000000a1','d1',
  jsonb_build_object('catalogVideoProtocolVersion',1,'restitchEnabled',false,'videoVariationCount',1,'videoPublication',pg_temp.v('publication')),
  jsonb_build_object('initialVideoPlan',jsonb_build_object('acceptedAt',floor(extract(epoch from now())*1000),
    'preferences',jsonb_build_object('catalogVideoProtocolVersion',1,'restitchEnabled',false,'videoVariationCount',1,'videoPublication',pg_temp.v('publication')))),
  1,'create_started');
insert into seen select 'link', public.service_space_catalog_video_link(pg_temp.team(), pg_temp.owner(), pg_temp.video());
create temporary table ops(operation_id uuid, state text, reused boolean);
insert into ops select * from public.service_start_team_operation(pg_temp.team(),pg_temp.owner(),'upload','catalog:scheduled-1',
  'catalog:scheduled-1',pg_temp.video(),'05791010-0000-4000-8000-000000000101','clip catalog 1',now()+interval '1 hour',null);
insert into seen select 'commit', public.service_commit_space_catalog_feed((select operation_id from ops),pg_temp.owner(),'clip catalog 1',2048);
create function pg_temp.record(p_extra jsonb) returns jsonb language sql as $$
  select jsonb_build_object('sourceLink','https://offer.test/?s=1','productCount',3,
    'sheetUrl','https://catalog-videos-beta.soty.pp.ua/feeds/'||repeat('e',32)||'.csv',
    'videoLink',pg_temp.v('link')->>'url','settingsSnapshot','{}'::jsonb,
    'createdBy',pg_temp.owner(),'variant',1,'feedId',repeat('e',32),'feedBytes',2048) || p_extra $$;

-- 1. The space's version of a video --------------------------------------------------------------
select is(private.space_catalog_publication_source_version(pg_temp.video(), pg_temp.team()), 'space-v1:'||repeat('3',64),
 'an R2 video''s publication version is its content id');
select ok(private.catalog_publication_source_matches(pg_temp.video(), pg_temp.team(), 'space-v1:'||repeat('3',64)),
 'and it matches while the content is the same');
select ok(not private.catalog_publication_source_matches(pg_temp.video(), pg_temp.team(), 'space-v1:'||repeat('4',64)),
 'another content does not');
select ok(strpos(pg_get_functiondef('private.catalog_publication_source_matches(uuid,uuid,text)'::regprocedure),
 $s$if p_version like 'content-v1:%' then return p_version=private.catalog_publication_source_version(p_material,p_team,false);end if;$s$) > 0
 and strpos(pg_get_functiondef('private.catalog_publication_source_matches(uuid,uuid,text)'::regprocedure),
 $s$if p_version like 'strict-v1:%' then return p_version=private.catalog_publication_source_version(p_material,p_team,true);end if;$s$) > 0,
 'the Drive versions are compared exactly as before');

-- 2. The link registers the publication ----------------------------------------------------------
select throws_ok($$select public.service_link_space_catalog_feed(pg_temp.team(), pg_temp.video(), pg_temp.catalog(), null,
  pg_temp.record(jsonb_build_object('spacePublicationKey', null)), pg_temp.owner())$$,
 'INVALID_INPUT', 'an empty publication key is refused');
insert into seen select 'linked', public.service_link_space_catalog_feed(pg_temp.team(), pg_temp.video(), pg_temp.catalog(), null,
  pg_temp.record(jsonb_build_object('spacePublicationKey','product-catalog:05791010-0000-4000-8000-0000000000a1')), pg_temp.owner());
select is(pg_temp.v('linked')->>'linked', 'true', 'the scheduled catalog links');
select is((pg_temp.policy()).mode||':'||(pg_temp.policy()).revision||':'||(pg_temp.policy()).time_zone, 'scheduled:1:Europe/Kyiv',
 'with a scheduled policy');
select is((pg_temp.policy()).due_at, (pg_temp.v('publication')->>'dueAt')::timestamptz, 'due when the dialog said');
select ok(not (pg_temp.policy()).legacy_delivery_unverified, 'verified from the start: no Drive sheet to adopt');
select is((pg_temp.job()).state||':'||coalesce((pg_temp.job()).blocked_reason,'-'), 'waiting:-', 'its job waits for its time');
select is(private.catalog_publication_target_json((pg_temp.policy()).target_id),
 jsonb_build_object('kind','source','materialId',pg_temp.video(),'sourceVersion','space-v1:'||repeat('3',64)),
 'the target is the video at its content');
select is((select count(*)::integer from private.catalog_publication_commands where request_id='05791010-0000-4000-8000-0000000000a1'), 1,
 'the creation is the publication''s command');
select ok(not public.service_catalog_publication_allows_legacy_write(pg_temp.catalog()),
 'the updater keeps the video cells until the job writes them');
select is(public.service_read_catalog_publication(pg_temp.team(), pg_temp.owner(), pg_temp.catalog())->>'dueState', 'future',
 'the publication reads as due later');
select is(public.service_read_catalog_publication(pg_temp.team(), pg_temp.owner(), pg_temp.catalog())->'targetObservation'->>'state', 'available',
 'with its video available');
select lives_ok($$select private.register_space_catalog_publication(pg_temp.team(), pg_temp.owner(), pg_temp.catalog(),
  'product-catalog:05791010-0000-4000-8000-0000000000a1')$$, 'registering again is harmless');
select is((select count(*)::integer from private.catalog_video_publication_jobs where catalog_material_id=pg_temp.catalog()), 1,
 'and adds no job');

update private.catalog_generation_intents set state='interrupted', next_attempt_at=now()-interval '1 minute'
 where id='05791010-0000-4000-8000-0000000000a1';
select ok(not exists (select 1 from jsonb_array_elements(public.service_list_initial_catalog_recovery(3)) e
  where e->>'idempotencyKey'='product-catalog:05791010-0000-4000-8000-0000000000a1'),
 'the Drive recovery lane never lists the creation of an R2 space');

-- 3. Nothing claims it before it is due --------------------------------------------------------
select is(pg_temp.r2_claim(), '[]'::jsonb, 'the feed''s claim waits for the time');
select ok(not private.catalog_publication_work_due(false), 'the lane is not woken for it');
update private.catalog_video_publication_policies set due_at = now() - interval '1 minute' where catalog_material_id=pg_temp.catalog();
select is(public.service_claim_catalog_publication_jobs(pg_temp.worker(), 3)->'items', '[]'::jsonb, 'the Drive claim never takes it');
select is(public.service_mark_due_catalog_publications_unsupported(3), 0, 'nor marks it unsupported');
select ok(private.catalog_publication_work_due(true), 'once due, the ten-second lane is woken');

-- 4. Due: the context waits for the copy, then the generic lane publishes ----------------------
insert into seen select 'claim', pg_temp.r2_claim();
select is(jsonb_array_length(pg_temp.v('claim')), 1, 'the feed''s claim takes the due job');
select is(pg_temp.v('claim')->0->'job'->'target'->>'kind', 'source', 'with its target');
select is(public.service_space_catalog_publication_context((pg_temp.job()).id, pg_temp.worker())->>'state', 'waiting',
 'the context waits while the copy is not ready');
update private.catalog_video_r2_copies set state='ready', ready_at=now() where id=(pg_temp.v('link')->>'copyId')::uuid;
insert into seen select 'context', public.service_space_catalog_publication_context((pg_temp.job()).id, pg_temp.worker());
select is(pg_temp.v('context') - 'sources', jsonb_build_object('state','ready','feedId',repeat('e',32),'productCount',3),
 'then names the feed');
select is(pg_temp.v('context')->'sources'->0->>'url', pg_temp.v('link')->>'url', 'and the copy''s public address');
select is((select link_kind||':'||source_version from private.catalog_publication_link_receipts where job_id=(pg_temp.job()).id),
 'r2:'||repeat('3',64), 'recorded as the job''s R2 receipt');
select throws_ok($$select public.service_space_catalog_publication_context((pg_temp.job()).id, gen_random_uuid())$$,
 'PROCESS_RESULT_UNCERTAIN', 'another worker reads nothing');
insert into seen select 'fence', to_jsonb(public.service_reserve_catalog_publication((pg_temp.job()).id, pg_temp.worker())::text);
select ok(public.service_dispatch_catalog_publication((pg_temp.job()).id, pg_temp.worker(), (pg_temp.v('fence')#>>'{}')::uuid),
 'the reserved write is dispatched');
select ok(public.service_settle_catalog_publication((pg_temp.job()).id, pg_temp.worker(), (pg_temp.v('fence')#>>'{}')::uuid, 'verified', '"etag-1"'),
 'and settled as verified');
select is((pg_temp.job()).state||':'||(pg_temp.policy()).mode, 'published:immediate', 'the job is published');
select is((select provider_revision from private.catalog_video_deliveries where catalog_material_id=pg_temp.catalog()), '"etag-1"',
 'its delivery recorded');

-- 5. Cancel and reschedule are the manager's ------------------------------------------------------
insert into seen select 'held', public.service_save_catalog_publication(pg_temp.team(), pg_temp.owner(), gen_random_uuid(), pg_temp.catalog(), 1,
  'held', null, null, private.catalog_publication_target_json((pg_temp.policy()).target_id));
select is((pg_temp.job()).state||':'||(pg_temp.policy()).revision, 'held:2', 'a cancel holds the link');
select is(pg_temp.r2_claim(), '[]'::jsonb, 'and nothing claims a held job');
insert into seen select 'again', public.service_save_catalog_publication(pg_temp.team(), pg_temp.owner(), gen_random_uuid(), pg_temp.catalog(), 2,
  'scheduled', now() + interval '2 hours', 'Europe/Kyiv', private.catalog_publication_target_json((pg_temp.policy()).target_id));
select is((pg_temp.job()).state||':'||(pg_temp.policy()).mode, 'waiting:scheduled', 'a reschedule waits for its new time');

-- 6. Deleted for good ------------------------------------------------------------------------------
update public.team_materials set lifecycle='trashed', trashed_at=now() where id=pg_temp.catalog();
select lives_ok($$delete from public.team_materials where id=pg_temp.catalog()$$, 'the catalog leaves the space for good');
select is((select count(*)::integer from private.catalog_video_publication_jobs where catalog_material_id=pg_temp.catalog())
  + (select count(*)::integer from private.catalog_video_publication_policies where catalog_material_id=pg_temp.catalog())
  + (select count(*)::integer from private.catalog_publication_targets where source_material_id=pg_temp.video()), 0,
 'with its policy, its jobs and their targets');
select ok(strpos(pg_get_functiondef('public.service_claim_catalog_publication_jobs(uuid,integer)'::regprocedure),
 'private.catalog_connection_usable(q.catalog_material_id)') > 0, 'the Drive claim still asks for a Drive connection');

select * from finish();
rollback;
