begin;
select plan(25);

-- 057 T040/T041 (20261226210000): the catalogs of an R2 space take their sources from the space.
-- A catalog video copy of a space file is claimed with its content id and no Drive fields; its
-- part-by-part proof (`space-1`) is accepted only for a space source; a feed catalog is claimable
-- by the updater; a feed catalog removed for good queues its CSV for deletion. A Drive source is
-- claimed and verified exactly as before.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05741000-0000-4000-8000-000000000001','authenticated','authenticated','sources-owner@test.invalid','{}','{}');
insert into public.storage_r2_pilots(user_id,max_space_bytes) values('05741000-0000-4000-8000-000000000001',1000000000);
insert into public.teams(id,name,owner_id,storage_backend,storage_pilot) values
 ('05741000-0000-4000-8000-000000000011','Sources R2','05741000-0000-4000-8000-000000000001','r2',true);
insert into public.teams(id,name,owner_id) values
 ('05741000-0000-4000-8000-000000000012','Sources Drive','05741000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('05741000-0000-4000-8000-000000000011','05741000-0000-4000-8000-000000000001','admin'),
 ('05741000-0000-4000-8000-000000000012','05741000-0000-4000-8000-000000000001','admin')
 on conflict do nothing;

-- The R2 space: a root, a committed video, a second video whose object is being purged, and a
-- feed catalog of the first.
insert into public.team_materials(id,team_id,name,kind) values
 ('05741000-0000-4000-8000-000000000101','05741000-0000-4000-8000-000000000011','Sources R2','folder');
update public.teams set storage_root_material_id='05741000-0000-4000-8000-000000000101'
 where id='05741000-0000-4000-8000-000000000011';
insert into public.space_objects(id,team_id,content_id,byte_size,content_type,r2_key,state) values
 ('05741000-0000-4000-8000-000000000201','05741000-0000-4000-8000-000000000011',repeat('1',64),1000,'video/mp4',
  't/05741000-0000-4000-8000-000000000011/o/'||repeat('1',64),'committed'),
 ('05741000-0000-4000-8000-000000000202','05741000-0000-4000-8000-000000000011',repeat('2',64),1000,'video/mp4',
  't/05741000-0000-4000-8000-000000000011/o/'||repeat('2',64),'purge_pending');
insert into public.team_materials(id,team_id,parent_folder_id,name,kind,category,mime_type,space_object_id) values
 ('05741000-0000-4000-8000-000000000103','05741000-0000-4000-8000-000000000011',
  '05741000-0000-4000-8000-000000000101','Clip.mp4','file','video','video/mp4','05741000-0000-4000-8000-000000000201'),
 ('05741000-0000-4000-8000-000000000104','05741000-0000-4000-8000-000000000011',
  '05741000-0000-4000-8000-000000000101','Gone.mp4','file','video','video/mp4','05741000-0000-4000-8000-000000000202');
insert into public.team_materials(id,team_id,parent_folder_id,name,kind,category,companion_of,companion_kind) values
 ('05741000-0000-4000-8000-000000000102','05741000-0000-4000-8000-000000000011',
  '05741000-0000-4000-8000-000000000101','Clip catalog','file','other',
  '05741000-0000-4000-8000-000000000103','product_catalog');
insert into public.team_product_catalogs(material_id,team_id,source_link,product_count,sheet_url,video_link,settings_snapshot)
values ('05741000-0000-4000-8000-000000000102','05741000-0000-4000-8000-000000000011','https://offer.test/?s=1',3,
  'https://catalog-videos-beta.soty.pp.ua/feeds/'||repeat('a',32)||'.csv','https://catalog-videos-beta.soty.pp.ua/v/x.mp4','{}');
select public.service_record_catalog_feed('05741000-0000-4000-8000-000000000102',repeat('a',32),9715,0);

-- The Drive space, as every space before 057.
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('05741000-0000-4000-8000-000000000021','05741000-0000-4000-8000-000000000001','sources-drive','sources-owner@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('05741000-0000-4000-8000-000000000031','05741000-0000-4000-8000-000000000012','05741000-0000-4000-8000-000000000021','sources-root','Root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type) values
 ('05741000-0000-4000-8000-000000000142','05741000-0000-4000-8000-000000000012','05741000-0000-4000-8000-000000000031',
  'sources-clip','sources-root','Clip.mp4','file','video','video/mp4');
insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,companion_of,companion_kind) values
 ('05741000-0000-4000-8000-000000000141','05741000-0000-4000-8000-000000000012','05741000-0000-4000-8000-000000000031',
  'sources-sheet','sources-root','Clip catalog','file','other','application/vnd.google-apps.spreadsheet',
  '05741000-0000-4000-8000-000000000142','product_catalog');
