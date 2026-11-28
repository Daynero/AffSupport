begin;
select plan(37);

-- 057 T024: rename, move, create_folder, copy, trash and restore in an R2 space, and emptying
-- the trash (20261226160000). Revisions guard every change, the tree has no cycles, roles
-- decide, and emptying the trash queues the bytes for deletion at once.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05724000-0000-4000-8000-000000000001','authenticated','authenticated','owner24@test.invalid','{}','{}'),
 ('05724000-0000-4000-8000-000000000002','authenticated','authenticated','editor24@test.invalid','{}','{}'),
 ('05724000-0000-4000-8000-000000000003','authenticated','authenticated','viewer24@test.invalid','{}','{}');
insert into public.storage_r2_pilots(user_id,max_space_bytes) values
 ('05724000-0000-4000-8000-000000000001',100000),('05724000-0000-4000-8000-000000000002',100000),
 ('05724000-0000-4000-8000-000000000003',100000);

create temporary table seen(label text, value jsonb);
create function pg_temp.team() returns uuid language sql as $$ select (value->>'teamId')::uuid from seen where label='space' $$;
create function pg_temp.root() returns uuid language sql as $$ select (value->>'rootMaterialId')::uuid from seen where label='space' $$;
create function pg_temp.id(p text) returns uuid language sql as $$ select (value->'materials'->0->>'id')::uuid from seen where label=p $$;
create function pg_temp.mutate(p_actor uuid, p jsonb) returns jsonb language sql as $$
  select public.service_mutate_space_materials(p_actor, pg_temp.team(), p) $$;
create function pg_temp.editor() returns uuid language sql as $$ select '05724000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.upload(p_key text, p_content text, p_bytes bigint, p_parent uuid) returns uuid language plpgsql as $$
declare a jsonb;
begin
  a := public.service_admit_space_upload(pg_temp.editor(), jsonb_build_object('teamId',pg_temp.team(),'parentMaterialId',p_parent,
    'name','File '||p_key,'contentType','image/png','bytes',p_bytes::text,'contentId',p_content,'ingress','explorer',
    'idempotencyKey','mutate-key-'||p_key||'-0000','category','image','classificationSource','mime','fileExtension','png'));
  perform public.service_attach_space_upload((a->>'uploadId')::uuid, pg_temp.editor(), 'r2-'||p_key);
  perform public.service_mark_space_upload_completing((a->>'uploadId')::uuid, pg_temp.team(), pg_temp.editor(), p_content, repeat('e',32)||'-1');
  return (public.service_complete_space_upload((a->>'uploadId')::uuid, pg_temp.team(), pg_temp.editor(), '{}'::jsonb)->>'id')::uuid;
end $$;

insert into seen select 'space', public.service_create_r2_space('05724000-0000-4000-8000-000000000001','Mutate space','mutate-space-key-0001');
insert into public.team_members(team_id,user_id,base_role) values
 (pg_temp.team(),pg_temp.editor(),'editor'),(pg_temp.team(),'05724000-0000-4000-8000-000000000003','viewer');

-- 1. Folders --------------------------------------------------------------------------------
insert into seen select 'a', pg_temp.mutate(pg_temp.editor(), jsonb_build_object('action','create_folder','name','A','parentMaterialId',null));
select is((select (value->>'created')||':'||(value->'materials'->0->>'kind')||':'||(value->'materials'->0->>'parentMaterialId') from seen where label='a'),
 'true:folder:'||pg_temp.root(),'a folder is made in the root');
insert into seen select 'b', pg_temp.mutate(pg_temp.editor(), jsonb_build_object('action','create_folder','name','B','parentMaterialId',pg_temp.id('a')));
select is(pg_temp.mutate(pg_temp.editor(), jsonb_build_object('action','create_folder','name','A','ensure',true))->'materials'->0->>'id',
 pg_temp.id('a')::text,'ensure returns the folder that is there');
select is(pg_temp.mutate(pg_temp.editor(), jsonb_build_object('action','create_folder','name','A','ensure',true))->>'created',
 'false','and says it made nothing');
select throws_ok($$select pg_temp.mutate('05724000-0000-4000-8000-000000000003', jsonb_build_object('action','create_folder','name','C'))$$,
 '42501','PERMISSION_DENIED','a viewer cannot make folders');
select throws_ok($$select pg_temp.mutate(pg_temp.editor(), jsonb_build_object('action','create_folder','name','x/y'))$$,
 '22023','INVALID_INPUT','a slash is not a name');

