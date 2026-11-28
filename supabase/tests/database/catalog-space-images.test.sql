begin;
select plan(19);

-- 057 T040/T041 (20261226240000): the catalog picture pool imports from the files of an R2 space.
-- The job enumerates the space's tree (a selected file, a selected folder's subtree), names its
-- source kind on the claim, and each picture is read by its content id while the file holds it.
-- 'space' is for an R2 space only, 'drive' for a Drive space only.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05744000-0000-4000-8000-000000000001','authenticated','authenticated','images-owner@test.invalid','{}','{}');
insert into public.storage_r2_pilots(user_id,max_space_bytes) values('05744000-0000-4000-8000-000000000001',1000000000);
-- The Drive space is open without a tariff: its owner is an admin (034).
insert into public.admin_users(user_id) values('05744000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id,storage_backend,storage_pilot) values
 ('05744000-0000-4000-8000-000000000011','Images R2','05744000-0000-4000-8000-000000000001','r2',true);
insert into public.teams(id,name,owner_id) values
 ('05744000-0000-4000-8000-000000000012','Images Drive','05744000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('05744000-0000-4000-8000-000000000011','05744000-0000-4000-8000-000000000001','admin'),
 ('05744000-0000-4000-8000-000000000012','05744000-0000-4000-8000-000000000001','admin')
 on conflict do nothing;

insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('05744000-0000-4000-8000-000000000021','05744000-0000-4000-8000-000000000001','images-drive','images-owner@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('05744000-0000-4000-8000-000000000031','05744000-0000-4000-8000-000000000012','05744000-0000-4000-8000-000000000021','images-root','Root','my_drive','connected',now());

insert into public.team_materials(id,team_id,name,kind) values
 ('05744000-0000-4000-8000-000000000101','05744000-0000-4000-8000-000000000011','Images R2','folder');
update public.teams set storage_root_material_id='05744000-0000-4000-8000-000000000101'
 where id='05744000-0000-4000-8000-000000000011';
insert into public.team_materials(id,team_id,parent_folder_id,name,kind) values
 ('05744000-0000-4000-8000-000000000102','05744000-0000-4000-8000-000000000011',
  '05744000-0000-4000-8000-000000000101','Pictures','folder'),
 ('05744000-0000-4000-8000-000000000103','05744000-0000-4000-8000-000000000011',
  '05744000-0000-4000-8000-000000000102','White','folder');
insert into public.space_objects(id,team_id,content_id,byte_size,content_type,r2_key,state) values
 ('05744000-0000-4000-8000-000000000201','05744000-0000-4000-8000-000000000011',repeat('5',64),1200,'image/png',
  't/05744000-0000-4000-8000-000000000011/o/'||repeat('5',64),'committed'),
 ('05744000-0000-4000-8000-000000000202','05744000-0000-4000-8000-000000000011',repeat('6',64),1300,'image/jpeg',
  't/05744000-0000-4000-8000-000000000011/o/'||repeat('6',64),'committed'),
 ('05744000-0000-4000-8000-000000000203','05744000-0000-4000-8000-000000000011',repeat('7',64),10,'text/plain',
  't/05744000-0000-4000-8000-000000000011/o/'||repeat('7',64),'committed');
insert into public.team_materials(id,team_id,parent_folder_id,name,kind,category,mime_type,space_object_id,size_bytes) values
 ('05744000-0000-4000-8000-000000000104','05744000-0000-4000-8000-000000000011',
  '05744000-0000-4000-8000-000000000102','polo-white.png','file','image','image/png','05744000-0000-4000-8000-000000000201',1200),
 ('05744000-0000-4000-8000-000000000105','05744000-0000-4000-8000-000000000011',
  '05744000-0000-4000-8000-000000000103','shirt-white.jpg','file','image','image/jpeg','05744000-0000-4000-8000-000000000202',1300),
 ('05744000-0000-4000-8000-000000000106','05744000-0000-4000-8000-000000000011',
  '05744000-0000-4000-8000-000000000102','notes.txt','file','other','text/plain','05744000-0000-4000-8000-000000000203',10);

-- 1. Begin ------------------------------------------------------------------------------------
create temporary table jobs(n serial, body jsonb);
insert into jobs(body) select public.service_catalog_image_control_v2('begin','05744000-0000-4000-8000-000000000001',
  jsonb_build_object('teamId','05744000-0000-4000-8000-000000000011','contractVersion',2,'sourceKind','space',
   'idempotencyKey','space-import-0001','sourceMaterialIds',jsonb_build_array('05744000-0000-4000-8000-000000000102')));
select is((select source_kind||':'||state from public.team_catalog_image_imports where id=(select (body->>'id')::uuid from jobs where n=1)),
 'space:enumerating','an R2 space imports from its own files and enumerates them');
select throws_ok($$select public.service_catalog_image_control_v2('begin','05744000-0000-4000-8000-000000000001',
  jsonb_build_object('teamId','05744000-0000-4000-8000-000000000011','contractVersion',2,'sourceKind','drive',
   'idempotencyKey','space-import-0002','sourceMaterialIds',jsonb_build_array('05744000-0000-4000-8000-000000000102')))$$,
 'STORAGE_BACKEND_MISMATCH','an R2 space has no Drive to import from');
select throws_ok($$select public.service_catalog_image_control_v2('begin','05744000-0000-4000-8000-000000000001',
  jsonb_build_object('teamId','05744000-0000-4000-8000-000000000012','contractVersion',2,'sourceKind','space',
   'idempotencyKey','space-import-0003','sourceMaterialIds',jsonb_build_array('05744000-0000-4000-8000-000000000102')))$$,
 'STORAGE_BACKEND_MISMATCH','a Drive space never imports space files');

-- 2. Claim and enumerate --------------------------------------------------------------------
create temporary table claims(n serial, body jsonb);
insert into claims(body) select public.service_catalog_image_claim_v2('worker-057-images');
select is((select body->>'kind'||':'||(body->>'sourceKind') from claims where n=1),'enumerate:space',
 'the enumeration claim names its source kind');
create temporary table pages(n serial, body jsonb);
insert into pages(body) select public.service_catalog_image_space_enumerate((select (body->>'jobId')::uuid from claims where n=1),
  'worker-057-images',(select (body->>'fence')::bigint from claims where n=1),null,1);
insert into pages(body) select public.service_catalog_image_space_enumerate((select (body->>'jobId')::uuid from claims where n=1),
  'worker-057-images',(select (body->>'fence')::bigint from claims where n=1),
  (select (body->'items'->0->>'materialId')::uuid from pages where n=1),1);
select is((select jsonb_array_length(body->'items')||':'||(body->>'hasMore') from pages where n=1),'1:true',
 'one picture per page here, and more to come');
select is((select jsonb_array_length(body->'items')||':'||(body->>'hasMore') from pages where n=2),'1:false',
 'the second page is the last');
select is((select array_agg(x order by x) from (select body->'items'->0->>'name' x from pages) names),
 array['polo-white.png','shirt-white.jpg'],'the folder''s pictures, the subfolder''s too, and nothing else');
select is((select body->'items'->0->>'contentId' from pages where n=1),
 (select content_id from public.space_objects o join public.team_materials m on m.space_object_id=o.id
   where m.id=(select (body->'items'->0->>'materialId')::uuid from pages where n=1)),
 'each with its content id');
select throws_ok($$select public.service_catalog_image_space_enumerate((select (body->>'jobId')::uuid from claims where n=1),
  'another-worker',(select (body->>'fence')::bigint from claims where n=1),null,10)$$,
 'PERMISSION_DENIED','only the worker holding the lease enumerates');
select lives_ok($$select public.service_catalog_image_enumeration_v2((select (body->>'jobId')::uuid from claims where n=1),
  'worker-057-images',(select (body->>'fence')::bigint from claims where n=1),
  (select jsonb_agg(jsonb_build_object('fileId',item->>'materialId','name',item->>'name','size',(item->>'size')::bigint,
    'mime',item->>'mime','classification',jsonb_build_object('mode','unclassified'),
    'source',jsonb_build_object('kind','space','materialId',item->>'materialId','contentId',item->>'contentId','size',(item->>'size')::bigint)))
   from pages, jsonb_array_elements(pages.body->'items') item),
  jsonb_build_array(jsonb_build_object('kind','space-after','id',(select body->'items'->0->>'materialId' from pages where n=2))),true,false)$$,
 'the pages are staged as for Drive');
select ok((select state in ('sealed','running') from public.team_catalog_image_imports where id=(select (body->>'jobId')::uuid from claims where n=1)),
 'and the job is sealed for its pictures');
select is((select count(*)::int from private.catalog_image_import_entries
  where job_id=(select (body->>'jobId')::uuid from claims where n=1) and source->>'kind'='space'),2,
 'with two space sources');

-- 3. A selected file that is no picture -----------------------------------------------------
insert into jobs(body) select public.service_catalog_image_control_v2('begin','05744000-0000-4000-8000-000000000001',
  jsonb_build_object('teamId','05744000-0000-4000-8000-000000000011','contractVersion',2,'sourceKind','space',
   'idempotencyKey','space-import-0004','sourceMaterialIds',jsonb_build_array('05744000-0000-4000-8000-000000000106')));
insert into claims(body) select public.service_catalog_image_claim_v2('worker-057-images');
select throws_ok($$select public.service_catalog_image_space_enumerate((select (body->>'jobId')::uuid from claims where n=2),
  'worker-057-images',(select (body->>'fence')::bigint from claims where n=2),null,10)$$,
 'IMAGE_UNSUPPORTED_FORMAT','a selected file that is no picture is refused, as on Drive');

-- 4. Reading a staged picture ---------------------------------------------------------------
select is(public.service_catalog_image_space_source('05744000-0000-4000-8000-000000000011',
  '05744000-0000-4000-8000-000000000001','05744000-0000-4000-8000-000000000104',repeat('5',64))->>'key',
 't/05744000-0000-4000-8000-000000000011/o/'||repeat('5',64),'a picture is read from its object');
update public.team_materials set space_object_id='05744000-0000-4000-8000-000000000202'
 where id='05744000-0000-4000-8000-000000000104';
select throws_ok($$select public.service_catalog_image_space_source('05744000-0000-4000-8000-000000000011',
  '05744000-0000-4000-8000-000000000001','05744000-0000-4000-8000-000000000104',repeat('5',64))$$,
 'IMAGE_SOURCE_CHANGED','a file that holds other content now is not read');
select throws_ok($$select public.service_catalog_image_space_source('05744000-0000-4000-8000-000000000012',
  '05744000-0000-4000-8000-000000000001','05744000-0000-4000-8000-000000000104',repeat('6',64))$$,
 'STORAGE_BACKEND_MISMATCH','a Drive space is never read here');

-- 5. Drive spaces ---------------------------------------------------------------------------
update public.team_catalog_image_imports set state='cancelled'
 where id=(select (body->>'jobId')::uuid from claims where n=2);
insert into jobs(body) select public.service_catalog_image_control_v2('begin','05744000-0000-4000-8000-000000000001',
  jsonb_build_object('teamId','05744000-0000-4000-8000-000000000012','contractVersion',2,'sourceKind','drive',
   'idempotencyKey','drive-import-0001','sourceMaterialIds',jsonb_build_array('05744000-0000-4000-8000-000000000999')));
select is((select source_kind||':'||state from public.team_catalog_image_imports
  where id=(select (body->>'id')::uuid from jobs where n=3)),'drive:enumerating','a Drive space imports from Drive as before');
insert into claims(body) select public.service_catalog_image_claim_v2('worker-057-images');
select is((select body->>'sourceKind' from claims where n=3),'drive','and its claim says so');
select throws_ok($$select public.service_catalog_image_space_enumerate((select (body->>'jobId')::uuid from claims where n=3),
  'worker-057-images',(select (body->>'fence')::bigint from claims where n=3),null,10)$$,
 'PERMISSION_DENIED','a Drive job is never enumerated here');

select * from finish();
rollback;
