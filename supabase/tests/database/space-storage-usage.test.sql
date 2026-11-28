begin;
select plan(30);

-- 057 T052 (20261226360000): what an R2 space's storage holds, for the scale (US9, FR-045–FR-047,
-- FR-050, SC-013). The US9 fixture: materials (one of them copied, so its object is shared), three
-- catalogs of ten variations each with their feeds, one video copy two catalogs use, a library
-- picture, a pool picture, a task attachment and the trash. The segments sum to the ledger; what
-- is shared counts once; a catalog's breakdown says what it takes, what stays and what goes; the
-- library counts under catalogs as shared and the pool never counts as the space's bytes. A Drive
-- space is untouched.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05791360-0000-4000-8000-000000000001','authenticated','authenticated','usage-owner@test.invalid','{}','{}'),
 ('05791360-0000-4000-8000-000000000002','authenticated','authenticated','usage-stranger@test.invalid','{}','{}');
update public.profiles set display_name = 'Usage Owner' where id = '05791360-0000-4000-8000-000000000001';
insert into public.storage_r2_pilots(user_id,max_space_bytes) values
 ('05791360-0000-4000-8000-000000000001',100000),
 ('05791360-0000-4000-8000-000000000002',100000);

create temporary table seen(label text, value jsonb);
grant all on seen to authenticated;
create function pg_temp.owner() returns uuid language sql as $$ select '05791360-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.team() returns uuid language sql as $$ select (value->>'teamId')::uuid from seen where label='space' $$;
create function pg_temp.root() returns uuid language sql as $$ select (value->>'rootMaterialId')::uuid from seen where label='space' $$;
create function pg_temp.v(p_label text) returns jsonb language sql as $$ select value from seen where label=p_label order by ctid desc limit 1 $$;
create function pg_temp.id(p_label text) returns uuid language sql as $$ select (pg_temp.v(p_label)->>'id')::uuid $$;
create function pg_temp.upload(p_key text, p_content text, p_bytes bigint, p_name text, p_parent uuid default null)
returns jsonb language plpgsql as $$
declare v_session jsonb; v_upload uuid;
begin
  v_session := public.service_admit_space_upload(pg_temp.owner(), jsonb_build_object(
    'teamId', pg_temp.team(), 'parentMaterialId', coalesce(p_parent, pg_temp.root()), 'name', p_name,
    'contentType', 'video/mp4', 'bytes', p_bytes::text, 'contentId', p_content, 'sha256', null,
    'ingress', 'explorer', 'idempotencyKey', p_key,
    'category', 'video', 'classificationSource', 'mime', 'fileExtension', 'mp4'));
  v_upload := (v_session->>'uploadId')::uuid;
  perform public.service_attach_space_upload(v_upload, pg_temp.owner(), 'r2-upload-' || v_upload::text);
  perform public.service_mark_space_upload_completing(v_upload, pg_temp.team(), pg_temp.owner(), p_content, repeat('e',32)||'-1');
  return public.service_complete_space_upload(v_upload, pg_temp.team(), pg_temp.owner(),
    jsonb_build_object('category','video','classificationSource','mime','fileExtension','mp4'))
    || jsonb_build_object('uploadId', v_upload);
end $$;
-- A catalog of the space with its feed and ten variations (their outputs are files of the space).
create function pg_temp.catalog(p_label text, p_video uuid, p_feed text) returns void language plpgsql as $$
declare v_catalog uuid := gen_random_uuid(); v_set uuid := gen_random_uuid(); v_output jsonb; i integer;
begin
  insert into public.team_materials(id,team_id,parent_folder_id,name,kind,category,companion_of,companion_kind)
  values (v_catalog, pg_temp.team(), pg_temp.root()::text, 'Catalog '||p_label, 'file', 'other', p_video, 'product_catalog');
  insert into public.team_product_catalogs(material_id,team_id,source_link,product_count,sheet_url,video_link,settings_snapshot,created_by)
  values (v_catalog, pg_temp.team(), 'https://offer.test/?s=1', 3,
    'https://catalog-videos-beta.soty.pp.ua/feeds/'||p_feed||'.csv', 'https://catalog-videos-beta.soty.pp.ua/v/x.mp4', '{}', pg_temp.owner());
  perform public.service_record_catalog_feed(v_catalog, p_feed, 100, 0);
  insert into private.space_catalog_variant_sets(id,team_id,actor_id,source_content_id,settings,settings_digest,variant_count,state,catalog_material_id)
  values (v_set, pg_temp.team(), pg_temp.owner(), repeat('a',64), '{}', repeat('d',64), 10, 'ready', v_catalog);
  for i in 0..9 loop
    v_output := pg_temp.upload('variant-key-'||p_label||'-'||i||'-00000', lpad(to_hex(i), 32, '0')||p_feed, 10, p_label||' variation '||i||'.mp4');
    insert into private.space_catalog_variants(set_id,ordinal,request_id,team_id,output_material_id)
    values (v_set, i, gen_random_uuid(), pg_temp.team(), (v_output->>'id')::uuid);
    perform private.space_material_ref_sync((v_output->>'id')::uuid);
  end loop;
  insert into seen values (p_label, jsonb_build_object('id', v_catalog));
