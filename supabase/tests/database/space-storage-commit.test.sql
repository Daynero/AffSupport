begin;
select plan(41);

-- 057 T022: admitting and committing an upload into an R2 space (20261226150000).
-- The commit is one transaction: object, material, reference, usage, signal, derivative
-- backfill job and content_revision. Reservations at the edge of the quota never exceed it.
-- An uncertain reservation is released only by reconciliation.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05722000-0000-4000-8000-000000000001','authenticated','authenticated','owner22@test.invalid','{}','{}'),
 ('05722000-0000-4000-8000-000000000002','authenticated','authenticated','editor22@test.invalid','{}','{}'),
 ('05722000-0000-4000-8000-000000000003','authenticated','authenticated','viewer22@test.invalid','{}','{}');
insert into public.storage_r2_pilots(user_id,max_space_bytes) values
 ('05722000-0000-4000-8000-000000000001',1000),
 ('05722000-0000-4000-8000-000000000002',1000),
 ('05722000-0000-4000-8000-000000000003',1000);

create temporary table seen(label text, value jsonb);
create function pg_temp.team() returns uuid language sql as $$ select (value->>'teamId')::uuid from seen where label='space' $$;
create function pg_temp.root() returns uuid language sql as $$ select (value->>'rootMaterialId')::uuid from seen where label='space' $$;
create function pg_temp.cid(p text) returns text language sql as $$ select repeat(p,64) $$;
create function pg_temp.admit(p_actor uuid, p_key text, p_content text, p_bytes bigint, p_parent uuid default null, p_name text default 'Clip.mp4')
returns jsonb language sql as $$
  select public.service_admit_space_upload(p_actor, jsonb_build_object(
    'teamId', pg_temp.team(), 'parentMaterialId', coalesce(p_parent, pg_temp.root()), 'name', p_name,
    'contentType', 'video/mp4', 'bytes', p_bytes::text, 'contentId', p_content, 'sha256', null,
    'derivatives', '[]'::jsonb, 'ingress', 'explorer', 'idempotencyKey', p_key,
    'category', 'video', 'classificationSource', 'mime', 'fileExtension', 'mp4'))
$$;
-- Stands for the edge function: multipart opened, parts listed, content id recomputed.
create function pg_temp.finish(p_actor uuid, p_upload uuid, p_content text) returns jsonb language plpgsql as $$
begin
  perform public.service_attach_space_upload(p_upload, p_actor, 'r2-upload-' || p_upload::text);
  perform public.service_mark_space_upload_completing(p_upload, pg_temp.team(), p_actor, p_content, repeat('e',32)||'-1');
  return public.service_complete_space_upload(p_upload, pg_temp.team(), p_actor,
    jsonb_build_object('category','video','classificationSource','mime','fileExtension','mp4'));
end $$;
create function pg_temp.used(p_category text default null) returns bigint language sql as $$
  select coalesce(sum(bytes),0)::bigint from public.space_storage_usage
   where team_id=pg_temp.team() and (p_category is null or category=p_category)
$$;

insert into seen select 'space', public.service_create_r2_space('05722000-0000-4000-8000-000000000001','Commit space','commit-space-key-0001');
insert into public.team_members(team_id,user_id,base_role) values
 (pg_temp.team(),'05722000-0000-4000-8000-000000000002','editor'),
 (pg_temp.team(),'05722000-0000-4000-8000-000000000003','viewer');

-- 1. Admit -----------------------------------------------------------------------------------
insert into seen select 'a1', pg_temp.admit('05722000-0000-4000-8000-000000000002','upload-key-00000001',pg_temp.cid('a'),300);
select is((select value->>'kind' from seen where label='a1'),'session','new content opens a session');
select is((select value->>'partCount' from seen where label='a1'),'1','one part for a small file');
select is((select state||':'||bytes from public.space_storage_reservations where operation_id=(select (value->>'uploadId')::uuid from seen where label='a1')),
 'reserved:300','its bytes are reserved');
select is(pg_temp.admit('05722000-0000-4000-8000-000000000002','upload-key-00000001',pg_temp.cid('a'),300)->>'uploadId',
 (select value->>'uploadId' from seen where label='a1'),'the same key returns the same session');
select is(public.service_admit_space_upload('05722000-0000-4000-8000-000000000002', jsonb_build_object('teamId',pg_temp.team(),
 'parentMaterialId',null,'name','Root.mp4','contentType','video/mp4','bytes','0','contentId',pg_temp.cid('9'),'ingress','explorer',
 'idempotencyKey','root-key-000000001'))->>'kind','session','no parent named is the root');
