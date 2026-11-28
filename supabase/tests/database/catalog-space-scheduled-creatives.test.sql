begin;
select plan(42);

-- 057 T116 (20261226330000): a Launch catalog of an R2 space with several creatives or pictures
-- publishes its links later. The link registers a 'creatives' target — a segment per creative,
-- named by its space content, never a Drive set — with the scheduled policy; the feed's context
-- answers each segment's rows (a video's copy, a re-stitched video's variations with its seed, a
-- picture's c1/ address) and waits for copies; the generic lane publishes it; the manager's hold,
-- reschedule and «add now» keep the target; growth stays refused; deleting the catalog for good
-- takes the target's segments too. Drive's functions are not touched.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05791160-0000-4000-8000-000000000001','authenticated','authenticated','scheduled-creatives@test.invalid','{}','{}');
insert into public.storage_r2_pilots(user_id,max_space_bytes) values ('05791160-0000-4000-8000-000000000001',1000000000);
insert into public.teams(id,name,owner_id,storage_backend,storage_pilot) values
 ('05791160-0000-4000-8000-000000000011','Scheduled creatives R2','05791160-0000-4000-8000-000000000001','r2',true);
insert into public.team_members(team_id,user_id,base_role) values
 ('05791160-0000-4000-8000-000000000011','05791160-0000-4000-8000-000000000001','admin')
 on conflict do nothing;
insert into public.team_materials(id,team_id,name,kind) values
 ('05791160-0000-4000-8000-000000000101','05791160-0000-4000-8000-000000000011','Scheduled creatives R2','folder');
update public.teams set storage_root_material_id='05791160-0000-4000-8000-000000000101'
 where id='05791160-0000-4000-8000-000000000011';
-- Videos 1..5 (two creatives, three variation outputs), pictures 6..7.
insert into public.space_objects(id,team_id,content_id,byte_size,content_type,r2_key,state)
select ('05791160-0000-4000-8000-00000000020'||n)::uuid, '05791160-0000-4000-8000-000000000011', repeat(n::text,64),
  5000, case when n<=5 then 'video/mp4' else 'image/png' end,
  't/05791160-0000-4000-8000-000000000011/o/'||repeat(n::text,64), 'committed'
from generate_series(1,7) n;
insert into public.team_materials(id,team_id,parent_folder_id,name,kind,category,mime_type,space_object_id,size_bytes)
select ('05791160-0000-4000-8000-00000000010'||(n+2))::uuid, '05791160-0000-4000-8000-000000000011',
  '05791160-0000-4000-8000-000000000101', 'file'||n||case when n<=5 then '.mp4' else '.png' end, 'file',
  case when n<=5 then 'video' else 'image' end, case when n<=5 then 'video/mp4' else 'image/png' end,
  ('05791160-0000-4000-8000-00000000020'||n)::uuid, 5000
from generate_series(1,7) n;
update private.catalog_video_r2_config set enabled=true, public_origin='https://videos.test', policy_confirmed_at=now();

create temporary table seen(label text, value jsonb);
create function pg_temp.v(p_label text) returns jsonb language sql as $$ select value from seen where label=p_label order by ctid desc limit 1 $$;
create function pg_temp.team() returns uuid language sql as $$ select '05791160-0000-4000-8000-000000000011'::uuid $$;
create function pg_temp.owner() returns uuid language sql as $$ select '05791160-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.worker() returns uuid language sql as $$ select '05791160-0000-4000-8000-0000000000f1'::uuid $$;
-- file(n): the material of object n (1..5 videos, 6..7 pictures).
create function pg_temp.file(n integer) returns uuid language sql as $$ select ('05791160-0000-4000-8000-00000000010'||(n+2))::uuid $$;
create function pg_temp.id(p_kind integer, n integer) returns uuid language sql as $$
  select ('05791160-0000-4000-8000-'||lpad(p_kind::text,4,'0')||lpad(n::text,8,'0'))::uuid $$;
