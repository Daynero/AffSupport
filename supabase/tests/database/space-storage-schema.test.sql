begin;
select plan(55);

-- 057 T005: the R2 space foundation (20261226110000). A space keeps the backend it was
-- created with; R2 rows are folders, objects or catalog feeds, never Drive rows without Drive
-- fields; the tree has no cycles and no foreign parents; tables are fenced and isolated; usage
-- counts each object once, in its highest category, with shared bytes.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05700000-0000-4000-8000-000000000001','authenticated','authenticated','space-a@test.invalid','{}','{}'),
 ('05700000-0000-4000-8000-000000000002','authenticated','authenticated','space-b@test.invalid','{}','{}');
insert into public.admin_users(user_id) values
 ('05700000-0000-4000-8000-000000000001'),('05700000-0000-4000-8000-000000000002');
insert into public.teams(id,name,owner_id,storage_backend) values
 ('05700000-0000-4000-8000-000000000011','R2 A','05700000-0000-4000-8000-000000000001','r2'),
 ('05700000-0000-4000-8000-000000000012','R2 B','05700000-0000-4000-8000-000000000002','r2');
insert into public.teams(id,name,owner_id) values
 ('05700000-0000-4000-8000-000000000013','Drive','05700000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('05700000-0000-4000-8000-000000000011','05700000-0000-4000-8000-000000000001','admin'),
 ('05700000-0000-4000-8000-000000000012','05700000-0000-4000-8000-000000000002','admin'),
 ('05700000-0000-4000-8000-000000000013','05700000-0000-4000-8000-000000000001','admin')
 on conflict do nothing;
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('05700000-0000-4000-8000-000000000021','05700000-0000-4000-8000-000000000001','space-drive','space-a@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('05700000-0000-4000-8000-000000000031','05700000-0000-4000-8000-000000000013','05700000-0000-4000-8000-000000000021','drive-root','Root','my_drive','connected',now());

-- 1. The backend --------------------------------------------------------------------------
select is((select storage_backend from public.teams where id='05700000-0000-4000-8000-000000000013'),'drive','a space is on Drive unless created on R2');
select is((select access_epoch from public.teams where id='05700000-0000-4000-8000-000000000011'),0::bigint,'a new space starts at access epoch 0');
select throws_ok($$update public.teams set storage_backend='r2' where id='05700000-0000-4000-8000-000000000013'$$,
 '55000','STORAGE_BACKEND_MISMATCH','a Drive space never becomes R2');
select throws_ok($$update public.teams set storage_backend='drive' where id='05700000-0000-4000-8000-000000000011'$$,
 '55000','STORAGE_BACKEND_MISMATCH','an R2 space never becomes Drive');
select throws_ok($$insert into public.teams(name,owner_id,storage_backend) values('Bad','05700000-0000-4000-8000-000000000001','gdrive')$$,
 '23514',null,'the backend is drive or r2');
select lives_ok($$update public.teams set name='R2 A renamed' where id='05700000-0000-4000-8000-000000000011'$$,'other fields of an R2 space still change');
select throws_ok($$insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)
 values('05700000-0000-4000-8000-000000000011','05700000-0000-4000-8000-000000000021','r2-root','Root','my_drive','connected',now())$$,
 '55000','STORAGE_BACKEND_MISMATCH','an R2 space never gets a Drive connection, so catalog-sync never sees it');

-- 2. Row shapes ---------------------------------------------------------------------------
insert into public.team_materials(id,team_id,name,kind) values
 ('05700000-0000-4000-8000-000000000101','05700000-0000-4000-8000-000000000011','Root A','folder'),
 ('05700000-0000-4000-8000-000000000201','05700000-0000-4000-8000-000000000012','Root B','folder');
update public.teams set storage_root_material_id='05700000-0000-4000-8000-000000000101' where id='05700000-0000-4000-8000-000000000011';
update public.teams set storage_root_material_id='05700000-0000-4000-8000-000000000201' where id='05700000-0000-4000-8000-000000000012';
select ok(exists(select 1 from public.team_materials where id='05700000-0000-4000-8000-000000000101' and connection_id is null and drive_file_id is null),
 'an R2 root folder has no Drive fields');
select throws_ok($$insert into public.team_materials(team_id,name,kind) values('05700000-0000-4000-8000-000000000011','Second root','folder')$$,
 '23505',null,'an R2 space has one root');
select throws_ok($$insert into public.team_materials(team_id,connection_id,name,kind) values
 ('05700000-0000-4000-8000-000000000013','05700000-0000-4000-8000-000000000031','No id.mp4','file')$$,
 '23514',null,'a Drive row without drive_file_id is refused');
select throws_ok($$insert into public.team_materials(team_id,name,kind,parent_folder_id) values
 ('05700000-0000-4000-8000-000000000013','Loose.mp4','file','drive-root')$$,
 '55000','STORAGE_BACKEND_MISMATCH','a Drive-space row without Drive fields is refused');
select throws_ok($$insert into public.team_materials(team_id,name,kind,parent_folder_id) values
 ('05700000-0000-4000-8000-000000000011','No object.mp4','file','05700000-0000-4000-8000-000000000101')$$,
 '23514',null,'an R2 file without an object is refused');

insert into public.space_objects(id,team_id,content_id,byte_size,content_type,r2_key) values
 ('05700000-0000-4000-8000-000000000301','05700000-0000-4000-8000-000000000011',repeat('a',64),100,'video/mp4',
  't/05700000-0000-4000-8000-000000000011/o/'||repeat('a',64)),
 ('05700000-0000-4000-8000-000000000302','05700000-0000-4000-8000-000000000011',repeat('b',64),107374182400,'video/mp4',
  't/05700000-0000-4000-8000-000000000011/o/'||repeat('b',64)),
 ('05700000-0000-4000-8000-000000000303','05700000-0000-4000-8000-000000000012',repeat('a',64),100,'video/mp4',
  't/05700000-0000-4000-8000-000000000012/o/'||repeat('a',64));
select throws_ok($$insert into public.space_objects(team_id,content_id,byte_size,content_type,r2_key) values
 ('05700000-0000-4000-8000-000000000011',repeat('a',64),100,'video/mp4','t/05700000-0000-4000-8000-000000000011/o/'||repeat('a',64))$$,
 '23505',null,'the same content is one object per space');
select is((select count(*)::int from public.space_objects where content_id=repeat('a',64)),2,'but never deduplicated across spaces');
select throws_ok($$insert into public.space_objects(team_id,content_id,byte_size,content_type,r2_key) values
 ('05700000-0000-4000-8000-000000000011',repeat('c',64),1,'video/mp4','t/05700000-0000-4000-8000-000000000012/o/'||repeat('c',64))$$,
 '23514',null,'an object key lives under its own space and content');
select throws_ok($$insert into public.space_objects(team_id,content_id,byte_size,content_type,r2_key) values
 ('05700000-0000-4000-8000-000000000011',repeat('d',64),107374182401,'video/mp4','t/05700000-0000-4000-8000-000000000011/o/'||repeat('d',64))$$,
 '23514',null,'an object is at most 100 GiB');

insert into public.team_materials(id,team_id,name,kind,category,parent_folder_id,space_object_id,size_bytes,mime_type) values
 ('05700000-0000-4000-8000-000000000111','05700000-0000-4000-8000-000000000011','Clip.mp4','file','video','05700000-0000-4000-8000-000000000101','05700000-0000-4000-8000-000000000301',100,'video/mp4');
select ok(exists(select 1 from public.team_materials where id='05700000-0000-4000-8000-000000000111'),'an R2 file references its object');
select lives_ok($$insert into public.team_materials(team_id,name,kind,category,parent_folder_id,companion_of,companion_kind,mime_type) values
 ('05700000-0000-4000-8000-000000000011','Catalog','file','other','05700000-0000-4000-8000-000000000101','05700000-0000-4000-8000-000000000111','product_catalog','text/csv')$$,
 'an R2 catalog feed has no object of its own');
select throws_ok($$insert into public.team_materials(team_id,name,kind,category,parent_folder_id,space_object_id) values
 ('05700000-0000-4000-8000-000000000011','Theirs.mp4','file','video','05700000-0000-4000-8000-000000000101','05700000-0000-4000-8000-000000000303')$$,
 '23503',null,'a material never references another space''s object');
select throws_ok($$insert into public.team_materials(team_id,name,kind,category,space_object_id,connection_id,drive_file_id) values
 ('05700000-0000-4000-8000-000000000013','Mixed.mp4','file','video','05700000-0000-4000-8000-000000000301','05700000-0000-4000-8000-000000000031','mixed')$$,
 '23514',null,'a Drive row never carries an R2 object');
select throws_ok($$insert into public.team_materials(team_id,name,kind,category,parent_folder_id,space_object_id) values
 ('05700000-0000-4000-8000-000000000011','Shortcut','shortcut',null,'05700000-0000-4000-8000-000000000101',null)$$,
 '23514',null,'an R2 space has no Drive shortcuts');

-- 3. The tree -----------------------------------------------------------------------------
insert into public.team_materials(id,team_id,name,kind,parent_folder_id) values
 ('05700000-0000-4000-8000-000000000102','05700000-0000-4000-8000-000000000011','F1','folder','05700000-0000-4000-8000-000000000101'),
 ('05700000-0000-4000-8000-000000000103','05700000-0000-4000-8000-000000000011','F2','folder','05700000-0000-4000-8000-000000000102');
select throws_ok($$update public.team_materials set parent_folder_id='05700000-0000-4000-8000-000000000103' where id='05700000-0000-4000-8000-000000000102'$$,
 '22023','INVALID_INPUT','a folder is never moved under its own descendant');
select throws_ok($$update public.team_materials set parent_folder_id='05700000-0000-4000-8000-000000000102' where id='05700000-0000-4000-8000-000000000102'$$,
 '22023','INVALID_INPUT','nor under itself');
select throws_ok($$update public.team_materials set parent_folder_id='05700000-0000-4000-8000-000000000201' where id='05700000-0000-4000-8000-000000000102'$$,
 '22023','INVALID_INPUT','nor under a folder of another space');
select throws_ok($$update public.team_materials set parent_folder_id='05700000-0000-4000-8000-000000000111' where id='05700000-0000-4000-8000-000000000103'$$,
 '22023','INVALID_INPUT','nor under a file');
select throws_ok($$update public.team_materials set parent_folder_id='drive-root' where id='05700000-0000-4000-8000-000000000103'$$,
 '22023','INVALID_INPUT','an R2 parent is a folder id, never a Drive id');
select is((select material_revision from public.team_materials where id='05700000-0000-4000-8000-000000000111'),0::bigint,'a new R2 material is at revision 0');
update public.team_materials set name='Clip 2.mp4' where id='05700000-0000-4000-8000-000000000111';
update public.team_materials set parent_folder_id='05700000-0000-4000-8000-000000000103' where id='05700000-0000-4000-8000-000000000111';
select is((select material_revision from public.team_materials where id='05700000-0000-4000-8000-000000000111'),2::bigint,'each rename and move raises the revision');
update public.team_materials set provider_thumbnail_state='unavailable',provider_thumbnail_reason='unsupported' where id='05700000-0000-4000-8000-000000000111';
select is((select material_revision from public.team_materials where id='05700000-0000-4000-8000-000000000111'),2::bigint,'a background field does not');
select lives_ok($$update public.team_materials set parent_folder_id='05700000-0000-4000-8000-000000000101' where id='05700000-0000-4000-8000-000000000103'$$,
 'a folder moves to an ancestor''s sibling');

-- 4. Fences and isolation ----------------------------------------------------------------
select has_trigger('public','team_space_storage_signals','task_cleanup_reference_fence','the signal table is fenced');
select has_trigger('public','space_uploads','task_cleanup_reference_fence','the upload table is fenced (FK to team_materials)');
select is(private.task_cleanup_coverage_verified(),true,'attachment cleanup coverage stays verified');
select ok(exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='team_space_storage_signals')
 or not exists(select 1 from pg_publication where pubname='supabase_realtime'),'signals are published to Realtime');
