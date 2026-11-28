begin;
select plan(17);

-- 057 T034: a tool run in an R2 space (20261226190000). The source is read as an R2 file, the
-- agent's output upload is committed by the upload functions, and the finalize records it as
-- the run's result: a processed_from link, the operation succeeded, the bytes under `process`.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05734000-0000-4000-8000-000000000001','authenticated','authenticated','owner34@test.invalid','{}','{}'),
 ('05734000-0000-4000-8000-000000000002','authenticated','authenticated','editor34@test.invalid','{}','{}'),
 ('05734000-0000-4000-8000-000000000003','authenticated','authenticated','viewer34@test.invalid','{}','{}');
insert into public.storage_r2_pilots(user_id,max_space_bytes) values
 ('05734000-0000-4000-8000-000000000001',10000),
 ('05734000-0000-4000-8000-000000000002',10000),
 ('05734000-0000-4000-8000-000000000003',10000);

create temporary table seen(label text, value jsonb);
create function pg_temp.team() returns uuid language sql as $$ select (value->>'teamId')::uuid from seen where label='space' $$;
create function pg_temp.root() returns uuid language sql as $$ select (value->>'rootMaterialId')::uuid from seen where label='space' $$;
create function pg_temp.cid(p text) returns text language sql as $$ select repeat(p,64) $$;
create function pg_temp.upload(p_actor uuid, p_key text, p_content text, p_bytes bigint, p_name text, p_ingress text)
returns jsonb language plpgsql as $$
declare v_session jsonb; v_upload uuid;
begin
  v_session := public.service_admit_space_upload(p_actor, jsonb_build_object(
    'teamId', pg_temp.team(), 'parentMaterialId', pg_temp.root(), 'name', p_name,
    'contentType', 'video/mp4', 'bytes', p_bytes::text, 'contentId', p_content, 'sha256', null,
    'ingress', p_ingress, 'idempotencyKey', p_key,
    'category', 'video', 'classificationSource', 'mime', 'fileExtension', 'mp4'));
  v_upload := (v_session->>'uploadId')::uuid;
  perform public.service_attach_space_upload(v_upload, p_actor, 'r2-upload-' || v_upload::text);
  perform public.service_mark_space_upload_completing(v_upload, pg_temp.team(), p_actor, p_content, repeat('e',32)||'-1');
  return public.service_complete_space_upload(v_upload, pg_temp.team(), p_actor,
    jsonb_build_object('category','video','classificationSource','mime','fileExtension','mp4'))
    || jsonb_build_object('uploadId', v_upload);
end $$;

insert into seen select 'space', public.service_create_r2_space('05734000-0000-4000-8000-000000000001','Process space','process-space-key-01');
insert into public.team_members(team_id,user_id,base_role) values
 (pg_temp.team(),'05734000-0000-4000-8000-000000000002','editor'),
 (pg_temp.team(),'05734000-0000-4000-8000-000000000003','viewer');
insert into seen select 'source', pg_temp.upload('05734000-0000-4000-8000-000000000002','source-key-00000001',pg_temp.cid('a'),400,'Clip.mp4','explorer');

-- 1. The source -------------------------------------------------------------------------------
insert into seen select 'facts', public.service_space_process_source(pg_temp.team(),(select (value->>'id')::uuid from seen where label='source'),
 null,'05734000-0000-4000-8000-000000000002');
select is((select value->>'contentId'||':'||(value->>'sizeBytes')||':'||(value->>'category') from seen where label='facts'),
 pg_temp.cid('a')||':400:video','the source is the R2 object with its content id and size');
select is((select (value->>'destinationFolderId')::uuid from seen where label='facts'),pg_temp.root(),'no destination named is the root');
select is((select value->'childNames' from seen where label='facts'),'["Clip.mp4"]'::jsonb,'the names already in the destination');
select throws_ok($$select public.service_space_process_source(pg_temp.team(),(select (value->>'id')::uuid from seen where label='source'),
 null,'05734000-0000-4000-8000-000000000003')$$,'42501','PERMISSION_DENIED','a viewer cannot run a tool');
select throws_ok($$select public.service_space_process_source(pg_temp.team(),'05734000-0000-4000-8000-0000000000ff',
 null,'05734000-0000-4000-8000-000000000002')$$,'P0002','NOT_FOUND','an unknown source is not found');

