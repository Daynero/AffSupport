begin;
select plan(12);

-- 057 T036/T037: a catalog of an R2 space keeps a feed instead of a Google sheet
-- (20261226200000). A recorded write counts the feed's bytes under `catalogs`, replaces them on
-- the next write and takes them out when the catalog goes; a stale writer is refused; a Drive
-- catalog cannot record a feed at all.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05737000-0000-4000-8000-000000000001','authenticated','authenticated','feed-owner@test.invalid','{}','{}');
insert into public.storage_r2_pilots(user_id,max_space_bytes) values('05737000-0000-4000-8000-000000000001',1000000000);
insert into public.teams(id,name,owner_id,storage_backend,storage_pilot) values
 ('05737000-0000-4000-8000-000000000011','Feed R2','05737000-0000-4000-8000-000000000001','r2',true);
insert into public.teams(id,name,owner_id) values
 ('05737000-0000-4000-8000-000000000012','Feed Drive','05737000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('05737000-0000-4000-8000-000000000011','05737000-0000-4000-8000-000000000001','admin'),
 ('05737000-0000-4000-8000-000000000012','05737000-0000-4000-8000-000000000001','admin')
 on conflict do nothing;
insert into public.team_materials(id,team_id,name,kind) values
 ('05737000-0000-4000-8000-000000000101','05737000-0000-4000-8000-000000000011','Feed R2','folder');
update public.teams set storage_root_material_id='05737000-0000-4000-8000-000000000101'
 where id='05737000-0000-4000-8000-000000000011';
insert into public.space_objects(id,team_id,content_id,byte_size,content_type,r2_key) values
 ('05737000-0000-4000-8000-000000000201','05737000-0000-4000-8000-000000000011',repeat('1',64),1000,'video/mp4',
  't/05737000-0000-4000-8000-000000000011/o/'||repeat('1',64));
insert into public.team_materials(id,team_id,parent_folder_id,name,kind,category,mime_type,space_object_id) values
 ('05737000-0000-4000-8000-000000000103','05737000-0000-4000-8000-000000000011',
  '05737000-0000-4000-8000-000000000101','Clip.mp4','file','video','video/mp4','05737000-0000-4000-8000-000000000201');
insert into public.team_materials(id,team_id,parent_folder_id,name,kind,category,companion_of,companion_kind) values
 ('05737000-0000-4000-8000-000000000102','05737000-0000-4000-8000-000000000011',
  '05737000-0000-4000-8000-000000000101','Clip catalog','file','other',
  '05737000-0000-4000-8000-000000000103','product_catalog');
insert into public.team_product_catalogs(material_id,team_id,source_link,product_count,sheet_url,video_link,settings_snapshot)
values ('05737000-0000-4000-8000-000000000102','05737000-0000-4000-8000-000000000011','https://offer.test/?s=1',3,
  'https://catalog-videos-beta.soty.pp.ua/feeds/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.csv','https://catalog-videos-beta.soty.pp.ua/v/x.mp4','{}');

-- A Drive catalog, as every catalog before 057.
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('05737000-0000-4000-8000-000000000021','05737000-0000-4000-8000-000000000001','feed-drive','feed-owner@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('05737000-0000-4000-8000-000000000031','05737000-0000-4000-8000-000000000012','05737000-0000-4000-8000-000000000021','feed-root','Root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type) values
 ('05737000-0000-4000-8000-000000000142','05737000-0000-4000-8000-000000000012','05737000-0000-4000-8000-000000000031',
  'feed-clip','feed-root','Clip.mp4','file','video','video/mp4');
insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,companion_of,companion_kind) values
 ('05737000-0000-4000-8000-000000000141','05737000-0000-4000-8000-000000000012','05737000-0000-4000-8000-000000000031',
  'feed-sheet','feed-root','Clip catalog','file','other','application/vnd.google-apps.spreadsheet',
  '05737000-0000-4000-8000-000000000142','product_catalog');
insert into public.team_product_catalogs(material_id,team_id,source_link,product_count,sheet_url,video_link,settings_snapshot)
values ('05737000-0000-4000-8000-000000000141','05737000-0000-4000-8000-000000000012','https://offer.test/?s=1',3,
  'https://docs.google.com/spreadsheets/d/feed-sheet/edit','https://drive.google.com/file/d/x/view','{}');

select is((select feed_id from public.team_product_catalogs where material_id='05737000-0000-4000-8000-000000000141'),null,
 'a Drive catalog has no feed');
select throws_ok($$select public.service_record_catalog_feed('05737000-0000-4000-8000-000000000141',repeat('a',32),100,0)$$,
 '55000','STORAGE_BACKEND_MISMATCH','and cannot record one');

select is(public.service_record_catalog_feed('05737000-0000-4000-8000-000000000102',repeat('a',32),9715,0)->>'feedRevision','1',
 'the first write of a feed is revision 1');
select is((select bytes from public.space_storage_usage where team_id='05737000-0000-4000-8000-000000000011' and category='catalogs'),
 9715::bigint,'its bytes count under catalogs (FR-050)');
select is((select objects from public.space_storage_usage where team_id='05737000-0000-4000-8000-000000000011' and category='catalogs'),
 1::bigint,'as one thing');

select throws_ok($$select public.service_record_catalog_feed('05737000-0000-4000-8000-000000000102',repeat('a',32),100,0)$$,
 '55000','WRONG_STATE','a writer that started from an older revision is refused');
select throws_ok($$select public.service_record_catalog_feed('05737000-0000-4000-8000-000000000102',repeat('b',32),100,1)$$,
 '55000','WRONG_STATE','and so is another feed id for the same catalog');

select is(public.service_record_catalog_feed('05737000-0000-4000-8000-000000000102',repeat('a',32),4000,1)->>'feedRevision','2',
 'a rewrite moves the revision');
select is((select bytes from public.space_storage_usage where team_id='05737000-0000-4000-8000-000000000011' and category='catalogs'),
 4000::bigint,'and replaces the bytes instead of adding them');

delete from public.team_product_catalogs where material_id='05737000-0000-4000-8000-000000000102';
select is((select bytes from public.space_storage_usage where team_id='05737000-0000-4000-8000-000000000011' and category='catalogs'),
 0::bigint,'a catalog that goes takes its feed bytes out of the meter');

select ok(not has_function_privilege('authenticated','public.service_record_catalog_feed(uuid,text,bigint,bigint)','execute'),
 'a browser cannot record a feed');
select ok(has_column_privilege('authenticated','public.team_product_catalogs','feed_written_at','select')
  and not has_column_privilege('authenticated','public.team_product_catalogs','feed_id','select'),
 'a member sees when the feed was written, not its id column');

select * from finish();
rollback;