end $$;
create function pg_temp.segment(p_category text) returns text language sql as $$
  select s->>'bytes'||'/'||(s->>'sharedBytes')
  from jsonb_array_elements(pg_temp.v('summary')->'segments') as e(s) where s->>'category' = p_category $$;
create function pg_temp.as_owner() returns void language sql as $$
  select set_config('request.jwt.claim.sub','05791360-0000-4000-8000-000000000001',true) $$;

-- The fixture -------------------------------------------------------------------------------------
insert into seen select 'space', public.service_create_r2_space(pg_temp.owner(),'Usage space','usage-space-key-001');
insert into seen select 'a', pg_temp.upload('usage-a-key-00001', repeat('1',64), 1000, 'Clip A.mp4');
insert into seen select 'b', pg_temp.upload('usage-b-key-00001', repeat('2',64), 2000, 'Clip B.mp4');
insert into seen select 'f', pg_temp.upload('usage-f-key-00001', repeat('6',64), 500, 'Clip F.mp4');
-- A copy refers to the same object: the bytes count once, and as shared.
insert into seen select 'copy', public.service_mutate_space_materials(pg_temp.owner(), pg_temp.team(),
  jsonb_build_object('action','copy','materialIds',jsonb_build_array(pg_temp.id('a'))))->'materials'->0;
insert into seen select 'c', pg_temp.upload('usage-c-key-00001', repeat('3',64), 300, 'Clip C.mp4');
select public.service_mutate_space_materials(pg_temp.owner(), pg_temp.team(),
  jsonb_build_object('action','trash','materialIds',jsonb_build_array(pg_temp.id('c'))));
-- A file a task upload brought in counts as an attachment.
with t as (insert into public.team_tasks(team_id,created_by,title) values (pg_temp.team(),pg_temp.owner(),'Brief') returning id)
insert into seen select 'task', jsonb_build_object('id', id) from t;
set local role authenticated;
select pg_temp.as_owner();
select public.begin_task_upload(pg_temp.team(), pg_temp.id('task'), 'usage-d-key-00001');
reset role;
insert into seen select 'd', pg_temp.upload('usage-d-key-00001', repeat('4',64), 400, 'Brief.mp4');