select throws_ok($$select pg_temp.admit('05722000-0000-4000-8000-000000000003','viewer-key-00000001',pg_temp.cid('b'),10)$$,
 '42501','PERMISSION_DENIED','a viewer cannot upload');
select throws_ok($$select pg_temp.admit('05722000-0000-4000-8000-000000000002','big-key-0000000001',pg_temp.cid('b'),107374182401)$$,
 '22023','STORAGE_OBJECT_TOO_LARGE','an object over 100 GiB is refused');
select is(pg_temp.admit('05722000-0000-4000-8000-000000000002','quota-key-00000001',pg_temp.cid('b'),701),
 '{"kind":"quota","needBytes":"701","freeBytes":"700"}'::jsonb,'over the free space: what is needed and what is free');

-- 2. Commit ----------------------------------------------------------------------------------
select throws_ok($$select public.service_complete_space_upload((select (value->>'uploadId')::uuid from seen where label='a1'),pg_temp.team(),
 '05722000-0000-4000-8000-000000000002','{}'::jsonb)$$,'55000','WRONG_STATE','nothing commits before the parts are verified');
select throws_ok($$select public.service_mark_space_upload_completing((select (value->>'uploadId')::uuid from seen where label='a1'),pg_temp.team(),
 '05722000-0000-4000-8000-000000000002',pg_temp.cid('f'),repeat('e',32)||'-1')$$,'55000','CHECKSUM_MISMATCH',
 'parts that make other content are refused');
select is((select content_revision from public.teams where id=pg_temp.team()),0::bigint,'before the commit the space has not changed');
insert into seen select 'c1', pg_temp.finish('05722000-0000-4000-8000-000000000002',(select (value->>'uploadId')::uuid from seen where label='a1'),pg_temp.cid('a'));
select is((select value->>'name'||':'||(value->>'kind')||':'||(value->>'contentId')||':'||(value->>'sizeBytes') from seen where label='c1'),
 'Clip.mp4:file:'||pg_temp.cid('a')||':300','the commit returns the material');
select is((select count(*)::integer from public.space_objects where team_id=pg_temp.team() and content_id=pg_temp.cid('a') and r2_key='t/'||pg_temp.team()||'/o/'||pg_temp.cid('a')),
 1,'one object under its content key');
select is((select category||':'||counted from public.space_object_refs where owner_kind='material' and owner_id=(select (value->>'id')::uuid from seen where label='c1')),
 'materials:true','the material references it');
select is(pg_temp.used('materials'),300::bigint,'usage counts its bytes');
select is((select state from public.space_storage_reservations where operation_id=(select (value->>'uploadId')::uuid from seen where label='a1')),
 'committed','the reservation is settled');
select is((select content_revision from public.teams where id=pg_temp.team()),1::bigint,'content_revision rises once');
-- 20261226360000: admission's reservation already said `usage` in this transaction; the commit
-- adds its content and does not say usage twice.
select is((select array_agg(kind order by id) from public.team_space_storage_signals where team_id=pg_temp.team()),
 array['usage','content'],'the space is signalled');
select is((select reason||':'||state from public.space_derivative_jobs where object_id=(select object_id from public.space_uploads where id=(select (value->>'uploadId')::uuid from seen where label='a1'))),
 'client_skipped:pending_agent','what the client did not make waits for an agent');
select is(pg_temp.finish('05722000-0000-4000-8000-000000000002',(select (value->>'uploadId')::uuid from seen where label='a1'),pg_temp.cid('a'))->>'id',
 (select value->>'id' from seen where label='c1'),'completing again returns the same material');
select is((select count(*)::integer from public.team_materials where team_id=pg_temp.team() and connection_id is null and kind='file'),1,
 'and makes nothing new');
select is(pg_temp.admit('05722000-0000-4000-8000-000000000002','upload-key-00000001',pg_temp.cid('a'),300),
 jsonb_build_object('kind','exists','materialId',(select value->>'id' from seen where label='c1')),'admitting the committed key again says it exists');

-- 3. Same content: no bytes move ------------------------------------------------------------
select is(pg_temp.admit('05722000-0000-4000-8000-000000000002','upload-key-00000002',pg_temp.cid('a'),300),
 jsonb_build_object('kind','exists','materialId',(select value->>'id' from seen where label='c1')),'the same content in the same folder exists');
with f as (insert into public.team_materials(team_id,name,kind,parent_folder_id) values (pg_temp.team(),'Other','folder',pg_temp.root()::text) returning id)
insert into seen select 'folder', jsonb_build_object('id', id) from f;
insert into seen select 'a2', pg_temp.admit('05722000-0000-4000-8000-000000000002','upload-key-00000003',pg_temp.cid('a'),300,
 (select (value->>'id')::uuid from seen where label='folder'),'Copy.mp4');
