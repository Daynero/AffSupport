begin;
select plan(41);

-- 057 T091 (20261226250000): re-stitched variations of a catalog in an R2 space. The set is
-- admitted once per creation intent; each variation is a tool run of the space opened under its
-- own key and bound by CAS; its output is registered by the run's finalize and counts under
-- `catalogs`; the link binds the set and makes the catalog its copies' user, with no copy of the
-- original; deleting the catalog for good deletes the outputs and purges their objects at once.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05791000-0000-4000-8000-000000000001','authenticated','authenticated','variants-owner@test.invalid','{}','{}'),
 ('05791000-0000-4000-8000-000000000002','authenticated','authenticated','variants-editor@test.invalid','{}','{}');
insert into public.storage_r2_pilots(user_id,max_space_bytes) values
 ('05791000-0000-4000-8000-000000000001',100000),('05791000-0000-4000-8000-000000000002',100000);

create temporary table seen(label text, value jsonb);
create function pg_temp.team() returns uuid language sql as $$ select (value->>'teamId')::uuid from seen where label='space' $$;
create function pg_temp.root() returns uuid language sql as $$ select (value->>'rootMaterialId')::uuid from seen where label='space' $$;
create function pg_temp.v(p_label text) returns jsonb language sql as $$ select value from seen where label=p_label $$;
create function pg_temp.owner() returns uuid language sql as $$ select '05791000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.upload(p_key text, p_content text, p_bytes bigint, p_name text, p_ingress text, p_parent uuid)
returns jsonb language plpgsql as $$
declare v_session jsonb; v_upload uuid;
begin
  v_session := public.service_admit_space_upload(pg_temp.owner(), jsonb_build_object(
    'teamId', pg_temp.team(), 'parentMaterialId', p_parent, 'name', p_name,
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
-- A variation's run, opened and bound as `/catalog-variants/run` does, then made by «the agent».
create function pg_temp.open_run(p_set uuid, p_index integer, p_label text) returns uuid language plpgsql as $$
declare v_claim jsonb; v_op uuid;
begin
  v_claim := public.service_space_catalog_variant_run(pg_temp.team(), pg_temp.owner(), p_set, p_index);
  select operation_id into v_op from public.service_start_team_operation(pg_temp.team(), pg_temp.owner(), 'process',
    'space-variant:'||(v_claim->>'requestId')||':'||(v_claim->>'attempt'),
    'request:space-variant:'||(v_claim->>'requestId')||':'||(v_claim->>'attempt'),
    (v_claim->>'sourceMaterialId')::uuid, pg_temp.root(), 'clip restitched '||p_index||' '||(v_claim->>'attempt')||'.mp4',
    now()+interval '30 minutes', 400);
  perform public.service_set_team_operation_intent(v_op, pg_temp.owner(), 'Clip restitched.mp4', 'video/mp4', null, null, null, 'restitch', 2);
  perform public.service_transition_team_operation(v_op, 'running', 'awaiting_agent', 0, null, null, false);
  insert into seen values (p_label, public.service_bind_space_catalog_variant_run(pg_temp.team(), pg_temp.owner(), p_set, p_index,
    (v_claim->>'attempt')::integer, v_op));
  return v_op;
end $$;
create function pg_temp.finish_run(p_op uuid, p_content text, p_label text) returns jsonb language plpgsql as $$
declare v_output jsonb;
begin
  v_output := pg_temp.upload('process_output_'||p_op::text, p_content, 150, 'Clip restitched.mp4', 'agent_output', pg_temp.root());
  insert into seen values (p_label, v_output);
  return public.service_finalize_space_process_output(p_op, pg_temp.owner(), (v_output->>'uploadId')::uuid);
end $$;

insert into seen select 'space', public.service_create_r2_space(pg_temp.owner(),'Variations space','variations-space-key-1');
insert into public.team_members(team_id,user_id,base_role) values (pg_temp.team(),'05791000-0000-4000-8000-000000000002','editor');
insert into seen select 'source', pg_temp.upload('variations-source-01', repeat('a',64), 400, 'Clip.mp4', 'explorer', pg_temp.root());
update private.catalog_video_r2_config set enabled=true, public_origin='https://videos.test', policy_confirmed_at=now();

insert into private.catalog_generation_intents(id,team_id,video_material_id,actor_id,request_key,request_digest,request_payload,variant) values
 ('05791000-0000-4000-8000-0000000000a1',pg_temp.team(),(pg_temp.v('source')->>'id')::uuid,pg_temp.owner(),
  'product-catalog:05791000-0000-4000-8000-0000000000a1','d1','{"catalogVideoProtocolVersion":1,"restitchEnabled":true}',1),
 ('05791000-0000-4000-8000-0000000000a2',pg_temp.team(),(pg_temp.v('source')->>'id')::uuid,pg_temp.owner(),
  'product-catalog:05791000-0000-4000-8000-0000000000a2','d2','{"catalogVideoProtocolVersion":1,"restitchEnabled":true}',2),
 ('05791000-0000-4000-8000-0000000000a3',pg_temp.team(),(pg_temp.v('source')->>'id')::uuid,pg_temp.owner(),
  'product-catalog:05791000-0000-4000-8000-0000000000a3','d3','{"catalogVideoProtocolVersion":1,"restitchEnabled":false}',3);

-- 1. Settings and admission -----------------------------------------------------------------
insert into seen select 'defaults', public.service_space_catalog_variant_defaults(pg_temp.team(), pg_temp.owner());
select ok((pg_temp.v('defaults')->>'configured')::boolean, 'the member''s effective settings make a file out of the box');
insert into seen select 'admitted', public.service_admit_space_catalog_variants(pg_temp.team(), pg_temp.owner(),
 '05791000-0000-4000-8000-0000000000a1','05791000-0000-4000-8000-0000000000b1',(pg_temp.v('source')->>'id')::uuid,
 array['05791000-0000-4000-8000-0000000000c0','05791000-0000-4000-8000-0000000000c1']::uuid[],
 pg_temp.v('defaults'), repeat('d',64));
select is(pg_temp.v('admitted')->>'state'||':'||(pg_temp.v('admitted')->>'requestedCount')||':'||(pg_temp.v('admitted')->>'registeredCount'),
 'preparing:2:0','a new set of two variations, none made');
select is((select source_content_id from private.space_catalog_variant_sets where id='05791000-0000-4000-8000-0000000000b1'),
 repeat('a',64),'the set freezes the source''s content id');
select is(public.service_admit_space_catalog_variants(pg_temp.team(), pg_temp.owner(),
 '05791000-0000-4000-8000-0000000000a1','05791000-0000-4000-8000-0000000000b1',(pg_temp.v('source')->>'id')::uuid,
 array['05791000-0000-4000-8000-0000000000c0','05791000-0000-4000-8000-0000000000c1']::uuid[], null, null)->>'setId',
 '05791000-0000-4000-8000-0000000000b1','a resumed creation admits the same set again, without settings');
select throws_ok($$select public.service_admit_space_catalog_variants(pg_temp.team(), pg_temp.owner(),
 '05791000-0000-4000-8000-0000000000a1','05791000-0000-4000-8000-0000000000b1',(pg_temp.v('source')->>'id')::uuid,
 array['05791000-0000-4000-8000-0000000000c0']::uuid[], null, null)$$,'PROCESS_RESULT_UNCERTAIN','a different plan for the same intent is refused');
select throws_ok($$select public.service_admit_space_catalog_variants(pg_temp.team(), pg_temp.owner(),
 '05791000-0000-4000-8000-0000000000a2','05791000-0000-4000-8000-0000000000b2',(pg_temp.v('source')->>'id')::uuid,
 array['05791000-0000-4000-8000-0000000000c5']::uuid[], null, null)$$,'RESTITCH_INVALID','a new set needs settings that make a file');
select throws_ok($$select public.service_admit_space_catalog_variants(pg_temp.team(), pg_temp.owner(),
 '05791000-0000-4000-8000-0000000000a3','05791000-0000-4000-8000-0000000000b3',(pg_temp.v('source')->>'id')::uuid,
 array['05791000-0000-4000-8000-0000000000c6']::uuid[], pg_temp.v('defaults'), repeat('d',64))$$,
 'WRONG_STATE','an intent without re-stitching has no set');
select ok(exists(select 1 from pg_trigger where tgname='task_cleanup_reference_fence'
 and tgrelid='private.space_catalog_variant_sets'::regclass)
 and exists(select 1 from pg_trigger where tgname='task_cleanup_reference_fence'
 and tgrelid='private.space_catalog_variants'::regclass),'both tables take part in the cleanup fence');

-- 2. Handing a variation over -------------------------------------------------------------
insert into seen select 'claim0', public.service_space_catalog_variant_run(pg_temp.team(), pg_temp.owner(),'05791000-0000-4000-8000-0000000000b1',0);
select is(pg_temp.v('claim0')->>'state'||':'||(pg_temp.v('claim0')->>'attempt')||':'||(pg_temp.v('claim0')->>'requestId'),
 'open:1:05791000-0000-4000-8000-0000000000c0','the first variation needs its first run');
select is(pg_temp.v('claim0')->'settings', pg_temp.v('defaults'),'with the settings the set froze');
select throws_ok($$select public.service_space_catalog_variant_run(pg_temp.team(),'05791000-0000-4000-8000-000000000002',
 '05791000-0000-4000-8000-0000000000b1',0)$$,'NOT_FOUND','only the member who asked hands its variations over');
insert into seen select 'op0', to_jsonb(pg_temp.open_run('05791000-0000-4000-8000-0000000000b1',0,'bind0')::text);
select is(pg_temp.v('bind0')->>'bound','true','the run is bound to the variation');
select is(public.service_bind_space_catalog_variant_run(pg_temp.team(), pg_temp.owner(),'05791000-0000-4000-8000-0000000000b1',0,1,
 (pg_temp.v('op0')#>>'{}')::uuid)->>'bound','true','binding it again is the same binding');
select is(public.service_space_catalog_variant_run(pg_temp.team(), pg_temp.owner(),'05791000-0000-4000-8000-0000000000b1',0)->>'state',
 'running','handed over again it is the run already open');
select is(public.service_space_catalog_variant_run(pg_temp.team(), pg_temp.owner(),'05791000-0000-4000-8000-0000000000b1',0)->>'destinationFolderId',
 pg_temp.root()::text,'with the folder its output lands in');
select throws_ok($$select public.service_bind_space_catalog_variant_run(pg_temp.team(), pg_temp.owner(),
 '05791000-0000-4000-8000-0000000000b1',1,1,(pg_temp.v('op0')#>>'{}')::uuid)$$,'WRONG_STATE','another variation''s run is never bound here');

-- 3. The output -----------------------------------------------------------------------------
insert into seen select 'final0', pg_temp.finish_run((pg_temp.v('op0')#>>'{}')::uuid, repeat('b',64), 'out0');
select is((select output_material_id from private.space_catalog_variants where set_id='05791000-0000-4000-8000-0000000000b1' and ordinal=0),
 (pg_temp.v('out0')->>'id')::uuid,'the finalize registers the output with its variation');
select is((select category from public.space_object_refs where owner_kind='material' and owner_id=(pg_temp.v('out0')->>'id')::uuid),
 'catalogs','its bytes count under catalogs, not process');
select is((select bytes from public.space_storage_usage where team_id=pg_temp.team() and category='catalogs'),150::bigint,'in the ledger');
select is(public.service_space_catalog_variant_run(pg_temp.team(), pg_temp.owner(),'05791000-0000-4000-8000-0000000000b1',0)->>'state',
 'registered','a made variation is answered as made');
select throws_ok($$select public.service_space_catalog_variant_outputs(pg_temp.team(), pg_temp.owner(),'05791000-0000-4000-8000-0000000000b1')$$,
 'PROCESS_RESULT_UNCERTAIN','no outputs before every variation is made');

-- A run that failed: the next hand-over opens the next one.
insert into seen select 'op1a', to_jsonb(pg_temp.open_run('05791000-0000-4000-8000-0000000000b1',1,'bind1a')::text);
select public.service_transition_team_operation((pg_temp.v('op1a')#>>'{}')::uuid,'failed','failed',0,null,'PROCESS_FAILED',false);
select is(public.service_space_catalog_variant_run(pg_temp.team(), pg_temp.owner(),'05791000-0000-4000-8000-0000000000b1',1)->>'attempt',
 '2','after a failed run the variation needs its second');
insert into seen select 'op1b', to_jsonb(pg_temp.open_run('05791000-0000-4000-8000-0000000000b1',1,'bind1b')::text);
insert into seen select 'final1', pg_temp.finish_run((pg_temp.v('op1b')#>>'{}')::uuid, repeat('c',64), 'out1');
insert into seen select 'read', public.service_read_space_catalog_variants(pg_temp.team(), pg_temp.owner(),
 'product-catalog:05791000-0000-4000-8000-0000000000a1');
select is(pg_temp.v('read')->>'outcome'||':'||(pg_temp.v('read')->>'state')||':'||(pg_temp.v('read')->>'registeredCount'),
 'preparing_video:preparing:2','the dialog reads every variation made, the catalog still to be assembled');
select is(public.service_space_catalog_variant_outputs(pg_temp.team(), pg_temp.owner(),'05791000-0000-4000-8000-0000000000b1'),
 jsonb_build_array(jsonb_build_object('index',0,'materialId',pg_temp.v('out0')->>'id'),
                   jsonb_build_object('index',1,'materialId',pg_temp.v('out1')->>'id')),'the outputs, in variation order');

-- 4. The catalog of variations --------------------------------------------------------------
select public.service_space_catalog_video_link(pg_temp.team(), pg_temp.owner(), (pg_temp.v('out0')->>'id')::uuid);
select public.service_space_catalog_video_link(pg_temp.team(), pg_temp.owner(), (pg_temp.v('out1')->>'id')::uuid);
insert into seen select 'feedop', to_jsonb(op) from public.service_start_team_operation(pg_temp.team(), pg_temp.owner(),'upload',
 'catalog:variants-057-1','catalog:variants-057-1',(pg_temp.v('source')->>'id')::uuid,pg_temp.root(),'clip catalog 1',now()+interval '1 hour',null) op;
insert into seen select 'feed', public.service_commit_space_catalog_feed((pg_temp.v('feedop')->>'operation_id')::uuid,pg_temp.owner(),'clip catalog 1',1024);
select throws_ok($$select public.service_link_space_catalog_feed(pg_temp.team(),(pg_temp.v('source')->>'id')::uuid,
 (pg_temp.v('feed')->>'materialId')::uuid,null,
 jsonb_build_object('sourceLink','https://offer.test/?s=1','productCount',4,'sheetUrl','https://catalog-videos-beta.soty.pp.ua/feeds/'||repeat('9',32)||'.csv',
  'videoLink','https://videos.test/v/x.mp4','settingsSnapshot','{}'::jsonb,'createdBy',pg_temp.owner(),'variant',1,
  'feedId',repeat('9',32),'feedBytes',1024,'spaceVariantSetId','05791000-0000-4000-8000-0000000000b2'),pg_temp.owner())$$,
 'WRONG_STATE','a set that is not this video''s complete set is never linked');
insert into seen select 'linked', public.service_link_space_catalog_feed(pg_temp.team(),(pg_temp.v('source')->>'id')::uuid,
 (pg_temp.v('feed')->>'materialId')::uuid,null,
 jsonb_build_object('sourceLink','https://offer.test/?s=1','productCount',4,'sheetUrl','https://catalog-videos-beta.soty.pp.ua/feeds/'||repeat('9',32)||'.csv',
  'videoLink','https://videos.test/v/x.mp4','settingsSnapshot','{}'::jsonb,'createdBy',pg_temp.owner(),'variant',1,
  'feedId',repeat('9',32),'feedBytes',1024,'spaceVariantSetId','05791000-0000-4000-8000-0000000000b1'),pg_temp.owner());
select is(pg_temp.v('linked')->>'linked','true','the catalog of variations is linked');
select is((select state||':'||catalog_material_id::text from private.space_catalog_variant_sets where id='05791000-0000-4000-8000-0000000000b1'),
 'ready:'||(pg_temp.v('feed')->>'materialId'),'the set is bound to its catalog');
select is((select count(*)::integer from private.catalog_video_r2_uses where catalog_material_id=(pg_temp.v('feed')->>'materialId')::uuid
 and source_material_id in ((pg_temp.v('out0')->>'id')::uuid,(pg_temp.v('out1')->>'id')::uuid)),2,'the catalog uses each variation''s copy');
select is((select count(*)::integer from private.catalog_video_r2_copies where source_material_id=(pg_temp.v('source')->>'id')::uuid),
 0,'and no copy of the original was made');
select ok((select exhausted_at is not null from private.catalog_initial_publication_reverify where intent_id='05791000-0000-4000-8000-0000000000a1'),
 'nothing is owed to the Drive re-verification lane');
select is(jsonb_array_length(public.service_space_catalog_variant_links((pg_temp.v('feed')->>'materialId')::uuid)),2,
 'the updater reads both variations'' addresses');
select is(public.service_space_catalog_variant_links((pg_temp.v('feed')->>'materialId')::uuid)->>0,
 'https://videos.test/'||(select c.object_key from private.catalog_video_r2_copies c where c.source_material_id=(pg_temp.v('out0')->>'id')::uuid),
 'in variation order');
select is(public.service_space_catalog_variant_links(pg_temp.root()),null,'any other catalog has none');

-- 5. Cancel ---------------------------------------------------------------------------------
select public.service_admit_space_catalog_variants(pg_temp.team(), pg_temp.owner(),
 '05791000-0000-4000-8000-0000000000a2','05791000-0000-4000-8000-0000000000b2',(pg_temp.v('source')->>'id')::uuid,
 array['05791000-0000-4000-8000-0000000000c5']::uuid[], pg_temp.v('defaults'), repeat('d',64));
insert into seen select 'op2', to_jsonb(pg_temp.open_run('05791000-0000-4000-8000-0000000000b2',0,'bind2')::text);
select is(public.service_cancel_space_catalog_variants(pg_temp.team(), pg_temp.owner(),
 'product-catalog:05791000-0000-4000-8000-0000000000a2')->>'state','canceled','a creation still making its variations is canceled');
select is((select state from public.team_operations where id=(pg_temp.v('op2')#>>'{}')::uuid),'canceled','its open run with it');
select is((select state from private.catalog_generation_intents where id='05791000-0000-4000-8000-0000000000a2'),'canceled','and its intent');
select is(public.service_space_catalog_variant_run(pg_temp.team(), pg_temp.owner(),'05791000-0000-4000-8000-0000000000b2',0)->>'state',
 'canceled','nothing more is handed over');

-- 6. Deleted with the catalog ---------------------------------------------------------------
select public.service_mutate_space_materials(pg_temp.owner(), pg_temp.team(),
 jsonb_build_object('action','trash','materialIds',jsonb_build_array(pg_temp.v('feed')->>'materialId')));
select ok((select lifecycle='active' from public.team_materials where id=(pg_temp.v('out0')->>'id')::uuid),
 'a catalog in the trash keeps its variations');
select public.service_empty_space_trash(pg_temp.owner(), pg_temp.team(), array[(pg_temp.v('feed')->>'materialId')::uuid]);
select is((select count(*)::integer from public.team_materials where id in ((pg_temp.v('out0')->>'id')::uuid,(pg_temp.v('out1')->>'id')::uuid)),
 0,'deleted for good, it takes its variations');
select is((select count(*)::integer from public.space_object_purges where reason='catalog_deleted' and state='due'
 and object_id in (select o.id from public.space_objects o where o.team_id=pg_temp.team() and o.content_id in (repeat('b',64),repeat('c',64)))),
 2,'and their objects are due for deletion from R2 at once');

-- 7. Drive spaces -----------------------------------------------------------------------------
insert into public.teams(id,name,owner_id) values ('05791000-0000-4000-8000-000000000d01','Drive space',pg_temp.owner());
select throws_ok($$select public.service_space_catalog_variant_run('05791000-0000-4000-8000-000000000d01',pg_temp.owner(),
 '05791000-0000-4000-8000-0000000000b1',0)$$,'STORAGE_BACKEND_MISMATCH','a Drive space is never answered here');

select * from finish();
rollback;