create function pg_temp.catalog(p_label text) returns uuid language sql as $$ select (pg_temp.v(p_label)->>'materialId')::uuid $$;
create function pg_temp.job(p_catalog uuid) returns private.catalog_video_publication_jobs language sql as $$
  select * from private.catalog_video_publication_jobs where catalog_material_id=p_catalog order by revision desc limit 1 $$;
create function pg_temp.policy(p_catalog uuid) returns private.catalog_video_publication_policies language sql as $$
  select * from private.catalog_video_publication_policies where catalog_material_id=p_catalog $$;
create function pg_temp.context(p_catalog uuid) returns jsonb language sql as $$
  select public.service_space_catalog_publication_context((pg_temp.job(p_catalog)).id, pg_temp.worker()) $$;
create function pg_temp.publish(p_catalog uuid) returns boolean language plpgsql as $$
declare fence uuid;
begin
  fence := public.service_reserve_catalog_publication((pg_temp.job(p_catalog)).id, pg_temp.worker());
  perform public.service_dispatch_catalog_publication((pg_temp.job(p_catalog)).id, pg_temp.worker(), fence);
  return public.service_settle_catalog_publication((pg_temp.job(p_catalog)).id, pg_temp.worker(), fence, 'verified', '"etag"');
end $$;
insert into seen select 'publication', jsonb_build_object('mode','scheduled','localDateTime','2026-12-01T10:00',
  'timeZone','Europe/Kyiv','resolvedOffset','+02:00',
  'dueAt',to_char((now() + interval '1 day') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
-- A Launch creation of three rows: its creatives as plan segments (rows 0-1 and 2).
create function pg_temp.segment(p_ordinal integer, p_material uuid, p_kind text, p_set uuid, p_requests jsonb) returns jsonb language sql as $$
  select jsonb_build_object('ordinal',p_ordinal,'materialId',p_material,'alias','c'||p_ordinal,'kind',p_kind,
    'rowStart',case when p_ordinal=0 then 0 else 2 end,'rowCount',case when p_ordinal=0 then 2 else 1 end,
    'variantCount',case when p_set is null then case when p_kind='image' then 0 else 1 end else jsonb_array_length(p_requests) end,
    'setId',p_set,'childRequestIds',p_requests,'assignmentSeed',repeat(chr(97+p_ordinal),64)) $$;
create function pg_temp.intent(p_n integer, p_kind text, p_restitch boolean, p_segments jsonb) returns uuid language sql as $$
  insert into private.catalog_generation_intents(id,team_id,video_material_id,actor_id,request_key,request_digest,request_payload,checkpoint,variant,state)
  values (pg_temp.id(10,p_n), pg_temp.team(), (p_segments->0->>'materialId')::uuid, pg_temp.owner(),
    'launch:'||pg_temp.id(11,p_n)||':catalog', 'd'||p_n,
    jsonb_build_object('catalogVideoProtocolVersion',1,'restitchEnabled',p_restitch,'videoVariationCount',case when p_restitch then 3 else 1 end,
      'videoPublication',pg_temp.v('publication'),'creativeKind',p_kind),
    jsonb_build_object('initialVideoPlan',jsonb_build_object('acceptedAt',floor(extract(epoch from now())*1000),
      'recipeRowIds',jsonb_build_array(pg_temp.id(12,p_n*10+1),pg_temp.id(12,p_n*10+2),pg_temp.id(12,p_n*10+3)),
      'assignmentSeed',repeat('f',64),'segments',p_segments,
      'preferences',jsonb_build_object('catalogVideoProtocolVersion',1,'restitchEnabled',p_restitch,
        'videoVariationCount',case when p_restitch then 3 else 1 end,'videoPublication',pg_temp.v('publication')))),
    p_n, 'create_started')
  returning id $$;
create temporary table ops(operation_id uuid, state text, reused boolean);
create function pg_temp.feed(p_key text, p_video uuid) returns jsonb language plpgsql as $$
declare op uuid;
begin
  select operation_id into op from public.service_start_team_operation(pg_temp.team(),pg_temp.owner(),'upload',p_key,p_key,p_video,
    '05791160-0000-4000-8000-000000000101',p_key,now()+interval '1 hour',null);
  return public.service_commit_space_catalog_feed(op,pg_temp.owner(),p_key,2048);
end $$;
create function pg_temp.record(p_feed text, p_kind text, p_first uuid, p_second uuid, p_extra jsonb) returns jsonb language sql as $$
  select jsonb_build_object('sourceLink','https://offer.test/?s=1','productCount',3,
    'sheetUrl','https://catalog-videos-beta.soty.pp.ua/feeds/'||p_feed||'.csv',
    'videoLink',case when p_kind='image' then null else 'https://videos.test/v/x' end,
    'settingsSnapshot',jsonb_build_object('_catalogCreativeKind',p_kind,'_catalogRowCreatives','[0,0,1]'::jsonb,
      '_catalogCreatives',jsonb_build_array(
        jsonb_build_object('ordinal',0,'materialId',p_first,'alias','c0','kind',p_kind),
        jsonb_build_object('ordinal',1,'materialId',p_second,'alias','c1','kind',p_kind))),
    'createdBy',pg_temp.owner(),'variant',1,'feedId',p_feed,'feedBytes',2048) || p_extra $$;

-- 1. A picture of a space is named by its content -------------------------------------------------
select is(private.space_catalog_publication_source_version(pg_temp.file(6), pg_temp.team()), 'space-v1:'||repeat('6',64),
 'a picture''s publication version is its content id');
select ok(private.catalog_publication_source_matches(pg_temp.file(6), pg_temp.team(), 'space-v1:'||repeat('6',64)),
 'and it matches while the content is the same');

-- 2. Two videos published later: a target per creative --------------------------------------------
insert into seen select 'intent1', to_jsonb(pg_temp.intent(1, 'video', false, jsonb_build_array(
  pg_temp.segment(0, pg_temp.file(1), 'video', null, '[]'), pg_temp.segment(1, pg_temp.file(2), 'video', null, '[]'))));
insert into seen select 'link1', public.service_space_catalog_video_link(pg_temp.team(), pg_temp.owner(), pg_temp.file(1));
insert into seen select 'link2', public.service_space_catalog_video_link(pg_temp.team(), pg_temp.owner(), pg_temp.file(2));
insert into seen select 'videos', pg_temp.feed('catalog:videos', pg_temp.file(1));
insert into seen select 'linked', public.service_link_space_catalog_feed(pg_temp.team(), pg_temp.file(1), pg_temp.catalog('videos'), null,
  pg_temp.record(repeat('a',32), 'video', pg_temp.file(1), pg_temp.file(2),
    jsonb_build_object('spacePublicationKey','launch:'||pg_temp.id(11,1)||':catalog')), pg_temp.owner());
select is(pg_temp.v('linked')->>'linked', 'true', 'the catalog of two videos links');
select is((pg_temp.policy(pg_temp.catalog('videos'))).mode||':'||(pg_temp.job(pg_temp.catalog('videos'))).state, 'scheduled:waiting',
 'with a scheduled policy and a waiting job');
select is(private.catalog_publication_target_json((pg_temp.policy(pg_temp.catalog('videos'))).target_id),
 jsonb_build_object('kind','creatives','segments',jsonb_build_array(
   jsonb_build_object('ordinal',0,'kind','video','materialId',pg_temp.file(1),'sourceVersion','space-v1:'||repeat('1',64),'rowStart',0,'rowCount',2),
   jsonb_build_object('ordinal',1,'kind','video','materialId',pg_temp.file(2),'sourceVersion','space-v1:'||repeat('2',64),'rowStart',2,'rowCount',1))),
 'its target is a segment per creative, each at its content, no Drive set');
select ok(not public.service_catalog_publication_allows_legacy_write(pg_temp.catalog('videos')),
 'the updater keeps the cells until the job writes them');
select is(public.service_read_catalog_publication(pg_temp.team(), pg_temp.owner(), pg_temp.catalog('videos'))->'targetObservation'->>'state',
 'available', 'the target reads as available');
select is(private.catalog_multi_creative_kind(pg_temp.catalog('videos')), 'videos', 'the catalog is one of several videos');

-- Due: the context waits for the copies, then names each segment's own.
update private.catalog_video_publication_policies set due_at=now()-interval '1 minute' where catalog_material_id=pg_temp.catalog('videos');
insert into seen select 'claim', public.service_claim_space_catalog_publication_jobs(pg_temp.worker(), 3)->'items';
select is(pg_temp.v('claim')->0->'job'->'target'->>'kind', 'creatives', 'the feed''s claim takes the due job with its target');
select is(pg_temp.context(pg_temp.catalog('videos'))->>'state', 'waiting', 'the context waits while a copy is not ready');
update private.catalog_video_r2_copies set state='ready', ready_at=now()
 where id in ((pg_temp.v('link1')->>'copyId')::uuid, (pg_temp.v('link2')->>'copyId')::uuid);
insert into seen select 'context', pg_temp.context(pg_temp.catalog('videos'));
select is(pg_temp.v('context')->>'state'||':'||(pg_temp.v('context')->>'creativeKind')||':'||(pg_temp.v('context')->>'productCount'),
 'ready:video:3', 'then it is ready, of videos, over every row');
select is((select jsonb_agg(jsonb_build_array(s->'rowStart', s->'rowCount', s->'sources'->0->'url') order by (s->>'ordinal')::int)
  from jsonb_array_elements(pg_temp.v('context')->'segments') s),
 jsonb_build_array(jsonb_build_array(0, 2, pg_temp.v('link1')->'url'), jsonb_build_array(2, 1, pg_temp.v('link2')->'url')),
 'each segment''s rows link its own video''s copy');
select is((select count(*)::integer from private.catalog_publication_link_receipts
  where job_id=(pg_temp.job(pg_temp.catalog('videos'))).id and link_kind='r2'), 2, 'a receipt r2 per creative');
select ok(pg_temp.publish(pg_temp.catalog('videos')), 'the generic lane publishes it');
select is((pg_temp.job(pg_temp.catalog('videos'))).state, 'published', 'the job is published');

-- 3. The manager's actions keep the target ---------------------------------------------------------
insert into seen select 'target', private.catalog_publication_target_json((pg_temp.policy(pg_temp.catalog('videos'))).target_id);
select lives_ok($$select public.service_save_catalog_publication(pg_temp.team(), pg_temp.owner(), gen_random_uuid(), pg_temp.catalog('videos'),
  (pg_temp.policy(pg_temp.catalog('videos'))).revision, 'held', null, null, pg_temp.v('target'))$$, 'a hold re-saves the same target');
select is((pg_temp.job(pg_temp.catalog('videos'))).state, 'held', 'and holds the link');
select lives_ok($$select public.service_save_catalog_publication(pg_temp.team(), pg_temp.owner(), gen_random_uuid(), pg_temp.catalog('videos'),
  (pg_temp.policy(pg_temp.catalog('videos'))).revision, 'scheduled', now()+interval '2 hours', 'Europe/Kyiv', pg_temp.v('target'))$$,
 'a reschedule too');
select is((pg_temp.job(pg_temp.catalog('videos'))).state||':'||(pg_temp.policy(pg_temp.catalog('videos'))).mode, 'waiting:scheduled',
 'and waits for its new time');
select lives_ok($$select public.service_save_catalog_publication(pg_temp.team(), pg_temp.owner(), gen_random_uuid(), pg_temp.catalog('videos'),
  (pg_temp.policy(pg_temp.catalog('videos'))).revision, 'immediate', null, null, pg_temp.v('target'))$$, '«add now» too');
select is((pg_temp.policy(pg_temp.catalog('videos'))).target_id::text, (select target_id::text from private.catalog_video_publication_jobs
  where catalog_material_id=pg_temp.catalog('videos') and revision=1), 'over the target it always had');
select throws_ok($$select public.service_save_catalog_publication(pg_temp.team(), pg_temp.owner(), gen_random_uuid(), pg_temp.catalog('videos'),
  (pg_temp.policy(pg_temp.catalog('videos'))).revision, 'held', null, null,
  jsonb_set(pg_temp.v('target'), '{segments,1,rowCount}', '2'))$$, 'INVALID_INPUT', 'another target cannot be invented');

-- 4. Growth stays refused ----------------------------------------------------------------------------
insert into seen select 'claim-now', public.service_claim_space_catalog_publication_jobs(pg_temp.worker(), 3);
insert into seen select 'context-now', pg_temp.context(pg_temp.catalog('videos'));
insert into seen select 'published-now', to_jsonb(pg_temp.publish(pg_temp.catalog('videos')));
insert into public.team_catalog_update_profiles(catalog_material_id,team_id,refresh_images,refresh_texts,grow_products,random_link_variation,restitch)
 values (pg_temp.catalog('videos'), pg_temp.team(), false, false, true, false, false)
 on conflict (catalog_material_id) do update set grow_products=true, restitch=false;
select set_config('request.jwt.claims', json_build_object('sub', pg_temp.owner(), 'role', 'authenticated')::text, true);
select set_config('request.jwt.claim.sub', pg_temp.owner()::text, true);
select lives_ok($$select public.run_team_catalog_update_now(pg_temp.team(), array[pg_temp.catalog('videos')])$$, 'a manager runs the update now');
select is((select count(*)::integer from public.service_claim_catalog_updater_items('growth', 5, 60) i where i.catalog_material_id=pg_temp.catalog('videos')), 1,
 'the updater claims the catalog');
select throws_ok($$select public.service_prepare_catalog_nonvideo_update_context(pg_temp.catalog('videos'), 'growth')$$,
 'MULTI_CREATIVE_UNSUPPORTED', 'and its growth is refused, as on Drive');

-- 5. Pictures published later -------------------------------------------------------------------------
insert into seen select 'intent2', to_jsonb(pg_temp.intent(2, 'image', false, jsonb_build_array(
  pg_temp.segment(0, pg_temp.file(6), 'image', null, '[]'), pg_temp.segment(1, pg_temp.file(7), 'image', null, '[]'))));
insert into seen select 'img6', public.service_reserve_space_creative_image(pg_temp.team(), pg_temp.owner(), pg_temp.file(6), repeat('6',64), gen_random_uuid());
insert into seen select 'img7', public.service_reserve_space_creative_image(pg_temp.team(), pg_temp.owner(), pg_temp.file(7), repeat('7',64), gen_random_uuid());
insert into seen select 'committed-'||n, public.service_commit_launch_creative_image((pg_temp.v(n)->>'id')::uuid,
  (select attempt_id from private.launch_creative_images where id=(pg_temp.v(n)->>'id')::uuid),
  'https://images.test/'||(pg_temp.v(n)->>'objectKey'), 'image/png', 2500)
from unnest(array['img6','img7']) n;
insert into seen select 'pictures', pg_temp.feed('catalog:pictures', pg_temp.file(6));
select is(public.service_link_space_catalog_feed(pg_temp.team(), pg_temp.file(6), pg_temp.catalog('pictures'), null,
  pg_temp.record(repeat('b',32), 'image', pg_temp.file(6), pg_temp.file(7),
    jsonb_build_object('spacePublicationKey','launch:'||pg_temp.id(11,2)||':catalog')), pg_temp.owner())->>'linked',
 'true', 'a picture catalog published later links');
select is((select jsonb_agg(g.kind||':'||g.source_version||':'||g.row_start||'+'||g.row_count order by g.ordinal)
  from private.catalog_publication_target_segments g where g.target_id=(pg_temp.policy(pg_temp.catalog('pictures'))).target_id),
 jsonb_build_array('image:space-v1:'||repeat('6',64)||':0+2', 'image:space-v1:'||repeat('7',64)||':2+1'),
 'its target names each picture by its content');
select is((select count(*)::integer from private.catalog_video_r2_copies where source_material_id in (pg_temp.file(6), pg_temp.file(7))), 0,
 'no video copy is planned for it');
update private.catalog_video_publication_policies set due_at=now()-interval '1 minute' where catalog_material_id=pg_temp.catalog('pictures');
insert into seen select 'claim-pictures', public.service_claim_space_catalog_publication_jobs(pg_temp.worker(), 3);
insert into seen select 'pictures-context', pg_temp.context(pg_temp.catalog('pictures'));
select is(pg_temp.v('pictures-context')->>'state'||':'||(pg_temp.v('pictures-context')->>'creativeKind'), 'ready:image',
 'its context is ready at once: the pictures were published with the catalog');
select is((select jsonb_agg(s->'sources'->0->>'url' order by (s->>'ordinal')::int) from jsonb_array_elements(pg_temp.v('pictures-context')->'segments') s),
 jsonb_build_array('https://images.test/'||(pg_temp.v('img6')->>'objectKey'), 'https://images.test/'||(pg_temp.v('img7')->>'objectKey')),
 'each segment links its own published picture');
select is((select count(*)::integer from private.catalog_video_r2_cell_sources((pg_temp.job(pg_temp.catalog('pictures'))).id)), 0,
 'the video copy lane sees nothing to reconcile in it');
update private.launch_creative_images set state='retiring', retire_after=now() where id=(pg_temp.v('img7')->>'id')::uuid;
select is(pg_temp.context(pg_temp.catalog('pictures'))->>'state', 'ready', 'a retiring picture is still its address');
insert into public.space_objects(id,team_id,content_id,byte_size,content_type,r2_key,state) values
 ('05791160-0000-4000-8000-000000000208',pg_temp.team(),repeat('8',64),5000,'image/png','t/'||pg_temp.team()||'/o/'||repeat('8',64),'committed');
update public.team_materials set space_object_id='05791160-0000-4000-8000-000000000208' where id=pg_temp.file(7);
select is(pg_temp.context(pg_temp.catalog('pictures')), jsonb_build_object('state','blocked','code','SOURCE_CHANGED'),
 'a picture whose content changed blocks the job');
update public.team_materials set space_object_id='05791160-0000-4000-8000-000000000207' where id=pg_temp.file(7);

-- 6. Two re-stitched videos published later ----------------------------------------------------------
insert into seen select 'settings', '{"configured":true}'::jsonb;
insert into seen select 'intent3', to_jsonb(pg_temp.intent(3, 'video', true, jsonb_build_array(
  pg_temp.segment(0, pg_temp.file(1), 'video', pg_temp.id(13,1), jsonb_build_array(pg_temp.id(14,1), pg_temp.id(14,2))),
  pg_temp.segment(1, pg_temp.file(2), 'video', pg_temp.id(13,2), jsonb_build_array(pg_temp.id(14,3))))));
insert into private.space_catalog_variant_sets(id,team_id,actor_id,catalog_intent_id,source_material_id,source_content_id,settings,settings_digest,variant_count)
values (pg_temp.id(13,1), pg_temp.team(), pg_temp.owner(), pg_temp.id(10,3), pg_temp.file(1), repeat('1',64), '{}', repeat('c',64), 2),
       (pg_temp.id(13,2), pg_temp.team(), pg_temp.owner(), pg_temp.id(10,3), pg_temp.file(2), repeat('2',64), '{}', repeat('c',64), 1);
insert into private.space_catalog_variants(set_id,ordinal,request_id,team_id,output_material_id)
values (pg_temp.id(13,1), 0, pg_temp.id(14,1), pg_temp.team(), pg_temp.file(3)),
       (pg_temp.id(13,1), 1, pg_temp.id(14,2), pg_temp.team(), pg_temp.file(4)),
       (pg_temp.id(13,2), 0, pg_temp.id(14,3), pg_temp.team(), pg_temp.file(5));
insert into seen select 'out'||n, public.service_space_catalog_video_link(pg_temp.team(), pg_temp.owner(), pg_temp.file(n)) from generate_series(3,5) n;
insert into seen select 'variations', pg_temp.feed('catalog:variations', pg_temp.file(1));
select is(public.service_link_space_catalog_feed(pg_temp.team(), pg_temp.file(1), pg_temp.catalog('variations'), null,
  pg_temp.record(repeat('c',32), 'video', pg_temp.file(1), pg_temp.file(2), jsonb_build_object(
    'spaceVariantSetIds', jsonb_build_array(pg_temp.id(13,1), pg_temp.id(13,2)),
    'spacePublicationKey', 'launch:'||pg_temp.id(11,3)||':catalog')), pg_temp.owner())->>'linked',
 'true', 'a catalog of two re-stitched videos published later links both sets');
select is((select jsonb_agg(jsonb_build_array(g.source_material_id, g.video_set_id, g.source_version) order by g.ordinal)
  from private.catalog_publication_target_segments g where g.target_id=(pg_temp.policy(pg_temp.catalog('variations'))).target_id),
 jsonb_build_array(jsonb_build_array(pg_temp.file(1), null, 'space-v1:'||repeat('1',64)), jsonb_build_array(pg_temp.file(2), null, 'space-v1:'||repeat('2',64))),
 'its segments name the videos by their content, the space sets by the catalog');
update private.catalog_video_publication_policies set due_at=now()-interval '1 minute' where catalog_material_id=pg_temp.catalog('variations');
insert into seen select 'claim-variations', public.service_claim_space_catalog_publication_jobs(pg_temp.worker(), 3);
update private.catalog_video_r2_copies set state='ready', ready_at=now() where source_material_id in (pg_temp.file(3), pg_temp.file(4), pg_temp.file(5));
insert into seen select 'variations-context', pg_temp.context(pg_temp.catalog('variations'));
select is((select jsonb_agg(jsonb_build_array(jsonb_array_length(s->'sources'), s->>'assignmentSeed', jsonb_array_length(s->'recipeRowIds')) order by (s->>'ordinal')::int)
  from jsonb_array_elements(pg_temp.v('variations-context')->'segments') s),
 jsonb_build_array(jsonb_build_array(2, repeat('a',64), 2), jsonb_build_array(1, repeat('b',64), 1)),
 'each video''s rows take its own variations, with its segment''s seed and rows');
select is(pg_temp.v('variations-context')->'segments'->1->'recipeRowIds', jsonb_build_array(pg_temp.id(12,33)),
 'the second video''s rows are its block of the plan');
select ok(not exists (select 1 from jsonb_array_elements(pg_temp.v('variations-context')->'sources') e
  where (e->>'materialId')::uuid in (pg_temp.file(1), pg_temp.file(2))), 'no original is linked');
update private.space_catalog_variant_sets set state='canceled' where id=pg_temp.id(13,2);
select is(pg_temp.context(pg_temp.catalog('variations')), jsonb_build_object('state','blocked'),
 'a set that is no longer ready blocks the job, never falling back to its original');
update private.space_catalog_variant_sets set state='ready' where id=pg_temp.id(13,2);

-- 7. Deleted for good ------------------------------------------------------------------------------
insert into seen select 'pictures-target', to_jsonb((pg_temp.policy(pg_temp.catalog('pictures'))).target_id);
update public.team_materials set lifecycle='trashed', trashed_at=now() where id=pg_temp.catalog('pictures');
select lives_ok($$delete from public.team_materials where id=pg_temp.catalog('pictures')$$, 'the picture catalog leaves for good');
select is((select count(*)::integer from private.catalog_publication_target_segments where target_id=(pg_temp.v('pictures-target')#>>'{}')::uuid)
  + (select count(*)::integer from private.catalog_publication_targets where id=(pg_temp.v('pictures-target')#>>'{}')::uuid), 0,
 'with its target and the target''s segments');
select ok(strpos(pg_get_functiondef('private.register_catalog_creatives_target(uuid,uuid,uuid,uuid,jsonb,integer,text,text)'::regprocedure),
 'private.catalog_publication_source_version(m.id, p_team)') > 0, 'the Drive registration of several creatives is unchanged');

select * from finish();
rollback;
