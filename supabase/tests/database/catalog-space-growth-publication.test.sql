begin;
select plan(14);

-- 057 T103: a catalog of an R2 space whose video link has a publication policy grows by a product.
-- The round is the Drive one (claim, non-video context, non-video write, completion); the policy
-- moves to a new revision over the same target, its new job is the feed's to claim, and the feed's
-- context then names the grown catalog, so the publication writes the added row's link too.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05791030-0000-4000-8000-000000000001','authenticated','authenticated','growth-owner@test.invalid','{}','{}');
insert into public.storage_r2_pilots(user_id,max_space_bytes) values ('05791030-0000-4000-8000-000000000001',1000000000);
insert into public.teams(id,name,owner_id,storage_backend,storage_pilot) values
 ('05791030-0000-4000-8000-000000000011','Growth R2','05791030-0000-4000-8000-000000000001','r2',true);
insert into public.team_members(team_id,user_id,base_role) values
 ('05791030-0000-4000-8000-000000000011','05791030-0000-4000-8000-000000000001','admin')
 on conflict do nothing;
insert into public.team_materials(id,team_id,name,kind) values
 ('05791030-0000-4000-8000-000000000101','05791030-0000-4000-8000-000000000011','Growth R2','folder');
update public.teams set storage_root_material_id='05791030-0000-4000-8000-000000000101'
 where id='05791030-0000-4000-8000-000000000011';
insert into public.space_objects(id,team_id,content_id,byte_size,content_type,r2_key,state) values
 ('05791030-0000-4000-8000-000000000201','05791030-0000-4000-8000-000000000011',repeat('5',64),5000,'video/mp4',
  't/05791030-0000-4000-8000-000000000011/o/'||repeat('5',64),'committed');
insert into public.team_materials(id,team_id,parent_folder_id,name,kind,category,mime_type,space_object_id,size_bytes) values
 ('05791030-0000-4000-8000-000000000103','05791030-0000-4000-8000-000000000011',
  '05791030-0000-4000-8000-000000000101','clip.mp4','file','video','video/mp4','05791030-0000-4000-8000-000000000201',5000);
update private.catalog_video_r2_config set enabled=true, public_origin='https://videos.test', policy_confirmed_at=now();

create temporary table seen(label text, value jsonb);
create function pg_temp.v(p_label text) returns jsonb language sql as $$ select value from seen where label=p_label order by ctid desc limit 1 $$;
create function pg_temp.team() returns uuid language sql as $$ select '05791030-0000-4000-8000-000000000011'::uuid $$;
create function pg_temp.owner() returns uuid language sql as $$ select '05791030-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.video() returns uuid language sql as $$ select '05791030-0000-4000-8000-000000000103'::uuid $$;
create function pg_temp.worker() returns uuid language sql as $$ select '05791030-0000-4000-8000-0000000000f1'::uuid $$;
create function pg_temp.catalog() returns uuid language sql as $$ select (pg_temp.v('commit')->>'materialId')::uuid $$;
create function pg_temp.job() returns private.catalog_video_publication_jobs language sql as $$
  select * from private.catalog_video_publication_jobs where catalog_material_id=pg_temp.catalog() order by revision desc limit 1 $$;
create function pg_temp.policy() returns private.catalog_video_publication_policies language sql as $$
  select * from private.catalog_video_publication_policies where catalog_material_id=pg_temp.catalog() $$;
create function pg_temp.publish() returns boolean language plpgsql as $$
declare fence uuid;
begin
  perform public.service_claim_space_catalog_publication_jobs(pg_temp.worker(), 3);
  perform public.service_space_catalog_publication_context((pg_temp.job()).id, pg_temp.worker());
  fence := public.service_reserve_catalog_publication((pg_temp.job()).id, pg_temp.worker());
  perform public.service_dispatch_catalog_publication((pg_temp.job()).id, pg_temp.worker(), fence);
  return public.service_settle_catalog_publication((pg_temp.job()).id, pg_temp.worker(), fence, 'verified', '"etag"');
end $$;