insert into public.team_product_catalogs(material_id,team_id,source_link,product_count,sheet_url,video_link,settings_snapshot)
values ('05741000-0000-4000-8000-000000000141','05741000-0000-4000-8000-000000000012','https://offer.test/?s=1',3,
  'https://docs.google.com/spreadsheets/d/sources-sheet/edit','https://drive.google.com/file/d/x/view','{}');

-- 1. Copy claims -------------------------------------------------------------------------
update private.catalog_video_r2_config set enabled=true, public_origin='https://videos.test';
insert into private.catalog_video_r2_copies(id,team_id,source_material_id,source_version,size_bytes,part_bytes,next_attempt_at) values
 ('05741000-0000-4000-8000-000000000301','05741000-0000-4000-8000-000000000011','05741000-0000-4000-8000-000000000103',
  repeat('1',64),1000,16777216,now()-interval '3 minutes'),
 ('05741000-0000-4000-8000-000000000302','05741000-0000-4000-8000-000000000012','05741000-0000-4000-8000-000000000142',
  'drive-version-1',1000,16777216,now()-interval '2 minutes'),
 ('05741000-0000-4000-8000-000000000303','05741000-0000-4000-8000-000000000011','05741000-0000-4000-8000-000000000104',
  repeat('2',64),1000,16777216,now()-interval '1 minute');

create temporary table claims(n serial, body jsonb);
insert into claims(body) select public.service_catalog_video_r2_claim('worker-057-sources');
insert into claims(body) select public.service_catalog_video_r2_claim('worker-057-sources');
insert into claims(body) select public.service_catalog_video_r2_claim('worker-057-sources');

select is((select body->>'sourceKind' from claims where n=1),'space','a space file is claimed as a space source');
select is((select body->>'fileId' from claims where n=1),repeat('1',64),'by its content id');
select ok((select body->'credentialId'='null'::jsonb and body->'connectionId'='null'::jsonb
  and body->'resourceKey'='null'::jsonb and body->'rootFolderId'='null'::jsonb from claims where n=1),
 'with no Drive field at all');
select ok((select not (body ? 'sourceKind') from claims where n=2),'a Drive claim has no source kind, as before');
select is((select body->>'fileId' from claims where n=2),'sources-clip','and names its Drive file');
select is((select body->>'credentialId' from claims where n=2),'05741000-0000-4000-8000-000000000021','with its credential');
select is((select body from claims where n=3),null,'a space file whose object is going is not claimed');
select is((select last_error from private.catalog_video_r2_copies where id='05741000-0000-4000-8000-000000000303'),
 'VIDEO_R2_SOURCE_UNAVAILABLE','its copy fails as unavailable');

-- 2. Part-by-part proof -------------------------------------------------------------------
update private.catalog_video_r2_copies set state='verifying' where id in
 ('05741000-0000-4000-8000-000000000301','05741000-0000-4000-8000-000000000302');
insert into private.catalog_video_r2_parts(copy_id,part_number,size_bytes,sha256,etag,verified_by) values
 ('05741000-0000-4000-8000-000000000301',1,1000,repeat('c',64),'"e1"','readback'),
 ('05741000-0000-4000-8000-000000000302',1,1000,repeat('c',64),'"e1"','readback');
select lives_ok($$select public.service_catalog_video_r2_verification_open('05741000-0000-4000-8000-000000000301',
  'worker-057-sources',(select fence from private.catalog_video_r2_copies where id='05741000-0000-4000-8000-000000000301'),
  '"staged"',private.catalog_video_r2_manifest('05741000-0000-4000-8000-000000000301'),repeat('b',32))$$,
 'a space copy opens its proof with the MD5 of its ETag');
select throws_ok($$select public.service_catalog_video_r2_verification_advance('05741000-0000-4000-8000-000000000301',
  'worker-057-sources',(select fence from private.catalog_video_r2_copies where id='05741000-0000-4000-8000-000000000301'),
  '"staged"',private.catalog_video_r2_manifest('05741000-0000-4000-8000-000000000301'),0,
  jsonb_build_object('version','space-1','bytes',1000,'digests',encode(decode(repeat('ab',15),'hex'),'base64')),repeat('b',32))$$,
 'INVALID_INPUT','a part list of the wrong length is refused');
select throws_ok($$select public.service_catalog_video_r2_verification_advance('05741000-0000-4000-8000-000000000301',
  'worker-057-sources',(select fence from private.catalog_video_r2_copies where id='05741000-0000-4000-8000-000000000301'),
  '"staged"',private.catalog_video_r2_manifest('05741000-0000-4000-8000-000000000301'),0,
  jsonb_build_object('version','space-1','bytes',1000,'digests','***'),repeat('b',32))$$,
 'INVALID_INPUT','so is one that is not base64');
