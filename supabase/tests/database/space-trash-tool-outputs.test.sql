begin;
select plan(12);

-- 057 T108 (20261226270000): «Очистити кошик» frees a tool's output at once in an R2 space
-- (US10, FR-048). The output's provenance (`processed_from`) went with nothing before: the link
-- restricted the delete, so the output stayed in the trash for good. Now the link is the output's
-- own and leaves with it; its source keeps working and keeps its bytes; the output's object is
-- purged once nothing else refers to it. A source emptied from the trash leaves its outputs as
-- ordinary files. A link of any other kind still keeps a material in the trash.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05791080-0000-4000-8000-000000000001','authenticated','authenticated','trash-owner@test.invalid','{}','{}');
insert into public.storage_r2_pilots(user_id,max_space_bytes) values ('05791080-0000-4000-8000-000000000001',100000);

create temporary table seen(label text, value jsonb);
create function pg_temp.team() returns uuid language sql as $$ select (value->>'teamId')::uuid from seen where label='space' $$;
create function pg_temp.root() returns uuid language sql as $$ select (value->>'rootMaterialId')::uuid from seen where label='space' $$;
create function pg_temp.v(p_label text) returns jsonb language sql as $$ select value from seen where label=p_label order by ctid desc limit 1 $$;
create function pg_temp.owner() returns uuid language sql as $$ select '05791080-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.id(p_label text) returns uuid language sql as $$ select (pg_temp.v(p_label)->>'id')::uuid $$;
create function pg_temp.upload(p_key text, p_content text, p_bytes bigint, p_name text, p_ingress text)
returns jsonb language plpgsql as $$
declare v_session jsonb; v_upload uuid;
begin
  v_session := public.service_admit_space_upload(pg_temp.owner(), jsonb_build_object(
    'teamId', pg_temp.team(), 'parentMaterialId', pg_temp.root(), 'name', p_name,
    'contentType', 'video/mp4', 'bytes', p_bytes::text, 'contentId', p_content, 'sha256', null,
    'ingress', p_ingress, 'idempotencyKey', p_key,
    'category', 'video', 'classificationSource', 'mime', 'fileExtension', 'mp4'));
  v_upload := (v_session->>'uploadId')::uuid;
  perform public.service_attach_space_upload(v_upload, pg_temp.owner(), 'r2-upload-' || v_upload::text);
  perform public.service_mark_space_upload_completing(v_upload, pg_temp.team(), pg_temp.owner(), p_content, repeat('e',32)||'-1');
  return public.service_complete_space_upload(v_upload, pg_temp.team(), pg_temp.owner(),
    jsonb_build_object('category','video','classificationSource','mime','fileExtension','mp4'))
    || jsonb_build_object('uploadId', v_upload);
end $$;
-- One tool run of the space: the source is compressed into an output beside it.
create function pg_temp.run(p_source uuid, p_key text, p_content text, p_label text) returns void language plpgsql as $$
declare v_op uuid; v_output jsonb;
begin
  select operation_id into v_op from public.service_start_team_operation(pg_temp.team(), pg_temp.owner(), 'process',
    p_key, 'request:'||p_key, p_source, pg_temp.root(), 'out-'||p_key, now()+interval '30 minutes', 400);
  perform public.service_set_team_operation_intent(v_op, pg_temp.owner(), 'Clip '||p_key||'.mp4', 'video/mp4', null, null, null, 'compressor', 3);
  perform public.service_transition_team_operation(v_op, 'running', 'awaiting_agent', 0, null, null, false);
  v_output := pg_temp.upload('process_output_'||v_op::text, p_content, 150, 'Clip '||p_key||'.mp4', 'agent_output');
  perform public.service_finalize_space_process_output(v_op, pg_temp.owner(), (v_output->>'uploadId')::uuid);
  insert into seen values (p_label, v_output);