select is((select count(*)::int from information_schema.columns where table_schema='private' and table_name='space_storage_journal'
 and column_name ~ '(name|path|key|url|grant|email)'),0,'the storage journal has no name, path or key column');

insert into public.team_space_storage_signals(team_id,kind,folder_id,revision) values
 ('05700000-0000-4000-8000-000000000011','content','05700000-0000-4000-8000-000000000101',1),
 ('05700000-0000-4000-8000-000000000012','content','05700000-0000-4000-8000-000000000201',1);
set local role authenticated;
select set_config('request.jwt.claim.sub','05700000-0000-4000-8000-000000000001',true);
select is((select array_agg(team_id::text order by team_id) from public.team_space_storage_signals),
 array['05700000-0000-4000-8000-000000000011'],'a member reads only the signals of their own space');
select throws_ok($$select count(*) from public.space_objects$$,'42501',null,'objects are not readable by clients');
select throws_ok($$select count(*) from public.space_uploads$$,'42501',null,'nor uploads');
select throws_ok($$insert into public.team_space_storage_signals(team_id,kind,revision) values('05700000-0000-4000-8000-000000000011','usage',2)$$,
 '42501',null,'nor may a client write a signal');
select set_config('request.jwt.claim.sub','05700000-0000-4000-8000-000000000002',true);
select is((select array_agg(team_id::text order by team_id) from public.team_space_storage_signals),
 array['05700000-0000-4000-8000-000000000012'],'the other space''s member reads only theirs');