-- 2. Rename and revisions --------------------------------------------------------------------
insert into seen select 'f1', jsonb_build_object('materials', jsonb_build_array(jsonb_build_object('id', pg_temp.upload('f1',repeat('1',64),100,pg_temp.id('b')))));
select is(pg_temp.mutate(pg_temp.editor(), jsonb_build_object('action','rename','materialIds',jsonb_build_array(pg_temp.id('f1')),'name','  Renamed.png ',
 'expectedRevisions',jsonb_build_object(pg_temp.id('f1'),'0')))->'materials'->0->>'name','Renamed.png','a rename with the current revision applies');
select is((select material_revision from public.team_materials where id=pg_temp.id('f1')),1::bigint,'and raises the revision');
select is(pg_temp.mutate(pg_temp.editor(), jsonb_build_object('action','rename','materialIds',jsonb_build_array(pg_temp.id('f1')),'name','Stale.png',
 'expectedRevisions',jsonb_build_object(pg_temp.id('f1'),'0'))),
 jsonb_build_object('kind','conflict','materialId',pg_temp.id('f1'),'currentRevision','1'),'a stale revision answers the current one');
select is((select name from public.team_materials where id=pg_temp.id('f1')),'Renamed.png','and changes nothing');
select throws_ok($$select pg_temp.mutate(pg_temp.editor(), jsonb_build_object('action','rename','materialIds',jsonb_build_array(pg_temp.root()),'name','X'))$$,
 '22023','INVALID_INPUT','the root is not renamed');
select throws_ok($$select pg_temp.mutate('05724000-0000-4000-8000-000000000003', jsonb_build_object('action','rename','materialIds',jsonb_build_array(pg_temp.id('f1')),'name','X'))$$,
 '42501','PERMISSION_DENIED','a viewer cannot rename');

-- 3. Move and cycles -------------------------------------------------------------------------
select is(pg_temp.mutate(pg_temp.editor(), jsonb_build_object('action','move','materialIds',jsonb_build_array(pg_temp.id('f1')),'targetFolderId',pg_temp.id('a')))
 ->'materials'->0->>'parentMaterialId',pg_temp.id('a')::text,'a file moves by its row');
select is(pg_temp.mutate(pg_temp.editor(), jsonb_build_object('action','move','materialIds',jsonb_build_array(pg_temp.id('f1')),'targetFolderId',null))
 ->'materials'->0->>'parentMaterialId',pg_temp.root()::text,'no target named is the root');
select pg_temp.mutate(pg_temp.editor(), jsonb_build_object('action','move','materialIds',jsonb_build_array(pg_temp.id('f1')),'targetFolderId',pg_temp.id('a')));
select is((select r2_key from public.space_objects where id=(select space_object_id from public.team_materials where id=pg_temp.id('f1'))),
 't/'||pg_temp.team()||'/o/'||repeat('1',64),'its bytes and address stay');
select throws_ok($$select pg_temp.mutate(pg_temp.editor(), jsonb_build_object('action','move','materialIds',jsonb_build_array(pg_temp.id('a')),'targetFolderId',pg_temp.id('b')))$$,
 '22023','INVALID_INPUT','a folder cannot move into its own child');
select throws_ok($$select pg_temp.mutate(pg_temp.editor(), jsonb_build_object('action','move','materialIds',jsonb_build_array(pg_temp.id('a')),'targetFolderId',pg_temp.id('a')))$$,
 '22023','INVALID_INPUT','nor into itself');
insert into seen select 'other', public.service_create_r2_space('05724000-0000-4000-8000-000000000001','Other space','mutate-space-key-0002');
select throws_ok(format($$select pg_temp.mutate(pg_temp.editor(), jsonb_build_object('action','move','materialIds',jsonb_build_array(pg_temp.id('f1')),'targetFolderId','%s'))$$,
 (select value->>'rootMaterialId' from seen where label='other')),'P0002','NOT_FOUND','a folder of another space is not a target');

-- 4. Copy: a reference, not bytes ------------------------------------------------------------
insert into seen select 'copy', pg_temp.mutate(pg_temp.editor(), jsonb_build_object('action','copy','materialIds',jsonb_build_array(pg_temp.id('f1')),'targetFolderId',pg_temp.id('b')));
select isnt(pg_temp.id('copy'),pg_temp.id('f1'),'a copy is a new material');
select is((select space_object_id from public.team_materials where id=pg_temp.id('copy')),(select space_object_id from public.team_materials where id=pg_temp.id('f1')),
 'on the same object');
select is((select count(*)::integer from public.space_objects where team_id=pg_temp.team()),1,'no bytes were copied');
select is((select bytes||':'||shared_bytes from public.space_storage_usage where team_id=pg_temp.team() and category='materials'),'100:100',
 'counted once and shown as shared');

