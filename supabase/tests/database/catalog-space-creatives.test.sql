begin;
select plan(30);

-- 057 T103 (20261226310000): a Launch's catalog in an R2 space — several videos or pictures.
-- A picture creative is reserved by its content id, counted in the space's `catalogs` once it is
-- published and given back when it is purged; a catalog of several videos uses every copy; a
-- picture catalog plans no video copy; a Launch's source is named by its content and carries no
-- Drive file id; attaching an R2 catalog needs no Drive read-back. Drive answers as before.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05791040-0000-4000-8000-000000000001','authenticated','authenticated','creatives-owner@test.invalid','{}','{}');
insert into public.storage_r2_pilots(user_id,max_space_bytes) values ('05791040-0000-4000-8000-000000000001',20000000);
insert into public.teams(id,name,owner_id,storage_backend,storage_pilot) values
 ('05791040-0000-4000-8000-000000000011','Creatives R2','05791040-0000-4000-8000-000000000001','r2',true);
insert into public.teams(id,name,owner_id) values
 ('05791040-0000-4000-8000-000000000012','Creatives Drive','05791040-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('05791040-0000-4000-8000-000000000011','05791040-0000-4000-8000-000000000001','admin'),
 ('05791040-0000-4000-8000-000000000012','05791040-0000-4000-8000-000000000001','admin')
 on conflict do nothing;
insert into public.team_materials(id,team_id,name,kind) values
 ('05791040-0000-4000-8000-000000000101','05791040-0000-4000-8000-000000000011','Creatives R2','folder');
update public.teams set storage_root_material_id='05791040-0000-4000-8000-000000000101'
 where id='05791040-0000-4000-8000-000000000011';
insert into public.space_objects(id,team_id,content_id,byte_size,content_type,r2_key,state) values
 ('05791040-0000-4000-8000-000000000201','05791040-0000-4000-8000-000000000011',repeat('1',64),5000,'video/mp4',
  't/05791040-0000-4000-8000-000000000011/o/'||repeat('1',64),'committed'),
 ('05791040-0000-4000-8000-000000000202','05791040-0000-4000-8000-000000000011',repeat('2',64),6000,'video/mp4',
  't/05791040-0000-4000-8000-000000000011/o/'||repeat('2',64),'committed'),
 ('05791040-0000-4000-8000-000000000203','05791040-0000-4000-8000-000000000011',repeat('3',64),3000,'image/png',
  't/05791040-0000-4000-8000-000000000011/o/'||repeat('3',64),'committed');
insert into public.team_materials(id,team_id,parent_folder_id,name,kind,category,mime_type,space_object_id,size_bytes) values
 ('05791040-0000-4000-8000-000000000103','05791040-0000-4000-8000-000000000011','05791040-0000-4000-8000-000000000101',
  'first.mp4','file','video','video/mp4','05791040-0000-4000-8000-000000000201',5000),
 ('05791040-0000-4000-8000-000000000104','05791040-0000-4000-8000-000000000011','05791040-0000-4000-8000-000000000101',
  'second.mp4','file','video','video/mp4','05791040-0000-4000-8000-000000000202',6000),
 ('05791040-0000-4000-8000-000000000105','05791040-0000-4000-8000-000000000011','05791040-0000-4000-8000-000000000101',
  'cover.png','file','image','image/png','05791040-0000-4000-8000-000000000203',3000);
update private.catalog_video_r2_config set enabled=true, public_origin='https://videos.test', policy_confirmed_at=now();

create temporary table seen(label text, value jsonb);
create function pg_temp.v(p_label text) returns jsonb language sql as $$ select value from seen where label=p_label order by ctid desc limit 1 $$;
create function pg_temp.team() returns uuid language sql as $$ select '05791040-0000-4000-8000-000000000011'::uuid $$;
create function pg_temp.drive_team() returns uuid language sql as $$ select '05791040-0000-4000-8000-000000000012'::uuid $$;
create function pg_temp.owner() returns uuid language sql as $$ select '05791040-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.first() returns uuid language sql as $$ select '05791040-0000-4000-8000-000000000103'::uuid $$;
create function pg_temp.second() returns uuid language sql as $$ select '05791040-0000-4000-8000-000000000104'::uuid $$;
create function pg_temp.cover() returns uuid language sql as $$ select '05791040-0000-4000-8000-000000000105'::uuid $$;
create function pg_temp.used() returns bigint language sql as $$
  select coalesce((select bytes from public.space_storage_usage where team_id=pg_temp.team() and category='catalogs'),0) $$;
create function pg_temp.image(p_id uuid) returns private.launch_creative_images language sql as $$
  select * from private.launch_creative_images where id=p_id $$;

-- 1. A picture creative is reserved by its content ---------------------------------------------
select throws_ok($$select public.service_reserve_space_creative_image(pg_temp.drive_team(), pg_temp.owner(), pg_temp.cover(), repeat('3',64), gen_random_uuid())$$,
 'STORAGE_BACKEND_MISMATCH', 'a Drive space reserves by its Drive version, not here');
select throws_ok($$select public.service_reserve_space_creative_image(pg_temp.team(), pg_temp.owner(), pg_temp.cover(), repeat('4',64), gen_random_uuid())$$,
 'SOURCE_CHANGED', 'another content than the file holds is refused');
select throws_ok($$select public.service_reserve_space_creative_image(pg_temp.team(), pg_temp.owner(), pg_temp.first(), repeat('1',64), gen_random_uuid())$$,
 'SOURCE_CHANGED', 'so is a file that is not a picture');
select throws_ok($$select public.service_reserve_space_creative_image(pg_temp.team(), gen_random_uuid(), pg_temp.cover(), repeat('3',64), gen_random_uuid())$$,
 'PERMISSION_DENIED', 'and a stranger');
insert into seen select 'attempt', to_jsonb(gen_random_uuid());
insert into seen select 'reserved', public.service_reserve_space_creative_image(pg_temp.team(), pg_temp.owner(), pg_temp.cover(), repeat('3',64),
  (pg_temp.v('attempt')#>>'{}')::uuid);
select is(pg_temp.v('reserved')->>'state', 'reserved', 'a new picture is reserved');
select ok(pg_temp.v('reserved')->>'objectKey' ~ '^c1/[0-9a-f-]{36}$', 'under a c1/ key');
select is((pg_temp.image((pg_temp.v('reserved')->>'id')::uuid)).source_version||':'||(pg_temp.image((pg_temp.v('reserved')->>'id')::uuid)).source_checksum,
 'space-v1:'||repeat('3',64)||':'||repeat('3',32), 'named by the space content');
select is(public.service_reserve_space_creative_image(pg_temp.team(), pg_temp.owner(), pg_temp.cover(), repeat('3',64), gen_random_uuid())->>'id',
 pg_temp.v('reserved')->>'id', 'a lost attempt hands the same reservation on');
select is(pg_temp.used(), 0::bigint, 'a reservation is not counted yet');

-- 2. Published, it counts once; purged, it is given back ---------------------------------------
insert into seen select 'committed', public.service_commit_launch_creative_image((pg_temp.v('reserved')->>'id')::uuid,
  (pg_temp.image((pg_temp.v('reserved')->>'id')::uuid)).attempt_id,
  'https://images.test/'||(pg_temp.v('reserved')->>'objectKey'), 'image/png', 2500);
select is(pg_temp.v('committed')->>'state', 'ready', 'the published picture is ready');
select is(pg_temp.used(), 2500::bigint, 'and counts in the space''s catalogs');
select is(public.service_reserve_space_creative_image(pg_temp.team(), pg_temp.owner(), pg_temp.cover(), repeat('3',64), gen_random_uuid())->>'url',
 'https://images.test/'||(pg_temp.v('reserved')->>'objectKey'), 'the same content reuses the published picture');
update private.launch_creative_images set state='ready' where id=(pg_temp.v('reserved')->>'id')::uuid;
select is(pg_temp.used(), 2500::bigint, 'counted once whatever its state does');
update private.launch_creative_images set state='retiring', retire_after=now(), sweep_lease_until=now()+interval '5 minutes'
 where id=(pg_temp.v('reserved')->>'id')::uuid;
select lives_ok($$select public.service_mark_launch_creative_image_purged((pg_temp.v('reserved')->>'id')::uuid)$$, 'the swept picture is purged');
select is(pg_temp.used(), 0::bigint, 'and its bytes come back');
update public.storage_r2_pilots set max_space_bytes=1000 where user_id=pg_temp.owner();
select throws_ok($$select public.service_reserve_space_creative_image(pg_temp.team(), pg_temp.owner(), pg_temp.cover(), repeat('3',64), gen_random_uuid())$$,
 'STORAGE_QUOTA_EXCEEDED', 'a space without room for the picture is refused before anything is written');
update public.storage_r2_pilots set max_space_bytes=20000000 where user_id=pg_temp.owner();
select ok(strpos(pg_get_functiondef('public.service_reserve_launch_creative_image(uuid,uuid,text,text,uuid)'::regprocedure),
 'm.drive_version = p_version and lower(m.checksum) = lower(p_checksum)') > 0, 'the Drive reservation is unchanged');

-- 3. The link uses every creative's copy -------------------------------------------------------
insert into seen select 'link1', public.service_space_catalog_video_link(pg_temp.team(), pg_temp.owner(), pg_temp.first());
insert into seen select 'link2', public.service_space_catalog_video_link(pg_temp.team(), pg_temp.owner(), pg_temp.second());
create temporary table ops(operation_id uuid, state text, reused boolean);
create function pg_temp.feed(p_key text, p_video uuid) returns uuid language plpgsql as $$
declare op uuid;
begin
  select operation_id into op from public.service_start_team_operation(pg_temp.team(),pg_temp.owner(),'upload',p_key,p_key,p_video,
    '05791040-0000-4000-8000-000000000101',p_key,now()+interval '1 hour',null);
  return (public.service_commit_space_catalog_feed(op,pg_temp.owner(),p_key,2048)->>'materialId')::uuid;
end $$;
create function pg_temp.record(p_feed text, p_kind text, p_creatives jsonb) returns jsonb language sql as $$
  select jsonb_build_object('sourceLink','https://offer.test/?s=1','productCount',3,
    'sheetUrl','https://catalog-videos-beta.soty.pp.ua/feeds/'||p_feed||'.csv',
    'videoLink',case when p_kind='image' then null else pg_temp.v('link1')->>'url' end,
    'settingsSnapshot',jsonb_build_object('_catalogCreativeKind',p_kind,'_catalogCreatives',p_creatives,'_catalogRowCreatives','[0,0,1]'::jsonb),
    'createdBy',pg_temp.owner(),'variant',1,'feedId',p_feed,'feedBytes',2048) $$;
insert into seen select 'videos', to_jsonb(pg_temp.feed('catalog:creatives-videos', pg_temp.first()));
insert into seen select 'linked', public.service_link_space_catalog_feed(pg_temp.team(), pg_temp.first(), (pg_temp.v('videos')#>>'{}')::uuid, null,
  pg_temp.record(repeat('b',32), 'video', jsonb_build_array(
    jsonb_build_object('ordinal',0,'materialId',pg_temp.first(),'alias','a','kind','video','link',pg_temp.v('link1')->>'url','linkKind','r2'),
    jsonb_build_object('ordinal',1,'materialId',pg_temp.second(),'alias','b','kind','video','link',pg_temp.v('link2')->>'url','linkKind','r2'))),
  pg_temp.owner());
select is(pg_temp.v('linked')->>'linked', 'true', 'a catalog of two videos links');
select is((select array_agg(source_material_id order by source_material_id)::text from private.catalog_video_r2_uses
  where catalog_material_id=(pg_temp.v('videos')#>>'{}')::uuid), array[pg_temp.first(), pg_temp.second()]::text,
 'and uses the copy of each video');
select is((select array_agg(copy_id order by source_material_id)::text from private.catalog_video_r2_uses
  where catalog_material_id=(pg_temp.v('videos')#>>'{}')::uuid),
 array[(pg_temp.v('link1')->>'copyId')::uuid, (pg_temp.v('link2')->>'copyId')::uuid]::text, 'the copies its feed names');
update private.catalog_video_r2_copies set state='failed' where id=(pg_temp.v('link2')->>'copyId')::uuid;
insert into seen select 'lost', to_jsonb(pg_temp.feed('catalog:creatives-lost', pg_temp.first()));
select throws_ok($$select public.service_link_space_catalog_feed(pg_temp.team(), pg_temp.first(), (pg_temp.v('lost')#>>'{}')::uuid, null,
  pg_temp.record(repeat('c',32), 'video', jsonb_build_array(
    jsonb_build_object('ordinal',0,'materialId',pg_temp.first(),'alias','a','kind','video'),
    jsonb_build_object('ordinal',1,'materialId',pg_temp.second(),'alias','b','kind','video'))), pg_temp.owner())$$,
 'VIDEO_R2_SOURCE_UNAVAILABLE', 'a video whose copy is gone refuses the link: the feed would name a dead address');

insert into seen select 'pictures', to_jsonb(pg_temp.feed('catalog:creatives-pictures', pg_temp.cover()));
select is(public.service_link_space_catalog_feed(pg_temp.team(), pg_temp.cover(), (pg_temp.v('pictures')#>>'{}')::uuid, null,
  pg_temp.record(repeat('d',32), 'image', jsonb_build_array(
    jsonb_build_object('ordinal',0,'materialId',pg_temp.cover(),'alias','a','kind','image','link','https://images.test/c1/x','linkKind','r2'))),
  pg_temp.owner())->>'linked', 'true', 'a picture catalog links');
select is((select count(*)::integer from private.catalog_video_r2_uses where catalog_material_id=(pg_temp.v('pictures')#>>'{}')::uuid)
  + (select count(*)::integer from private.catalog_video_r2_copies where source_material_id=pg_temp.cover()), 0,
 'without any video copy used or planned');

-- 4. A Launch's source in an R2 space ------------------------------------------------------------
insert into public.team_accounts(id,team_id,created_by,name) values
 ('05791040-0000-4000-8000-000000000301',pg_temp.team(),pg_temp.owner(),'g1');
insert into public.team_account_agents(id,team_id,account_id,created_by,agent_id) values
 ('05791040-0000-4000-8000-000000000302',pg_temp.team(),'05791040-0000-4000-8000-000000000301',pg_temp.owner(),'1234567892');
insert into public.team_launch_offers(id,team_id,name,normalized_key,created_by) values
 ('05791040-0000-4000-8000-000000000303',pg_temp.team(),'Offer','offer',pg_temp.owner());
insert into public.team_launch_buyers(id,team_id,value,normalized_key,created_by) values
 ('05791040-0000-4000-8000-000000000304',pg_temp.team(),'buyer','buyer',pg_temp.owner());
insert into seen select 'sources', private.launch_sources_from_config(pg_temp.team(), jsonb_build_object(
  'agentRowId','05791040-0000-4000-8000-000000000302','offerId','05791040-0000-4000-8000-000000000303',
  'buyerId','05791040-0000-4000-8000-000000000304','materialId',pg_temp.first(),'method','catalog',
  'catalog',jsonb_build_object('productCount',3,'restitchEnabled',false),
  'creativeKind','video','creatives',jsonb_build_array(
    jsonb_build_object('materialId',pg_temp.first(),'alias','a','copies',2),
    jsonb_build_object('materialId',pg_temp.second(),'alias','b','copies',1))), pg_temp.owner());
select is(pg_temp.v('sources')->>'materialVersion', 'space-v1:'||repeat('1',64), 'a Launch names its R2 source by its content');
select ok(not (pg_temp.v('sources') ? 'materialDriveFileId'), 'and no Drive file id');
select is(pg_temp.v('sources')->'materials'->1->>'version', 'space-v1:'||repeat('2',64), 'every creative likewise');
select ok(not (pg_temp.v('sources')->'materials'->1 ? 'driveFileId'), 'without a Drive file id');
select ok(private.launch_material_identity(pg_temp.v('sources')) is not null, 'so the source has an identity to compare');
select ok(strpos(pg_get_functiondef('private.launch_sources_from_config(uuid,jsonb,uuid)'::regprocedure),
 $s$'materialDriveFileId',m.drive_file_id$s$) > 0, 'a Drive source keeps its Drive file id');

-- 5. Attaching an R2 catalog ---------------------------------------------------------------------
select ok(strpos(pg_get_functiondef('public.service_attach_launch_catalog_before_catalog_sub(uuid,uuid,uuid,text,text)'::regprocedure),
 'or (not private.space_is_r2(p_team) and not exists(select 1 from private.catalog_initial_publication_checks b') > 0,
 'a Drive catalog still needs its verified publication read-back to attach; an R2 feed does not');

select * from finish();
rollback;