select pg_temp.catalog('one', pg_temp.id('a'), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
select pg_temp.catalog('two', pg_temp.id('b'), 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
select pg_temp.catalog('three', pg_temp.id('f'), 'cccccccccccccccccccccccccccccccc');
-- One public copy of a video, used by catalogs one and two (050, counted by T111).
insert into private.catalog_video_r2_copies(id,team_id,source_material_id,source_version,size_bytes,part_bytes)
values ('05791360-0000-4000-8000-0000000000c1', pg_temp.team(), pg_temp.id('a'), 'space-v1:'||repeat('1',64), 700, 5242880);
update private.catalog_video_r2_copies set state='ready', ready_at=now() where id='05791360-0000-4000-8000-0000000000c1';
insert into private.catalog_video_r2_uses(catalog_material_id,source_material_id,copy_id,team_id) values
 (pg_temp.id('one'), pg_temp.id('a'), '05791360-0000-4000-8000-0000000000c1', pg_temp.team()),
 (pg_temp.id('two'), pg_temp.id('a'), '05791360-0000-4000-8000-0000000000c1', pg_temp.team());

-- 1. The library ----------------------------------------------------------------------------------
delete from public.team_space_storage_signals where team_id = pg_temp.team();
insert into private.catalog_image_storage(publication_id,object_key,team_scope,owner_scope,size_bytes)
values ('05791360-0000-4000-8000-0000000000e1','v1/usage-library-1',pg_temp.team(),pg_temp.owner(),500);
select is((select bytes||'/'||shared_bytes from public.space_storage_usage where team_id=pg_temp.team() and category='catalogs'),
 '1800/500', 'a library picture counts under catalogs, as shared (feeds 300 + variations 300 + copy 700 + picture 500)');
select is((select count(*)::integer from public.team_space_storage_signals where team_id=pg_temp.team() and kind='usage'), 1,
 'a ledger change says so on the space''s channel');
insert into private.catalog_image_storage(publication_id,object_key,team_scope,owner_scope,size_bytes)
values ('05791360-0000-4000-8000-0000000000e2','v1/usage-library-2',pg_temp.team(),pg_temp.owner(),50);
select is((select count(*)::integer from public.team_space_storage_signals where team_id=pg_temp.team() and kind='usage'), 1,
 'once per transaction, however many changes');
update private.catalog_image_storage set charged=false, released_at=now() where publication_id='05791360-0000-4000-8000-0000000000e2';
select is((select bytes||'/'||shared_bytes from public.space_storage_usage where team_id=pg_temp.team() and category='catalogs'),
 '1800/500', 'a picture purged from the library gives its bytes back');

-- A pool picture shown by catalog one: platform bytes, never the space's.
insert into private.catalog_global_images(id,environment,canonical_key,sha256,mime,size_bytes,width,height,classification,state)
values ('05791360-0000-4000-8000-0000000000f1','beta','g1/05791360-0000-4000-8000-0000000000f1',repeat('f',64),'image/jpeg',800,1000,1000,
  '{"vocabularyVersion":"catalog-clothing-v1","mode":"unclassified","garment":null,"color":null,"reason":"missing"}','ready');
insert into private.catalog_global_aliases(id,image_id,generation,public_url,key_version,state)
values ('05791360-0000-4000-8000-0000000000f2','05791360-0000-4000-8000-0000000000f1',1,'https://pool.test/g/usage1.jpg',1,'ready');
insert into private.catalog_global_identities(id,team_id,actor_id,creation_intent,material_id)
values ('05791360-0000-4000-8000-0000000000f3',pg_temp.team(),pg_temp.owner(),gen_random_uuid(),pg_temp.id('one'));
insert into private.catalog_global_assignments(catalog_id,image_id,alias_id,issued_slot,generation,state)
values ('05791360-0000-4000-8000-0000000000f3','05791360-0000-4000-8000-0000000000f1','05791360-0000-4000-8000-0000000000f2',1,1,'confirmed');

-- 2. The summary ----------------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_owner();
insert into seen select 'summary', public.get_space_storage_summary(pg_temp.team());
reset role;
select is(pg_temp.segment('materials'), '3500/1000', 'materials: three clips, the copied one shared and counted once');
select is(pg_temp.segment('catalogs'), '1800/500', 'catalogs: feeds, variations, the one copy and the library');
select is(pg_temp.segment('attachments'), '400/0', 'attachments: what the task brought in');
select is(pg_temp.segment('trash'), '300/0', 'trash');
select is(pg_temp.segment('process') || ' ' || pg_temp.segment('versions'), '0/0 0/0', 'empty categories are segments of zero');
select is((select sum((s->>'bytes')::bigint) from jsonb_array_elements(pg_temp.v('summary')->'segments') as e(s))::text,
 pg_temp.v('summary')->>'usedBytes', 'the segments sum to usedBytes');
select is(pg_temp.v('summary')->>'usedBytes', private.space_used_bytes(pg_temp.team())::text,
 'usedBytes is the number admission checks against');
select is(pg_temp.v('summary')->>'usedBytes', '6000', 'and to the byte what the fixture holds');
select is(pg_temp.v('summary')->>'capacityBytes', '100000', 'capacity is the pilot''s');
select is(pg_temp.v('summary')->>'poolBytes', '800', 'the pool picture is shown beside, never added');
select is((select array_agg(s->>'category' order by ordinality) from jsonb_array_elements(pg_temp.v('summary')->'segments') with ordinality as e(s, ordinality)),
 array['materials','catalogs','process','attachments','versions','trash'], 'the six segments, always in the same order');

-- 3. A catalog's three numbers --------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_owner();
insert into seen select 'b1', public.get_catalog_storage_breakdown(pg_temp.id('one'));
insert into seen select 'b3', public.get_catalog_storage_breakdown(pg_temp.id('three'));
reset role;
select is(pg_temp.v('b1')->>'totalBytes', '1700', 'catalog one takes its feed, the copy, ten variations and the pool picture');
select is(pg_temp.v('b1')->>'sharedBytes', '1500', 'the copy (catalog two uses it too) and the pool picture stay');
select is(pg_temp.v('b1')->>'freedBytes', '200', 'deleting it frees exactly its feed and its variations');
select is((select p->>'sharedBytes' from jsonb_array_elements(pg_temp.v('b1')->'parts') as e(p) where p->>'kind'='pool'), '800',
 'a pool picture is marked shared');
select is(pg_temp.v('b3')->>'totalBytes' || '/' || (pg_temp.v('b3')->>'sharedBytes') || '/' || (pg_temp.v('b3')->>'freedBytes'),
 '200/0/200', 'a catalog nobody shares with frees all it takes');

-- 4. The list ---------------------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_owner();
insert into seen select 'materials', public.list_space_storage_items(pg_temp.team(), 'materials', 'size', null, null, 2);
insert into seen select 'materials2', public.list_space_storage_items(pg_temp.team(), 'materials', 'size', null, '2', 2);
insert into seen select 'search', public.list_space_storage_items(pg_temp.team(), 'materials', 'date', 'clip b', null, 50);
insert into seen select 'catalogs', public.list_space_storage_items(pg_temp.team(), 'catalogs', 'size', null, null, 50);
insert into seen select 'author', public.list_space_storage_items(pg_temp.team(), 'materials', 'author', null, null, 50);
reset role;
select is((select array_agg(i->>'name' order by o) from jsonb_array_elements(pg_temp.v('materials')->'items') with ordinality x(i, o)),
 array['Clip B.mp4','Clip A.mp4'], 'biggest first, a shared object listed once');
select is(pg_temp.v('materials')->>'nextCursor' || ' ' || (pg_temp.v('materials')->>'total'), '2 3', 'a page says where the next begins');
select is((select array_agg(i->>'name') from jsonb_array_elements(pg_temp.v('materials2')->'items') as e(i)), array['Clip F.mp4'],
 'and the next page holds the rest');
select is((select array_agg(i->>'name') from jsonb_array_elements(pg_temp.v('search')->'items') as e(i)), array['Clip B.mp4'],
 'search finds by name, in any case');
select is((select array_agg(i->>'kind' || ':' || coalesce(i->>'name','') || ':' || (i->>'bytes') order by o)
  from jsonb_array_elements(pg_temp.v('catalogs')->'items') with ordinality x(i, o)),
 array['catalog:Catalog one:1700','catalog:Catalog two:900','library::500','catalog:Catalog three:200'],
 'catalogs are listed whole, beside the library');
select is((select i->>'authorName' from jsonb_array_elements(pg_temp.v('author')->'items') as e(i) limit 1), 'Usage Owner',
 'each thing names who added it');

-- 5. Who may read -----------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub','05791360-0000-4000-8000-000000000002',true);
select throws_ok($$select public.get_space_storage_summary(pg_temp.team())$$, 'PERMISSION_DENIED',
 'someone outside the space reads nothing');
reset role;

-- The copy trigger (T111) moves the same segment: a deleted copy leaves catalogs.
update private.catalog_video_r2_copies set state='deleted', deleted_at=now() where id='05791360-0000-4000-8000-0000000000c1';
select is((select bytes||'/'||shared_bytes from public.space_storage_usage where team_id=pg_temp.team() and category='catalogs'),
 '1100/500', 'a catalog video copy deleted gives its bytes back under catalogs');

-- 6. A Drive space ----------------------------------------------------------------------------------
insert into public.teams(id,name,owner_id) values ('05791360-0000-4000-8000-0000000000d1','Usage Drive',pg_temp.owner());
insert into private.catalog_image_storage(publication_id,object_key,team_scope,owner_scope,size_bytes)
values ('05791360-0000-4000-8000-0000000000e3','v1/usage-drive-1','05791360-0000-4000-8000-0000000000d1',pg_temp.owner(),500);
select ok(not exists(select 1 from public.space_storage_usage where team_id='05791360-0000-4000-8000-0000000000d1')
  and not exists(select 1 from public.team_space_storage_signals where team_id='05791360-0000-4000-8000-0000000000d1'),
 'a Drive space''s library picture writes neither a ledger row nor a signal');
set local role authenticated;
select pg_temp.as_owner();
select throws_ok($$select public.get_space_storage_summary('05791360-0000-4000-8000-0000000000d1')$$, 'STORAGE_BACKEND_MISMATCH',
 'a Drive space has no such scale');
reset role;

select * from finish();
rollback;