select is((select jsonb_agg(m->>'contentId') from jsonb_array_elements(public.service_read_space_materials(
   '05724000-0000-4000-8000-000000000003', pg_temp.team(), array[pg_temp.id('copy'), gen_random_uuid()])) m),
 jsonb_build_array(repeat('1',64)),'a viewer reads the snapshot a files-host address needs; unknown ids are left out');
select throws_ok(format($$select public.service_read_space_materials('05724000-0000-4000-8000-000000000003','%s',array['%s'::uuid])$$,
 (select value->>'teamId' from seen where label='other'), pg_temp.id('copy')),'42501','PERMISSION_DENIED','not in a space they are not in');

-- 5. Trash and restore of a subtree ----------------------------------------------------------
select throws_ok($$select pg_temp.mutate(pg_temp.editor(), jsonb_build_object('action','trash','materialIds',jsonb_build_array(pg_temp.id('a'))))$$,
 '42501','PERMISSION_DENIED','an editor may not delete');
update public.team_members set base_role='admin' where team_id=pg_temp.team() and user_id=pg_temp.editor();
select pg_temp.mutate(pg_temp.editor(), jsonb_build_object('action','trash','materialIds',jsonb_build_array(pg_temp.id('a'))));
select is((select array_agg(lifecycle||':'||coalesce(folder_trash_root::text,'-') order by name) from public.team_materials
  where id in (pg_temp.id('a'),pg_temp.id('b'),pg_temp.id('f1'),pg_temp.id('copy'))),
 array['trashed:-','trashed:'||pg_temp.id('a'),'trashed:'||pg_temp.id('a'),'trashed:'||pg_temp.id('a')],'trashing a folder takes its subtree');
select is((select string_agg(category||'='||bytes, ',' order by category) from public.space_storage_usage where team_id=pg_temp.team() and bytes>0),
 'trash=100','its bytes count as trash');
select pg_temp.mutate(pg_temp.editor(), jsonb_build_object('action','restore','materialIds',jsonb_build_array(pg_temp.id('a'))));
select is((select count(*)::integer from public.team_materials where id in (pg_temp.id('a'),pg_temp.id('b'),pg_temp.id('f1'),pg_temp.id('copy')) and lifecycle='active'),
 4,'restoring the folder brings the subtree back');
select is((select string_agg(category||'='||bytes, ',' order by category) from public.space_storage_usage where team_id=pg_temp.team() and bytes>0),
 'materials=100','and its bytes count as materials again');

-- 6. Emptying the trash ----------------------------------------------------------------------
select pg_temp.mutate(pg_temp.editor(), jsonb_build_object('action','trash','materialIds',jsonb_build_array(pg_temp.id('copy'))));
insert into seen select 'empty1', public.service_empty_space_trash(pg_temp.editor(), pg_temp.team(), null);
select is((select (value->>'deleted')||':'||(value->>'purgesQueued') from seen where label='empty1'),'1:0',
 'a copy whose object is still used elsewhere goes, its bytes stay');
select is((select state from public.space_objects where team_id=pg_temp.team()),'committed','the object lives on');
select pg_temp.mutate(pg_temp.editor(), jsonb_build_object('action','trash','materialIds',jsonb_build_array(pg_temp.id('a'))));
insert into seen select 'empty2', public.service_empty_space_trash(pg_temp.editor(), pg_temp.team(), null);
select is((select (value->>'deleted')||':'||(value->>'purgesQueued') from seen where label='empty2'),'3:1',
 'the folder, its child folder and the last file go; the object is queued');
select is((select reason||':'||state||':'||(due_at<=now()) from public.space_object_purges where team_id=pg_temp.team()),'trash_emptied:due:true',
 'for deletion at once');
select is((select state from public.space_objects where team_id=pg_temp.team()),'purge_pending','the object waits for the sweeper');
select is((select coalesce(sum(bytes),0)::bigint from public.space_storage_usage where team_id=pg_temp.team()),0::bigint,'the meter is free again');
select is(public.service_admit_space_upload(pg_temp.editor(), jsonb_build_object('teamId',pg_temp.team(),'parentMaterialId',pg_temp.root(),
    'name','Again.png','contentType','image/png','bytes','100','contentId',repeat('1',64),'ingress','explorer',
    'idempotencyKey','mutate-key-again-00000'))->>'kind','exists','the same bytes coming back before deletion are used again');
select is((select count(*)::integer from public.space_object_purges where team_id=pg_temp.team()),0,'and the deletion is withdrawn');
select throws_ok($$select public.service_empty_space_trash('05724000-0000-4000-8000-000000000003', pg_temp.team(), null)$$,
 '42501','PERMISSION_DENIED','a viewer cannot empty the trash');

select * from finish();
rollback;