-- A Drive space is never answered here.
insert into public.teams(id,name,owner_id) values
 ('05734000-0000-4000-8000-000000000d01','Drive space','05734000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('05734000-0000-4000-8000-000000000d01','05734000-0000-4000-8000-000000000001','admin')
 on conflict do nothing;
select throws_ok($$select public.service_space_process_source('05734000-0000-4000-8000-000000000d01',
 (select (value->>'id')::uuid from seen where label='source'),null,'05734000-0000-4000-8000-000000000001')$$,
 '55000','STORAGE_BACKEND_MISMATCH','a Drive space is refused');

-- 2. The operation, as /process/start opens it ------------------------------------------------
insert into seen select 'op', to_jsonb(op) from public.service_start_team_operation(pg_temp.team(),'05734000-0000-4000-8000-000000000002',
 'process','process-run-key-0001','request:process-run-key-0001',(select (value->>'id')::uuid from seen where label='source'),
 pg_temp.root(),'clip-compressed.mp4',now()+interval '30 minutes',400) op;
select public.service_set_team_operation_intent((select (value->>'operation_id')::uuid from seen where label='op'),
 '05734000-0000-4000-8000-000000000002','Clip-compressed.mp4','video/mp4',null,null,null,'compressor',3);
select public.service_transition_team_operation((select (value->>'operation_id')::uuid from seen where label='op'),
 'running','awaiting_agent',0,null,null,false);

select is(public.service_space_process_upload((select (value->>'operation_id')::uuid from seen where label='op'),
 '05734000-0000-4000-8000-000000000002')->>'uploadId',null,'before the output starts there is no upload');

-- 3. The output -------------------------------------------------------------------------------
insert into seen select 'output', pg_temp.upload('05734000-0000-4000-8000-000000000002',
 'process_output_'||(select value->>'operation_id' from seen where label='op'),pg_temp.cid('b'),150,'Clip-compressed.mp4','agent_output');
select is(public.service_space_process_upload((select (value->>'operation_id')::uuid from seen where label='op'),
 '05734000-0000-4000-8000-000000000002')->>'uploadState','committed','the operation names its output upload');

select throws_ok($$select public.service_finalize_space_process_output((select (value->>'operation_id')::uuid from seen where label='op'),
 '05734000-0000-4000-8000-000000000002',(select (value->>'uploadId')::uuid from seen where label='source'))$$,
 'P0002','NOT_FOUND','an upload that is not this operation''s output is not its result');

insert into seen select 'final', public.service_finalize_space_process_output((select (value->>'operation_id')::uuid from seen where label='op'),
 '05734000-0000-4000-8000-000000000002',(select (value->>'uploadId')::uuid from seen where label='output'));
select is((select value->>'state'||':'||(value->>'reused') from seen where label='final'),'succeeded:false','the run succeeded');
select is((select (value->>'materialId')::uuid from seen where label='final'),(select (value->>'id')::uuid from seen where label='output'),
 'its result is the output material');
select is((select relation||':'||tool_id||':'||source_name_snapshot from public.team_material_links
 where derivative_material_id=(select (value->>'id')::uuid from seen where label='output')),
 'processed_from:compressor:Clip.mp4','the output is processed_from its source');
select is((select category from public.space_object_refs where owner_kind='material'
 and owner_id=(select (value->>'id')::uuid from seen where label='output')),'process','its reference counts under process');
select is((select bytes from public.space_storage_usage where team_id=pg_temp.team() and category='process'),150::bigint,
 'the ledger has its bytes under process');
select is((select state||':'||(reservation_released_at is not null) from public.team_operations
 where id=(select (value->>'operation_id')::uuid from seen where label='op')),'succeeded:true','the name reservation is released');

-- 4. Repeats ----------------------------------------------------------------------------------
select is(public.service_finalize_space_process_output((select (value->>'operation_id')::uuid from seen where label='op'),
 '05734000-0000-4000-8000-000000000002',(select (value->>'uploadId')::uuid from seen where label='output'))->>'reused',
 'true','a repeated finalize returns the same result');
select is((select count(*)::integer from public.team_material_links
 where derivative_material_id=(select (value->>'id')::uuid from seen where label='output')),1,'and links it once');

select * from finish();
rollback;