end $$;
create function pg_temp.trash(p_id uuid) returns void language sql as $$
  select public.service_mutate_space_materials(pg_temp.owner(), pg_temp.team(),
    jsonb_build_object('action','trash','materialIds',jsonb_build_array(p_id)));
$$;
create function pg_temp.category(p_id uuid) returns text language sql as $$ select private.space_material_category(p_id) $$;
create function pg_temp.due(p_id uuid) returns boolean language sql as $$
  select exists (select 1 from public.space_object_purges p
    where p.team_id = pg_temp.team() and p.state = 'due'
      and p.object_id = (select object_id from seen s, lateral (select (s.value->>'objectId')::uuid as object_id) o where s.label = 'object:'||p_id::text))
$$;

insert into seen select 'space', public.service_create_r2_space(pg_temp.owner(),'Trash space','trash-space-key-1');
insert into seen select 'source', pg_temp.upload('trash-source-key-0001', repeat('a',64), 400, 'Clip.mp4', 'explorer');
select pg_temp.run(pg_temp.id('source'), 'compress-1', repeat('b',64), 'output');
insert into seen select 'object:'||pg_temp.id('output')::text,
 jsonb_build_object('objectId', (select space_object_id from public.team_materials where id = pg_temp.id('output')));
insert into seen select 'object:'||pg_temp.id('source')::text,
 jsonb_build_object('objectId', (select space_object_id from public.team_materials where id = pg_temp.id('source')));
select is(pg_temp.category(pg_temp.id('output')), 'process', 'a tool''s output counts under process');

-- 1. Emptying an output --------------------------------------------------------------------------
select pg_temp.trash(pg_temp.id('output'));
insert into seen select 'emptied', public.service_empty_space_trash(pg_temp.owner(), pg_temp.team(), array[pg_temp.id('output')]);
select is((pg_temp.v('emptied')->>'deleted')::integer, 1, 'the output leaves the trash for good');
select ok(not exists(select 1 from public.team_materials where id = pg_temp.id('output')), 'its row is gone');
select ok(not exists(select 1 from public.team_material_links where derivative_material_id = pg_temp.id('output')),
 'its provenance went with it');
select ok(pg_temp.due(pg_temp.id('output')), 'its object is due for purge at once');
select is((select lifecycle from public.team_materials where id = pg_temp.id('source')), 'active', 'the source keeps working');
select ok(not pg_temp.due(pg_temp.id('source')), 'and keeps its object');

-- 2. Emptying a source whose output stays ---------------------------------------------------------
select pg_temp.run(pg_temp.id('source'), 'compress-2', repeat('c',64), 'output2');
select pg_temp.trash(pg_temp.id('source'));
insert into seen select 'emptied2', public.service_empty_space_trash(pg_temp.owner(), pg_temp.team(), array[pg_temp.id('source')]);
select is((pg_temp.v('emptied2')->>'deleted')::integer, 1, 'a source with an output leaves the trash too');
select ok(pg_temp.due(pg_temp.id('source')), 'its object is due for purge');
select is((select lifecycle from public.team_materials where id = pg_temp.id('output2')), 'active', 'its output stays a file of the space');
select is(pg_temp.category(pg_temp.id('output2')), 'materials', 'now counted as an ordinary file, once');

-- 3. Any other link still holds ----------------------------------------------------------------
insert into seen select 'held', pg_temp.upload('trash-held-key-00001', repeat('d',64), 100, 'Held.mp4', 'explorer');
insert into public.team_material_links(team_id, source_material_id, derivative_material_id, relation, source_name_snapshot, created_by)
values (pg_temp.team(), pg_temp.id('held'), pg_temp.id('output2'), 'version_of', 'Held.mp4', pg_temp.owner());
select pg_temp.trash(pg_temp.id('held'));
select is((public.service_empty_space_trash(pg_temp.owner(), pg_temp.team(), array[pg_temp.id('held')])->>'deleted')::integer, 0,
 'a link of another kind keeps the material in the trash');

select * from finish();
rollback;