select is((select value->>'kind' from seen where label='a2'),'exists','in another folder it is linked, not uploaded');
select isnt((select value->>'materialId' from seen where label='a2'),(select value->>'id' from seen where label='c1'),'as a new material');
select is((select space_object_id from public.team_materials where id=(select (value->>'materialId')::uuid from seen where label='a2')),
 (select space_object_id from public.team_materials where id=(select (value->>'id')::uuid from seen where label='c1')),'on the same object');
select is(pg_temp.used()||':'||(select shared_bytes from public.space_storage_usage where team_id=pg_temp.team() and category='materials'),
 '300:300','counted once, shown as shared');
select is(pg_temp.admit('05722000-0000-4000-8000-000000000002','upload-key-00000003',pg_temp.cid('a'),300)->>'materialId',
 (select value->>'materialId' from seen where label='a2'),'a repeated link returns the same material');

-- 4. Quota at the edge (SC-004 for a space) -------------------------------------------------
-- 700 bytes free: of 100 admits of 10 bytes exactly 70 get a session. Admits serialize on the
-- space row (`for no key update` before the sum), so parallel callers meet the same rule.
insert into seen select 'q'||n, pg_temp.admit('05722000-0000-4000-8000-000000000002','quota-edge-key-'||lpad(n::text,4,'0'),
 lpad(to_hex(n),64,'0'),10) from generate_series(1,100) n;
select is((select count(*)::integer from seen where label ~ '^q[0-9]+$' and value->>'kind'='session'),70,'exactly the free space is reserved');
select is((select count(*)::integer from seen where label ~ '^q[0-9]+$' and value->>'kind'='quota'),30,'the rest is told the space is full');
select ok(pg_temp.used()+private.space_reserved_bytes(pg_temp.team())<=private.space_capacity_bytes(pg_temp.team()),'used + reserved never exceeds capacity');
select ok(pg_get_functiondef('public.service_admit_space_upload(uuid,jsonb)'::regprocedure) ~ 'from public\.teams where id = v_team for no key update',
 'admission takes the space row first');

-- 5. Expiry and uncertainty -----------------------------------------------------------------
update public.space_uploads set r2_upload_id='r2-q1' where id=(select (value->>'uploadId')::uuid from seen where label='q1');
update public.space_uploads set expires_at=now()-interval '1 second' where id in
 (select (value->>'uploadId')::uuid from seen where label in ('q1','q2'));
select is(public.service_space_upload_session((select (value->>'uploadId')::uuid from seen where label='q1'),pg_temp.team(),'05722000-0000-4000-8000-000000000002')->>'kind',
 'expired','an expired session says so');
select is((select state from public.space_storage_reservations where operation_id=(select (value->>'uploadId')::uuid from seen where label='q1')),
 'uncertain','with a multipart opened its reservation becomes uncertain');
select is(public.service_space_upload_session((select (value->>'uploadId')::uuid from seen where label='q2'),pg_temp.team(),'05722000-0000-4000-8000-000000000002')->>'kind',
 'expired','an expired session without a multipart');
select is((select state from public.space_storage_reservations where operation_id=(select (value->>'uploadId')::uuid from seen where label='q2')),
 'released','is released at once');
select is(public.service_abort_space_upload((select (value->>'uploadId')::uuid from seen where label='q1'),pg_temp.team(),'05722000-0000-4000-8000-000000000002')->>'aborted',
 'true','aborting the expired one answers');
select is((select state from public.space_storage_reservations where operation_id=(select (value->>'uploadId')::uuid from seen where label='q1')),
 'uncertain','but an uncertain reservation is not released without reconciliation');
select ok(private.space_reserved_bytes(pg_temp.team()) >= 10,'and it still counts against the space');
select throws_ok($$select public.service_mark_space_upload_completing((select (value->>'uploadId')::uuid from seen where label='q1'),pg_temp.team(),
 '05722000-0000-4000-8000-000000000002',lpad(to_hex(1),64,'0'),repeat('e',32)||'-1')$$,'55000','UPLOAD_EXPIRED','an expired session cannot complete');

-- 6. A right that went away -----------------------------------------------------------------
update public.team_members set base_role='viewer' where team_id=pg_temp.team() and user_id='05722000-0000-4000-8000-000000000002';
select throws_ok($$select pg_temp.finish('05722000-0000-4000-8000-000000000002',(select (value->>'uploadId')::uuid from seen where label='q3'),lpad(to_hex(3),64,'0'))$$,
 '42501','PERMISSION_DENIED','a person who lost the upload right between admit and complete is refused');

select * from finish();
rollback;