select throws_ok($$select public.service_catalog_video_r2_verification_advance('05741000-0000-4000-8000-000000000301',
  'worker-057-sources',(select fence from private.catalog_video_r2_copies where id='05741000-0000-4000-8000-000000000301'),
  '"staged"',private.catalog_video_r2_manifest('05741000-0000-4000-8000-000000000301'),0,
  jsonb_build_object('version','space-1','bytes',1000,'digests',encode(decode(repeat('ab',16),'hex'),'base64')),repeat('9',32))$$,
 'VIDEO_R2_CHECKSUM_MISMATCH','the last part must give back the ETag MD5');
select lives_ok($$select public.service_catalog_video_r2_verification_advance('05741000-0000-4000-8000-000000000301',
  'worker-057-sources',(select fence from private.catalog_video_r2_copies where id='05741000-0000-4000-8000-000000000301'),
  '"staged"',private.catalog_video_r2_manifest('05741000-0000-4000-8000-000000000301'),0,
  jsonb_build_object('version','space-1','bytes',1000,'digests',encode(decode(repeat('ab',16),'hex'),'base64')),repeat('b',32))$$,
 'one part MD5 per part, ending in the ETag MD5, proves the copy');
select lives_ok($$select public.service_catalog_video_r2_ready('05741000-0000-4000-8000-000000000301','worker-057-sources',
  (select fence from private.catalog_video_r2_copies where id='05741000-0000-4000-8000-000000000301'),true,1)$$,
 'and the copy is ready');

select lives_ok($$select public.service_catalog_video_r2_verification_open('05741000-0000-4000-8000-000000000302',
  'worker-057-sources',(select fence from private.catalog_video_r2_copies where id='05741000-0000-4000-8000-000000000302'),
  '"staged"',private.catalog_video_r2_manifest('05741000-0000-4000-8000-000000000302'),repeat('d',32))$$,
 'a Drive copy opens its proof as before');
select throws_ok($$select public.service_catalog_video_r2_verification_advance('05741000-0000-4000-8000-000000000302',
  'worker-057-sources',(select fence from private.catalog_video_r2_copies where id='05741000-0000-4000-8000-000000000302'),
  '"staged"',private.catalog_video_r2_manifest('05741000-0000-4000-8000-000000000302'),0,
  jsonb_build_object('version','space-1','bytes',1000,'digests',encode(decode(repeat('ab',16),'hex'),'base64')),repeat('d',32))$$,
 'INVALID_INPUT','but can never use the space proof');

-- 3. Updater claim ------------------------------------------------------------------------
select ok(private.catalog_update_target_usable('05741000-0000-4000-8000-000000000102'),
 'the updater may take a feed catalog of an R2 space');
select ok(private.catalog_update_target_usable('05741000-0000-4000-8000-000000000141'),
 'and a Drive catalog on a usable connection, as before');
update public.team_drive_connections set state='needs_reauth' where id='05741000-0000-4000-8000-000000000031';
select ok(not private.catalog_update_target_usable('05741000-0000-4000-8000-000000000141'),
 'but not one whose connection needs reauthorization');
select ok(strpos(pg_get_functiondef('private.claim_catalog_updater_items(text,integer,integer)'::regprocedure),
 'private.catalog_update_target_usable(item.catalog_material_id)')>0,'the claim uses that predicate');
select ok(strpos(pg_get_function_result('public.service_claim_catalog_updater_items(text,integer,integer)'::regprocedure),
 'feed_id text, feed_revision bigint')>0,'and hands the worker the feed id and revision');

-- 4. Feed removal -------------------------------------------------------------------------
delete from public.team_product_catalogs where material_id='05741000-0000-4000-8000-000000000102';
select is((select count(*)::integer from private.catalog_feed_removals where feed_id=repeat('a',32) and removed_at is null),1,
 'a feed catalog deleted for good queues its CSV for deletion');
select ok(private.catalog_video_r2_has_work('sweep'),'which wakes the sweep');
select is(public.service_catalog_feed_claim_removal('worker-057-sources')->>'feedId',repeat('a',32),
 'the sweep claims it');
select public.service_catalog_feed_finish_removal(repeat('a',32),
 (select fence from private.catalog_feed_removals where feed_id=repeat('a',32)),true,null);
select ok((select removed_at is not null from private.catalog_feed_removals where feed_id=repeat('a',32)),
 'and records its deletion');

select * from finish();
rollback;