-- A creation whose link was scheduled, then published: the catalog keeps its policy.
insert into seen select 'publication', jsonb_build_object('mode','scheduled','localDateTime','2026-12-01T10:00',
  'timeZone','Europe/Kyiv','resolvedOffset','+02:00',
  'dueAt',to_char((now() + interval '1 day') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
insert into private.catalog_generation_intents(id,team_id,video_material_id,actor_id,request_key,request_digest,request_payload,checkpoint,variant,state) values
 ('05791030-0000-4000-8000-0000000000a1',pg_temp.team(),pg_temp.video(),pg_temp.owner(),
  'product-catalog:05791030-0000-4000-8000-0000000000a1','d1',
  jsonb_build_object('catalogVideoProtocolVersion',1,'restitchEnabled',false,'videoVariationCount',1,'videoPublication',pg_temp.v('publication')),
  jsonb_build_object('initialVideoPlan',jsonb_build_object('acceptedAt',floor(extract(epoch from now())*1000),
    'preferences',jsonb_build_object('catalogVideoProtocolVersion',1,'restitchEnabled',false,'videoVariationCount',1,'videoPublication',pg_temp.v('publication')))),
  1,'create_started');
insert into seen select 'link', public.service_space_catalog_video_link(pg_temp.team(), pg_temp.owner(), pg_temp.video());
update private.catalog_video_r2_copies set state='ready', ready_at=now() where id=(pg_temp.v('link')->>'copyId')::uuid;
create temporary table ops(operation_id uuid, state text, reused boolean);
insert into ops select * from public.service_start_team_operation(pg_temp.team(),pg_temp.owner(),'upload','catalog:growth-1',
  'catalog:growth-1',pg_temp.video(),'05791030-0000-4000-8000-000000000101','clip catalog 1',now()+interval '1 hour',null);
insert into seen select 'commit', public.service_commit_space_catalog_feed((select operation_id from ops),pg_temp.owner(),'clip catalog 1',2048);
insert into seen select 'linked', public.service_link_space_catalog_feed(pg_temp.team(), pg_temp.video(), pg_temp.catalog(), null,
  jsonb_build_object('sourceLink','https://offer.test/?s=1','productCount',3,
    'sheetUrl','https://catalog-videos-beta.soty.pp.ua/feeds/'||repeat('a',32)||'.csv',
    'videoLink',pg_temp.v('link')->>'url','settingsSnapshot','{}'::jsonb,'createdBy',pg_temp.owner(),'variant',1,
    'feedId',repeat('a',32),'feedBytes',2048,
    'spacePublicationKey','product-catalog:05791030-0000-4000-8000-0000000000a1'), pg_temp.owner());
select is(pg_temp.v('linked')->>'linked', 'true', 'the scheduled catalog links');
update private.catalog_video_publication_policies set due_at = now() - interval '1 minute' where catalog_material_id=pg_temp.catalog();
select ok(pg_temp.publish(), 'its link is published when due');
select is((pg_temp.job()).state||':'||(pg_temp.policy()).revision, 'published:1', 'the policy stays, published');

-- The round grows the catalog by one product.
insert into public.team_catalog_update_profiles(catalog_material_id,team_id,refresh_images,refresh_texts,grow_products,random_link_variation,restitch)
 values (pg_temp.catalog(), pg_temp.team(), false, false, true, false, false)
 on conflict (catalog_material_id) do update set grow_products=true, restitch=false;
select set_config('request.jwt.claims', json_build_object('sub', pg_temp.owner(), 'role', 'authenticated')::text, true);
select set_config('request.jwt.claim.sub', pg_temp.owner()::text, true);
select lives_ok($$select public.run_team_catalog_update_now(pg_temp.team(), array[pg_temp.catalog()])$$, 'a manager runs the update now');
select is((select count(*)::integer from public.service_claim_catalog_updater_items('growth', 5, 60) i where i.catalog_material_id=pg_temp.catalog()), 1,
 'the updater claims the feed''s catalog');
select ok(not public.service_catalog_publication_allows_legacy_write(pg_temp.catalog()),
 'its round leaves the video column to the publication');
insert into seen select 'context', public.service_prepare_catalog_nonvideo_update_context(pg_temp.catalog(), 'growth');
select is((pg_temp.v('context')->>'currentProductCount')||'>'||(pg_temp.v('context')->>'productCount'), '3>4',
 'the non-video context grows the catalog by one');
select is(jsonb_array_length(pg_temp.v('context')->'recipeRowIds'), 4, 'with a recipe row for every product');
insert into seen select 'snapshot', jsonb_build_object('_catalogRecipeRowIds', pg_temp.v('context')->'recipeRowIds',
  '_catalogPublicIds', '["p1","p2","p3","p4"]'::jsonb, 'rows', '[]'::jsonb);
select ok(public.service_begin_catalog_nonvideo_update_write(pg_temp.catalog(), 'growth', gen_random_uuid(),
  (select feed_revision::text from public.team_product_catalogs where material_id=pg_temp.catalog()), 1, 4,
  pg_temp.v('snapshot'), pg_temp.v('context')->>'contextToken'), 'the round begins its write');
select ok(public.service_complete_catalog_update(pg_temp.catalog(), 'growth', 1, null, 4, pg_temp.v('snapshot')),
 'and completes it');
select lives_ok($$select public.service_finish_catalog_update_write(pg_temp.catalog())$$, 'the write is finished');

-- The publication follows the grown catalog.
select is((select product_count::integer from public.team_product_catalogs where material_id=pg_temp.catalog()), 4, 'the catalog has four products');
select is((pg_temp.policy()).revision||':'||(pg_temp.job()).state, '2:waiting',
 'its policy moves on and the new job waits to write the added row');
select is(public.service_space_catalog_publication_context(
  (public.service_claim_space_catalog_publication_jobs(pg_temp.worker(), 3)->'items'->0->>'jobId')::uuid, pg_temp.worker())
  ->>'productCount', '4', 'the feed''s claim takes it and its context names every product');

select * from finish();
rollback;
