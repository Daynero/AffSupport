begin;
select plan(28);

-- 057 T040/T041 (20261226230000): a catalog created in an R2 space. Its video and folder are read
-- from the space, its video is linked from the R2 copy planned under the object's content id, its
-- feed is a companion row without an object committed by the catalog's own operation, and the link
-- records the feed and the copy preference in one transaction. A Drive space keeps every check.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05742000-0000-4000-8000-000000000001','authenticated','authenticated','create-owner@test.invalid','{}','{}'),
 ('05742000-0000-4000-8000-000000000002','authenticated','authenticated','create-outsider@test.invalid','{}','{}');
insert into public.storage_r2_pilots(user_id,max_space_bytes) values
 ('05742000-0000-4000-8000-000000000001',1000000000),('05742000-0000-4000-8000-000000000002',1000000000);
insert into public.teams(id,name,owner_id,storage_backend,storage_pilot) values
 ('05742000-0000-4000-8000-000000000011','Create R2','05742000-0000-4000-8000-000000000001','r2',true);
insert into public.teams(id,name,owner_id) values
 ('05742000-0000-4000-8000-000000000012','Create Drive','05742000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('05742000-0000-4000-8000-000000000011','05742000-0000-4000-8000-000000000001','admin'),
 ('05742000-0000-4000-8000-000000000012','05742000-0000-4000-8000-000000000001','admin')
 on conflict do nothing;

insert into public.team_materials(id,team_id,name,kind) values
 ('05742000-0000-4000-8000-000000000101','05742000-0000-4000-8000-000000000011','Create R2','folder');
update public.teams set storage_root_material_id='05742000-0000-4000-8000-000000000101'
 where id='05742000-0000-4000-8000-000000000011';
insert into public.team_materials(id,team_id,parent_folder_id,name,kind) values
 ('05742000-0000-4000-8000-000000000102','05742000-0000-4000-8000-000000000011',
  '05742000-0000-4000-8000-000000000101','Shop','folder');
insert into public.space_objects(id,team_id,content_id,byte_size,content_type,r2_key,state) values
 ('05742000-0000-4000-8000-000000000201','05742000-0000-4000-8000-000000000011',repeat('3',64),5000,'video/mp4',
  't/05742000-0000-4000-8000-000000000011/o/'||repeat('3',64),'committed'),
 ('05742000-0000-4000-8000-000000000202','05742000-0000-4000-8000-000000000011',repeat('4',64),5000,'video/quicktime',
  't/05742000-0000-4000-8000-000000000011/o/'||repeat('4',64),'committed');
insert into public.team_materials(id,team_id,parent_folder_id,name,kind,category,mime_type,space_object_id,size_bytes) values
 ('05742000-0000-4000-8000-000000000103','05742000-0000-4000-8000-000000000011',
  '05742000-0000-4000-8000-000000000102','clip.mp4','file','video','video/mp4','05742000-0000-4000-8000-000000000201',5000),
 ('05742000-0000-4000-8000-000000000104','05742000-0000-4000-8000-000000000011',
  '05742000-0000-4000-8000-000000000102','clip catalog 1 (old).mov','file','video','video/quicktime','05742000-0000-4000-8000-000000000202',5000);

update private.catalog_video_r2_config set enabled=true, public_origin='https://videos.test', policy_confirmed_at=now();

-- 1. Reads ----------------------------------------------------------------------------------
select is((public.service_space_catalog_material('05742000-0000-4000-8000-000000000011',
  '05742000-0000-4000-8000-000000000103','05742000-0000-4000-8000-000000000001','view'))->>'contentId',
 repeat('3',64),'the video of an R2 space is read with its content id');
select is((public.service_space_catalog_material('05742000-0000-4000-8000-000000000011',
  '05742000-0000-4000-8000-000000000103','05742000-0000-4000-8000-000000000001','view'))->>'parentFolderId',
 '05742000-0000-4000-8000-000000000102','and its folder');
select is((public.service_space_catalog_material('05742000-0000-4000-8000-000000000011',
  '05742000-0000-4000-8000-000000000102','05742000-0000-4000-8000-000000000001','upload'))->>'kind',
 'folder','its folder is read for upload');
select throws_ok($$select public.service_space_catalog_material('05742000-0000-4000-8000-000000000011',
  '05742000-0000-4000-8000-000000000103','05742000-0000-4000-8000-000000000002','view')$$,
 'PERMISSION_DENIED','someone outside the space reads nothing');
select throws_ok($$select public.service_space_catalog_material('05742000-0000-4000-8000-000000000012',
  '05742000-0000-4000-8000-000000000103','05742000-0000-4000-8000-000000000001','view')$$,
 'STORAGE_BACKEND_MISMATCH','a Drive space is never read here');
select is(jsonb_array_length(public.service_space_catalog_names('05742000-0000-4000-8000-000000000011',
  '05742000-0000-4000-8000-000000000102','05742000-0000-4000-8000-000000000001','clip catalog')),
 1,'the folder''s names that start like the catalog''s');

-- 2. The video's R2 copy --------------------------------------------------------------------
create temporary table links(n serial, body jsonb);
insert into links(body) select public.service_space_catalog_video_link('05742000-0000-4000-8000-000000000011',
  '05742000-0000-4000-8000-000000000001','05742000-0000-4000-8000-000000000103');
insert into links(body) select public.service_space_catalog_video_link('05742000-0000-4000-8000-000000000011',
  '05742000-0000-4000-8000-000000000001','05742000-0000-4000-8000-000000000103');
select is((select source_version from private.catalog_video_r2_copies where id=(select (body->>'copyId')::uuid from links where n=1)),
 repeat('3',64),'the copy is planned under the object''s content id');
select is((select body->>'url' from links where n=1),
 'https://videos.test/'||(select object_key from private.catalog_video_r2_copies where id=(select (body->>'copyId')::uuid from links where n=1)),
 'its address is the copy''s public one');
select is((select body->>'copyId' from links where n=2),(select body->>'copyId' from links where n=1),
 'a second catalog of the same video uses the same copy');
select is((select body->>'state' from links where n=1),'planned','not yet copied');
select throws_ok($$select public.service_space_catalog_video_link('05742000-0000-4000-8000-000000000011',
  '05742000-0000-4000-8000-000000000001','05742000-0000-4000-8000-000000000104')$$,
 'VIDEO_R2_UNSUPPORTED_FORMAT','a video R2 cannot serve has no Drive fallback: the creation is refused');

-- 3. The feed's companion -------------------------------------------------------------------
create temporary table ops(operation_id uuid, state text, reused boolean);
insert into ops select * from public.service_start_team_operation('05742000-0000-4000-8000-000000000011',
  '05742000-0000-4000-8000-000000000001','upload','catalog:create-057-1','catalog:create-057-1',
  '05742000-0000-4000-8000-000000000103','05742000-0000-4000-8000-000000000102','clip catalog 1',now()+interval '1 hour',null);
create temporary table commits(n serial, body jsonb);
insert into commits(body) select public.service_commit_space_catalog_feed((select operation_id from ops),
  '05742000-0000-4000-8000-000000000001','clip catalog 1',2048);
insert into commits(body) select public.service_commit_space_catalog_feed((select operation_id from ops),
  '05742000-0000-4000-8000-000000000001','clip catalog 1',2048);
select ok((select connection_id is null and drive_file_id is null and space_object_id is null and mime_type='text/csv'
  and companion_kind='product_catalog' and companion_of='05742000-0000-4000-8000-000000000103' and parent_folder_id='05742000-0000-4000-8000-000000000102'
  from public.team_materials where id=(select (body->>'materialId')::uuid from commits where n=1)),
 'the feed is an R2 row without an object, beside its video');
select is((select state||':'||result_material_id::text from public.team_operations where id=(select operation_id from ops)),
 'succeeded:'||(select body->>'materialId' from commits where n=1),'its operation succeeded with it');
select is((select body->>'materialId' from commits where n=2),(select body->>'materialId' from commits where n=1),
 'a repeated commit answers the same row');
select is((select body->>'reused' from commits where n=2),'true','and says so');
select throws_ok($$select public.service_commit_space_catalog_feed((select operation_id from ops),
  '05742000-0000-4000-8000-000000000002','clip catalog 1',2048)$$,'NOT_FOUND','another person cannot commit it');

-- 4. Link -----------------------------------------------------------------------------------
create temporary table linked(body jsonb);
insert into linked select public.service_link_space_catalog_feed('05742000-0000-4000-8000-000000000011',
  '05742000-0000-4000-8000-000000000103',(select (body->>'materialId')::uuid from commits where n=1),null,
  jsonb_build_object('sourceLink','https://offer.test/?s=1','productCount',3,
   'sheetUrl','https://catalog-videos-beta.soty.pp.ua/feeds/'||repeat('e',32)||'.csv',
   'videoLink',(select body->>'url' from links where n=1),'settingsSnapshot','{}'::jsonb,
   'createdBy','05742000-0000-4000-8000-000000000001','variant',1,'feedId',repeat('e',32),'feedBytes',2048),
  '05742000-0000-4000-8000-000000000001');
select is((select body->>'linked' from linked),'true','the feed is linked to its video');
select is((select feed_id||':'||feed_revision||':'||feed_bytes from public.team_product_catalogs
  where material_id=(select (body->>'materialId')::uuid from commits where n=1)),
 repeat('e',32)||':1:2048','its feed is recorded with the link');
select is((select bytes from public.space_storage_usage where team_id='05742000-0000-4000-8000-000000000011' and category='catalogs'),
 2048::bigint,'and counted under catalogs');
select ok((select enabled from private.catalog_video_r2_preferences
  where catalog_material_id=(select (body->>'materialId')::uuid from commits where n=1)),
 'the catalog''s video is its R2 copy');
select is((select requested_by_catalog from private.catalog_video_r2_copies where id=(select (body->>'copyId')::uuid from links where n=1)),
 (select (body->>'materialId')::uuid from commits where n=1),'which the catalog now asks for');
-- T091: the catalog uses its copy from the link on, so the copy is never retired as nobody's.
select is((select copy_id from private.catalog_video_r2_uses
  where catalog_material_id=(select (body->>'materialId')::uuid from commits where n=1)
    and source_material_id='05742000-0000-4000-8000-000000000103'),
 (select (body->>'copyId')::uuid from links where n=1),'the catalog uses its video''s copy from the link on');
select is(public.service_catalog_video_r2_resolve_current((select (body->>'materialId')::uuid from commits where n=1))->>'sourceVersion',
 repeat('3',64),'the updater resolves the copy by the content id');
select is((select companion_of from public.team_materials where id=(select (body->>'materialId')::uuid from commits where n=1)),
 '05742000-0000-4000-8000-000000000103'::uuid,'the feed is the video''s companion');

-- 5. Drive spaces ---------------------------------------------------------------------------
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('05742000-0000-4000-8000-000000000021','05742000-0000-4000-8000-000000000001','create-drive','create-owner@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('05742000-0000-4000-8000-000000000031','05742000-0000-4000-8000-000000000012','05742000-0000-4000-8000-000000000021','create-root','Root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type) values
 ('05742000-0000-4000-8000-000000000142','05742000-0000-4000-8000-000000000012','05742000-0000-4000-8000-000000000031',
  'create-clip','create-root','Clip.mp4','file','video','video/mp4'),
 ('05742000-0000-4000-8000-000000000143','05742000-0000-4000-8000-000000000012','05742000-0000-4000-8000-000000000031',
  'create-csv','create-root','Clip.csv','file','other','text/csv'),
 ('05742000-0000-4000-8000-000000000144','05742000-0000-4000-8000-000000000012','05742000-0000-4000-8000-000000000031',
  'create-sheet','create-root','Clip catalog','file','other','application/vnd.google-apps.spreadsheet');
select is(public.service_link_product_catalog_companion('05742000-0000-4000-8000-000000000012',
  '05742000-0000-4000-8000-000000000142','05742000-0000-4000-8000-000000000143',null,
  jsonb_build_object('sourceLink','https://offer.test/?s=1','productCount',3,'sheetUrl','https://docs.google.com/x',
   'videoLink','https://drive.google.com/file/d/x/view','settingsSnapshot','{}'::jsonb))->>'reason',
 'NOT_ELIGIBLE','a CSV file of a Drive space is still no catalog');
select is(public.service_link_product_catalog_companion('05742000-0000-4000-8000-000000000012',
  '05742000-0000-4000-8000-000000000142','05742000-0000-4000-8000-000000000144',null,
  jsonb_build_object('sourceLink','https://offer.test/?s=1','productCount',3,'sheetUrl','https://docs.google.com/x',
   'videoLink','https://drive.google.com/file/d/x/view','settingsSnapshot','{}'::jsonb))->>'linked',
 'true','a Google sheet links as before');
select throws_ok($$select public.service_link_space_catalog_feed('05742000-0000-4000-8000-000000000012',
  '05742000-0000-4000-8000-000000000142','05742000-0000-4000-8000-000000000143',null,
  jsonb_build_object('feedId',repeat('f',32),'feedBytes',10),'05742000-0000-4000-8000-000000000001')$$,
 'STORAGE_BACKEND_MISMATCH','a Drive space never links a feed');
select is((public.service_catalog_video_r2_resolve_current('05742000-0000-4000-8000-000000000144'))->>'enabled',
 'false','a Drive catalog without the option resolves as before');

select * from finish();
rollback;