reset role;

-- 5. Usage --------------------------------------------------------------------------------
create function pg_temp.usage(p_category text) returns text language sql as $$
 select coalesce((select bytes||'/'||objects||'/'||shared_bytes from public.space_storage_usage
  where team_id='05700000-0000-4000-8000-000000000011' and category=p_category),'0/0/0')
$$;
insert into public.space_object_refs(object_id,owner_kind,owner_id,team_id,category) values
 ('05700000-0000-4000-8000-000000000301','material','05700000-0000-4000-8000-000000000111','05700000-0000-4000-8000-000000000011','materials');
select is(pg_temp.usage('materials'),'100/1/0','a referenced object counts in its category');
insert into public.space_object_refs(object_id,owner_kind,owner_id,team_id,category) values
 ('05700000-0000-4000-8000-000000000301','task_attachment','05700000-0000-4000-8000-0000000001a1','05700000-0000-4000-8000-000000000011','attachments');
select is(pg_temp.usage('materials'),'100/1/100','a second reference does not count it twice, it marks it shared');
select is(pg_temp.usage('attachments'),'0/0/0','and the lower category does not count it at all');
insert into public.space_object_refs(object_id,owner_kind,owner_id,team_id,category,counted) values
 ('05700000-0000-4000-8000-000000000301','derivative','05700000-0000-4000-8000-0000000001d1','05700000-0000-4000-8000-000000000011','derivative',false);
select is(pg_temp.usage('materials'),'100/1/100','a derivative reference counts nothing');
select throws_ok($$insert into public.space_object_refs(object_id,owner_kind,owner_id,team_id,category,counted) values
 ('05700000-0000-4000-8000-000000000301','derivative','05700000-0000-4000-8000-0000000001d2','05700000-0000-4000-8000-000000000011','materials',true)$$,
 '23514',null,'a derivative reference is never counted');
delete from public.space_object_refs where object_id='05700000-0000-4000-8000-000000000301' and owner_kind='material';
select is(pg_temp.usage('materials')||' '||pg_temp.usage('attachments'),'0/0/0 100/1/0','the last reference decides the category');
insert into public.space_object_refs(object_id,owner_kind,owner_id,team_id,category) values
 ('05700000-0000-4000-8000-000000000302','material','05700000-0000-4000-8000-0000000001b1','05700000-0000-4000-8000-000000000011','trash'),
 ('05700000-0000-4000-8000-000000000302','material','05700000-0000-4000-8000-0000000001b2','05700000-0000-4000-8000-000000000011','versions');
select is(pg_temp.usage('versions')||' '||pg_temp.usage('trash'),'107374182400/1/107374182400 0/0/0','versions outrank trash, bytes exact');
update public.space_object_refs set category='trash' where object_id='05700000-0000-4000-8000-000000000302' and owner_id='05700000-0000-4000-8000-0000000001b2';
select is(pg_temp.usage('versions')||' '||pg_temp.usage('trash'),'0/0/0 107374182400/1/107374182400','a reference that changes category moves the bytes');
select throws_ok($$insert into public.space_object_refs(object_id,owner_kind,owner_id,team_id,category) values
 ('05700000-0000-4000-8000-000000000301','material','05700000-0000-4000-8000-0000000001c1','05700000-0000-4000-8000-000000000012','materials')$$,
 '23503',null,'a reference belongs to the object''s own space');
delete from public.space_objects where id='05700000-0000-4000-8000-000000000302';
select is(pg_temp.usage('trash'),'0/0/0','removing an object removes its bytes once');
select is((select sum(bytes)::bigint from public.space_storage_usage where team_id='05700000-0000-4000-8000-000000000011'),100::bigint,
 'the space total is the sum of distinct referenced objects');
select ok(not exists(select 1 from public.space_storage_usage where bytes<0 or objects<0 or shared_bytes<0 or shared_bytes>bytes),'usage is never negative');

-- 6. Journal ------------------------------------------------------------------------------
select lives_ok($$select public.service_write_space_storage_journal('05700000-0000-4000-8000-0000000000a1',1,'complete','rejected','CHECKSUM_MISMATCH',
 9007199254740993,'05700000-0000-4000-8000-000000000011','explorer','web/1.8.0')$$,'the service writes a journal row');
select throws_ok($$select public.service_write_space_storage_journal('05700000-0000-4000-8000-0000000000a1',1,'upload','ok',null,null,null,null,'web/1.8.0')$$,
 '22023','INVALID_INPUT','an unknown stage is refused');
select is((select bytes from private.space_storage_journal where operation_id='05700000-0000-4000-8000-0000000000a1'),9007199254740993::bigint,'bytes are exact');

select * from finish();
rollback;
