begin;
select plan(80);

-- Fixture: one space, an editor, four videos, one image, a "sheet" material.
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('c0620000-0000-4000-8000-000000000001','authenticated','authenticated','multi-owner@test.invalid','{}','{}'),
 ('c0620000-0000-4000-8000-000000000002','authenticated','authenticated','multi-stranger@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('c0620000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
 ('c0620000-0000-4000-8000-000000000011','Multi creative fixture','c0620000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000001','admin');
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('c0620000-0000-4000-8000-000000000021','c0620000-0000-4000-8000-000000000001','multi-test','multi-owner@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('c0620000-0000-4000-8000-000000000031','c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000021','multi-root','Root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version,checksum) values
 ('c0620000-0000-4000-8000-000000000041','c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000031','multi-v1','Alpha.mp4','file','video','video/mp4','1','0123456789abcdef0123456789abcdef'),
 ('c0620000-0000-4000-8000-000000000042','c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000031','multi-v2','Beta.mp4','file','video','video/mp4','1','1123456789abcdef0123456789abcdef'),
 ('c0620000-0000-4000-8000-000000000043','c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000031','multi-v3','Gamma.mp4','file','video','video/mp4','1','2123456789abcdef0123456789abcdef'),
 ('c0620000-0000-4000-8000-000000000044','c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000031','multi-v4','Delta.mp4','file','video','video/mp4','1','3123456789abcdef0123456789abcdef'),
 ('c0620000-0000-4000-8000-000000000045','c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000031','multi-i1','Picture.png','file','image','image/png','1','4123456789abcdef0123456789abcdef');
insert into public.team_accounts(id,team_id,created_by,name) values
 ('c0620000-0000-4000-8000-000000000051','c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000001','Social');
insert into public.team_account_agents(id,team_id,account_id,created_by,agent_id) values
 ('c0620000-0000-4000-8000-000000000052','c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000051','c0620000-0000-4000-8000-000000000001','agent-123');
insert into public.team_launch_offers(id,team_id,name,normalized_key,created_by) values
 ('c0620000-0000-4000-8000-000000000053','c0620000-0000-4000-8000-000000000011','Offer','offer','c0620000-0000-4000-8000-000000000001');
insert into public.team_launch_buyers(id,team_id,value,normalized_key,created_by) values
 ('c0620000-0000-4000-8000-000000000054','c0620000-0000-4000-8000-000000000011','buyer','buyer','c0620000-0000-4000-8000-000000000001');

-- A catalog config with the given creatives (ids by suffix 41..45), copies and product count.
create function pg_temp.cfg(p_ids int[], p_copies int[], p_n int, p_kind text default 'video', p_method text default 'catalog') returns jsonb language sql as $$
 select jsonb_build_object('schemaVersion',1,
   'agentRowId','c0620000-0000-4000-8000-000000000052','offerId','c0620000-0000-4000-8000-000000000053',
   'buyerId','c0620000-0000-4000-8000-000000000054',
   'materialId','c0620000-0000-4000-8000-0000000000'||p_ids[1]::text,'creativeAlias','c'||p_ids[1]::text,
   'creativeKind',p_kind,'method',p_method,
   'creatives',(select jsonb_agg(jsonb_build_object('materialId','c0620000-0000-4000-8000-0000000000'||id::text,
       'alias','c'||id::text,'copies',p_copies[o],'pinned',null) order by o) from unnest(p_ids) with ordinality u(id,o)),
   'catalog',jsonb_build_object('productCount',p_n,'restitchEnabled',false,'catalogVideoProtocolVersion',1,'videoVariationCount',1));
$$;
create function pg_temp.draft(p_config jsonb) returns jsonb language plpgsql as $$
begin
 return public.save_launch_draft('c0620000-0000-4000-8000-000000000011',null,null,'draft-'||md5(p_config::text),p_config,null);
end $$;
select set_config('request.jwt.claim.sub','c0620000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"c0620000-0000-4000-8000-000000000001","role":"authenticated"}',true);

-- Structure.
select is_empty($$
 select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='private' and p.proname in('launch_creatives_error','launch_creatives_kind_error','launch_sources_from_config','launch_generation_creative_count')
 and (has_function_privilege('authenticated',p.oid,'execute') or not ('search_path=""'=any(p.proconfig)))
$$,'creative helpers are private and closed over search_path');

-- Admission rules (mirror of parseLaunchCreatives).
select is(private.launch_creatives_error(pg_temp.cfg('{41,42,43,44}','{3,3,2,2}',10)),null,'four creatives sharing ten products are valid');
select is(private.launch_creatives_error(pg_temp.cfg('{41,42}','{3,3}',10)),'DISTRIBUTION_INVALID','copies must sum to the product count');
select is(private.launch_creatives_error(pg_temp.cfg('{41,42,43}','{1,1,0}',2)),'DISTRIBUTION_INVALID','every creative keeps one product');
select is(private.launch_creatives_error(pg_temp.cfg('{41,41}','{1,1}',2)),'CREATIVE_DUPLICATE','a creative is listed once');
select is(private.launch_creatives_error(pg_temp.cfg('{41,42}','{1,1}',2,'video','other')),'CREATIVES_LIMIT','the other method keeps one creative');
select is(private.launch_creatives_error(pg_temp.cfg('{41}','{1}',1,'video','other')),null,'the other method with one creative is valid');
select is(private.launch_creatives_error(pg_temp.cfg('{41,42}','{1,1}',2,'gif')),'INVALID_INPUT','creative kind is video or image');
select is(private.launch_creatives_error(pg_temp.cfg('{41,42}','{1,1}',2)-'creativeKind'),'INVALID_INPUT','a list needs its kind');
select is(private.launch_creatives_error(pg_temp.cfg('{41,42}','{1,1}',2)||'{"materialId":"c0620000-0000-4000-8000-000000000042"}'),'INVALID_INPUT','materialId mirrors the first creative');
select is(private.launch_creatives_error(pg_temp.cfg('{41,42}','{1,1}',2)||'{"creativeAlias":"other"}'),'INVALID_INPUT','creativeAlias mirrors the first alias');
select is(private.launch_creatives_error(jsonb_set(pg_temp.cfg('{41,42}','{1,1}',2),'{creatives,1,alias}','"two words"')),null,'aliases normalize inner spaces like the shared parser');
select is(private.launch_creatives_error(jsonb_set(pg_temp.cfg('{41,42}','{1,1}',2),'{creatives,1,alias}','"кіно"')),'LAUNCH_SUB_INVALID','alias alphabet is latin');
select is(private.launch_creatives_error(jsonb_set(pg_temp.cfg('{41,42}','{1,1}',2),'{creatives,1}','{"materialId":"c0620000-0000-4000-8000-000000000042","alias":"c42","copies":1}')),'INVALID_INPUT','pinned is required (null or positive)');
select is(private.launch_creatives_error(jsonb_set(jsonb_set(pg_temp.cfg('{41,42,43}','{2,2,2}',6),'{catalog,restitchEnabled}','true'),'{catalog,videoVariationCount}','2')),'VARIATIONS_RANGE','restitch needs at least one variation per video');
select is(private.launch_creatives_error(jsonb_set(jsonb_set(pg_temp.cfg('{41,42,43}','{2,2,2}',6),'{catalog,restitchEnabled}','true'),'{catalog,videoVariationCount}','6')),null,'variations between k and N are valid');
select is(private.launch_creatives_error(jsonb_set(pg_temp.cfg('{45}','{1}',1,'image'),'{catalog,restitchEnabled}','true')),'INVALID_INPUT','images are never restitched');
select is(private.launch_creatives_error(pg_temp.cfg('{41}','{1}',1)-'creatives'-'creativeKind'),null,'configs without a list are untouched');
select is(private.launch_creatives_error((select jsonb_set(pg_temp.cfg('{41}','{401}',401),'{creatives}',(select jsonb_agg(jsonb_build_object('materialId',gen_random_uuid(),'alias','a','copies',1,'pinned',null)) from generate_series(1,401))))),'CREATIVES_LIMIT','no more than 400 creatives');

-- Draft boundary.
select lives_ok($$select pg_temp.draft(pg_temp.cfg('{41,42,43,44}','{3,3,2,2}',10))$$,'a draft with four creatives saves');
select throws_ok($$select pg_temp.draft(pg_temp.cfg('{41,45}','{1,1}',2))$$,'22023','CREATIVES_MIXED','a draft mixing videos and images is refused');
select throws_ok($$select pg_temp.draft(pg_temp.cfg('{41,41}','{1,1}',2))$$,'22023','CREATIVE_DUPLICATE','a draft listing a creative twice is refused');
select throws_ok($$select pg_temp.draft(pg_temp.cfg('{41,42,43}','{1,1,1}',2))$$,'22023','DISTRIBUTION_INVALID','a draft with fewer products than creatives is refused');
select throws_ok($$select pg_temp.draft(pg_temp.cfg('{41,42}','{1,1}',2,'video','other'))$$,'22023','CREATIVES_LIMIT','a draft of the other method keeps one creative');
select lives_ok($$select pg_temp.draft(pg_temp.cfg('{41,42}','{1,5}',2))$$,'a draft mid-edit may not sum yet');
select lives_ok($$select pg_temp.draft(pg_temp.cfg('{41}','{1}',1)-'creatives'-'creativeKind')$$,'a draft without a list saves as before');

-- Sources.
select is(jsonb_array_length(public.resolve_launch_selection('c0620000-0000-4000-8000-000000000011',pg_temp.cfg('{43,41,42}','{1,1,1}',3))->'materials'),3,'sources list every creative');
select is((select jsonb_agg(e->>'materialId') from jsonb_array_elements(public.resolve_launch_selection('c0620000-0000-4000-8000-000000000011',pg_temp.cfg('{43,41,42}','{1,1,1}',3))->'materials') e),
 '["c0620000-0000-4000-8000-000000000043","c0620000-0000-4000-8000-000000000041","c0620000-0000-4000-8000-000000000042"]'::jsonb,'materials keep creative order');
select ok(not (public.resolve_launch_selection('c0620000-0000-4000-8000-000000000011',pg_temp.cfg('{41}','{1}',1)-'creatives'-'creativeKind') ? 'materials'),'a config without a list keeps its old snapshot');
select throws_ok($$select public.resolve_launch_selection('c0620000-0000-4000-8000-000000000011',pg_temp.cfg('{41,42}','{1,1}',2,'image'))$$,'22023','CREATIVES_MIXED','a material of another kind than declared is refused');
select ok(private.launch_material_identity(public.resolve_launch_selection('c0620000-0000-4000-8000-000000000011',pg_temp.cfg('{41}','{1}',1)))
  = private.launch_material_identity(public.resolve_launch_selection('c0620000-0000-4000-8000-000000000011',pg_temp.cfg('{41}','{1}',1)-'creatives'-'creativeKind')),
  'one creative keeps the single-material identity');

-- Admission, list and pending catalog name.
select ok(pg_get_functiondef('public.service_accept_launch_generation_unfenced(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb)'::regprocedure) ~ 'launch_creatives_error\(p_config,false\)','admission applies the full creative rules');
insert into public.team_launches(id,team_id,created_by,draft_config) values
 ('c0620000-0000-4000-8000-000000000101','c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000001',pg_temp.cfg('{41,42,43,44}','{1,1,1,1}',4));
insert into public.team_launch_revisions(id,team_id,launch_id,revision_no,result_kind,config,sources,original_url,generated_url,sub_values,created_by)
 values('c0620000-0000-4000-8000-000000000201','c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000101',1,'generated',
  pg_temp.cfg('{41,42,43,44}','{1,1,1,1}',4),'{"materialType":"video"}','https://offer.example.invalid/','https://offer.example.invalid/?s=1','{}','c0620000-0000-4000-8000-000000000001');
update public.team_launches set active_revision_id='c0620000-0000-4000-8000-000000000201' where id='c0620000-0000-4000-8000-000000000101';
insert into public.team_launch_generations(id,team_id,launch_id,revision_id,actor_id,request_key,request_digest,input_version,state)
 values('c0620000-0000-4000-8000-000000000301','c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000101','c0620000-0000-4000-8000-000000000201','c0620000-0000-4000-8000-000000000001','multi-generation-1','digest','v1','running');
select is(public.get_launch('c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000101')->>'pendingCatalogName','Alpha+3_v1_catalog','pending catalog name counts the other creatives');
select is((select (e->>'creativeCount')::int from jsonb_array_elements(public.list_launches('c0620000-0000-4000-8000-000000000011','{}'::jsonb,50)->'items') e where e->>'id'='c0620000-0000-4000-8000-000000000101'),4,'the list reports the creative count');
select is((select e->>'creativeKind' from jsonb_array_elements(public.list_launches('c0620000-0000-4000-8000-000000000011','{}'::jsonb,50)->'items') e where e->>'id'='c0620000-0000-4000-8000-000000000101'),'video','the list reports the creative kind');

-- 062 video segments: one restitch set per video of one catalog intent.
update public.team_materials set size_bytes=1000 where team_id='c0620000-0000-4000-8000-000000000011';
insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version,checksum,size_bytes) values
 ('c0620000-0000-4000-8000-000000000046','c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000031','multi-v5','Other.mp4','file','video','video/mp4','1','5123456789abcdef0123456789abcdef',1000);
create function pg_temp.settings() returns jsonb language sql as $$
 select '{"operation":"restitch","sourceMode":"drive","startImageIds":[],"endImageIds":[],"fitMode":"cover","configured":true,"startEnabled":false,"endEnabled":true,"automaticEndFrame":true,"startDurationMode":"one-frame","customStartDurationMs":100,"finalDurationMode":"custom","customFinalDurationSeconds":2700}'::jsonb;
$$;
-- Set id, rows and request of segment o (0..3): video 41+o, rows 2o and 2o+1.
create function pg_temp.set_id(o int) returns uuid language sql as $$ select ('c0620000-0000-4000-8000-0000000005'||lpad(o::text,2,'0'))::uuid $$;
create function pg_temp.row_id(r int) returns uuid language sql as $$ select ('c0620000-0000-4000-8000-0000000006'||lpad(r::text,2,'0'))::uuid $$;
create function pg_temp.req_id(o int) returns uuid language sql as $$ select ('c0620000-0000-4000-8000-0000000007'||lpad(o::text,2,'0'))::uuid $$;
create function pg_temp.seed(o int) returns text language sql as $$ select encode(sha256(convert_to(repeat('a',64)||':'||o::text,'UTF8')),'hex') $$;
insert into private.catalog_generation_intents(id,team_id,video_material_id,actor_id,request_key,request_digest,request_payload,variant,state,checkpoint)
 values('c0620000-0000-4000-8000-000000000401','c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000041','c0620000-0000-4000-8000-000000000001',
  'launch:c0620000-0000-4000-8000-000000000301:catalog','digest','{"catalogVideoProtocolVersion":1,"restitchEnabled":true}',1,'planned',
  jsonb_build_object('initialVideoPlan',jsonb_build_object('setId',pg_temp.set_id(0),'assignmentSeed',repeat('a',64),
   'segments',(select jsonb_agg(jsonb_build_object('ordinal',o,'materialId','c0620000-0000-4000-8000-0000000000'||(41+o)::text,'kind','video','rowStart',2*o,'rowCount',2,'variantCount',1,
     'setId',pg_temp.set_id(o),'childRequestIds',jsonb_build_array(pg_temp.req_id(o)),'assignmentSeed',pg_temp.seed(o)) order by o) from generate_series(0,3) o))));
create function pg_temp.accept(o int, p_source text default null, p_set uuid default null) returns jsonb language sql as $$
 select public.service_accept_catalog_video_set_before_foreground('c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000001','c0620000-0000-4000-8000-000000000901',
  jsonb_build_object('setId',coalesce(p_set,pg_temp.set_id(o)),'catalogIntentId','c0620000-0000-4000-8000-000000000401',
   'sourceMaterialId',coalesce(p_source,'c0620000-0000-4000-8000-0000000000'||(41+o)::text),'sourceVersion','1','settings',pg_temp.settings(),
   'settingsDigest',repeat('b',64),'requestedCount',1,'productCount',2,'recipeRevision',1,'seed',pg_temp.seed(o)),
  jsonb_build_array(jsonb_build_object('index',0,'requestId',pg_temp.req_id(o))),
  jsonb_build_array(jsonb_build_object('recipeRowId',pg_temp.row_id(2*o),'videoVariantIndex',0),jsonb_build_object('recipeRowId',pg_temp.row_id(2*o+1),'videoVariantIndex',0)));
$$;
select lives_ok($$select pg_temp.accept(o) from generate_series(0,3) o$$,'every video segment accepts its own set');
select is((select count(*)::int from private.catalog_video_sets where catalog_intent_id='c0620000-0000-4000-8000-000000000401'),4,'one intent holds four sets');
select lives_ok($$select pg_temp.accept(2)$$,'replaying a segment set returns it');
select is((select count(*)::int from private.catalog_video_recipe_references where catalog_intent_id='c0620000-0000-4000-8000-000000000401'),4,'each set keeps its recipe reference');
select throws_ok($$select pg_temp.accept(1,'c0620000-0000-4000-8000-000000000046')$$,'42501','PERMISSION_DENIED','a video outside the plan is refused');
select throws_ok($$select pg_temp.accept(1,null,'c0620000-0000-4000-8000-000000000599')$$,'42501','PERMISSION_DENIED','a segment accepts only its planned set');
select is((select assignment_seed from private.catalog_video_sets where id=pg_temp.set_id(3)),pg_temp.seed(3),'each set keeps its segment seed');

-- Generation, context and frozen segments.
update public.team_launch_generations set state='running',lease_owner='c0620000-0000-4000-8000-000000000902',lease_expires_at=clock_timestamp()+interval '5 minutes' where id='c0620000-0000-4000-8000-000000000301';
insert into private.launch_catalog_video_contexts(generation_id,team_id,actor_id,executor_id,settings_snapshot,request_payload,initial_video_plan,catalog_intent_id,video_set_id)
 values('c0620000-0000-4000-8000-000000000301','c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000001','c0620000-0000-4000-8000-000000000901',pg_temp.settings(),'{}','{}','c0620000-0000-4000-8000-000000000401',pg_temp.set_id(0));
insert into private.launch_catalog_video_segments(generation_id,ordinal,team_id,material_id,kind,row_start,row_count,variant_count,video_set_id,assignment_seed)
 select 'c0620000-0000-4000-8000-000000000301',o,'c0620000-0000-4000-8000-000000000011',('c0620000-0000-4000-8000-0000000000'||(41+o)::text)::uuid,'video',2*o,2,1,pg_temp.set_id(o),pg_temp.seed(o) from generate_series(0,3) o;
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='private.launch_catalog_video_segments'::regclass)
  and not has_table_privilege('service_role','private.launch_catalog_video_segments','select,insert,update,delete')
  and not has_table_privilege('authenticated','private.launch_catalog_video_segments','select,insert,update,delete'),'segments are reachable only through definer functions');
select throws_ok($$update private.launch_catalog_video_segments set row_count=row_count where ordinal=0$$,'55000','WRONG_STATE','segments are immutable');
select ok(private.task_cleanup_coverage_verified(),'segments keep the cleanup fence');
select is((public.service_wait_launch_catalog_video('c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000301','c0620000-0000-4000-8000-000000000001','c0620000-0000-4000-8000-000000000902',(select fence::text from public.team_launch_generations where id='c0620000-0000-4000-8000-000000000301')))->>'setCount','4','waiting sees every set');
update private.catalog_video_sets set state='unknown' where id=pg_temp.set_id(2);
update public.team_launch_generations set state='running',lease_owner='c0620000-0000-4000-8000-000000000902',lease_expires_at=clock_timestamp()+interval '5 minutes' where id='c0620000-0000-4000-8000-000000000301';
select is((public.service_wait_launch_catalog_video('c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000301','c0620000-0000-4000-8000-000000000001','c0620000-0000-4000-8000-000000000902',(select fence::text from public.team_launch_generations where id='c0620000-0000-4000-8000-000000000301')))->>'failedOrdinal','2','waiting names the uncertain segment');
select is((select state from public.team_launch_generations where id='c0620000-0000-4000-8000-000000000301'),'interrupted','one uncertain set interrupts the generation');
select is(private.launch_video_generation_json('c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000301')->>'requestedCount','4','progress adds up every set');
select is(jsonb_array_length(private.launch_video_generation_json('c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000301')->'segments'),4,'progress lists every segment');
select is((public.retry_launch_catalog_video_segment('c0620000-0000-4000-8000-000000000301',2))->>'setId',pg_temp.set_id(2)::text,'a segment retry reopens its own set');
select throws_ok($$select public.retry_launch_catalog_video_segment('c0620000-0000-4000-8000-000000000301',9)$$,'P0002','NOT_FOUND','an unknown segment cannot be retried');
update public.team_launch_generations set state='cancel_requested' where id='c0620000-0000-4000-8000-000000000301';
select is((select count(*)::int from private.catalog_video_sets where catalog_intent_id='c0620000-0000-4000-8000-000000000401' and state='canceled'),4,'canceling the Launch stops every segment set');

-- 062 image catalogs and the 'creatives' publication target.
insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values
 ('c0620000-0000-4000-8000-000000000061','c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000031','multi-s1','Sheet','file','other','application/vnd.google-apps.spreadsheet','1'),
 ('c0620000-0000-4000-8000-000000000062','c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000031','multi-s2','Sheet 2','file','other','application/vnd.google-apps.spreadsheet','1');
select lives_ok($$insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot)
 values('c0620000-0000-4000-8000-000000000061','c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000045','https://offer.example.invalid/',2,
  'https://docs.google.com/spreadsheets/d/s1/edit',null,'{"_catalogCreativeKind":"image"}')$$,'an image catalog has no video link');
select throws_ok($$insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot)
 values('c0620000-0000-4000-8000-000000000062','c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000041','https://offer.example.invalid/',2,
  'https://docs.google.com/spreadsheets/d/s2/edit',null,'{}')$$,'23514',null,'a video catalog still needs its video link');
select lives_ok($$select public.service_initial_catalog_video_context_before_foreground('c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000001','c0620000-0000-4000-8000-000000000045',null,false)$$,'an image is a valid source without restitch');
select throws_ok($$select public.service_initial_catalog_video_context_before_foreground('c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000001','c0620000-0000-4000-8000-000000000045',null,true)$$,'55000','SOURCE_CHANGED','an image is never restitched');
create temporary table image_probe as select private.register_catalog_creatives_target('c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000001','c0620000-0000-4000-8000-000000000401','c0620000-0000-4000-8000-000000000045','{}'::jsonb,2,'immediate','image') id;
select is(private.catalog_publication_target_json((select id from image_probe))#>>'{segments,0,kind}','image','one image gets a creatives target of one image block');
create temporary table target_probe as select private.register_catalog_creatives_target('c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000001','c0620000-0000-4000-8000-000000000401','c0620000-0000-4000-8000-000000000041',
 '{"segments":[{"ordinal":0,"materialId":"c0620000-0000-4000-8000-000000000041","kind":"video","rowStart":0,"rowCount":2,"variantCount":1,"setId":null},{"ordinal":1,"materialId":"c0620000-0000-4000-8000-000000000042","kind":"video","rowStart":2,"rowCount":1,"variantCount":1,"setId":null}]}'::jsonb,3,'immediate','video') id;
select is(jsonb_array_length(private.catalog_publication_target_json((select id from target_probe))->'segments'),2,'several videos get one segment each');
select is(private.catalog_publication_target_observation((select id from target_probe))->>'state','available','unchanged sources are available');
select throws_ok($$select private.register_catalog_creatives_target('c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000001','c0620000-0000-4000-8000-000000000401','c0620000-0000-4000-8000-000000000041',
 '{"segments":[{"ordinal":0,"materialId":"c0620000-0000-4000-8000-000000000041","kind":"video","rowStart":0,"rowCount":2,"setId":null}]}'::jsonb,3,'immediate','video')$$,'55000','WRONG_STATE','segments must cover every row');
insert into private.catalog_video_publication_policies(catalog_material_id,team_id,actor_id,revision,mode,target_id)
 values('c0620000-0000-4000-8000-000000000061','c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000001',1,'immediate',(select id from target_probe));
select is(private.catalog_multi_creative_kind('c0620000-0000-4000-8000-000000000061'),'image','an image catalog is recognized');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='private.catalog_publication_target_segments'::regclass) and private.task_cleanup_coverage_verified(),'target segments are private and fenced');

-- 062 manager: hidden actions of catalogs with several creatives.
select ok((select not refresh_images and not grow_products and not random_link_variation and not restitch from public.team_catalog_update_profiles where catalog_material_id='c0620000-0000-4000-8000-000000000061'),'a new image catalog profile starts with the hidden switches off');
select throws_ok($$select public.patch_team_catalog_update_profile('c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000061',(select version from public.team_catalog_update_profiles where catalog_material_id='c0620000-0000-4000-8000-000000000061'),'{"randomLinkVariation":true}')$$,'22023','MULTI_CREATIVE_UNSUPPORTED','random link variation cannot be turned on');
select throws_ok($$select public.patch_team_catalog_update_profile('c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000061',(select version from public.team_catalog_update_profiles where catalog_material_id='c0620000-0000-4000-8000-000000000061'),'{"restitch":true}')$$,'22023','MULTI_CREATIVE_UNSUPPORTED','an image catalog is never restitched');
select throws_ok($$select public.service_accept_catalog_video_replacement('c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000061','c0620000-0000-4000-8000-000000000001','{}')$$,'22023','MULTI_CREATIVE_UNSUPPORTED','video replacement is refused');
select throws_ok($$select public.service_begin_catalog_baseline_check(gen_random_uuid(),'c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000001','c0620000-0000-4000-8000-000000000061',1)$$,'22023','MULTI_CREATIVE_UNSUPPORTED','the link check is refused');
select ok((select 'creative_kind'=any(proargnames) and 'creatives'=any(proargnames) from pg_proc where oid='public.list_team_catalog_update_profiles(uuid)'::regprocedure),'the manager learns the creative kind and list');
select throws_ok($$select public.set_catalog_creative_image_r2('c0620000-0000-4000-8000-000000000041',true)$$,'P0002','NOT_FOUND','image R2 is only for image catalogs');

-- 062 analytics allowlist.
select ok(public.analytics_properties_are_safe_v2('{"launch_method":"catalog","creative_kind":"video","creative_count":4,"product_count":10,"variation_count":8,"custom_distribution":true,"failed_ordinal":2}'),'multi-creative launch properties are accepted');
select ok(public.analytics_properties_are_safe_v2('{"creative_kind":"image","creative_ordinal":0,"launch_code":"CREATIVE_IMAGE_TOO_LARGE"}'),'image publication stages are accepted');
select ok(not public.analytics_properties_are_safe_v2('{"creative_kind":"gif"}'),'the creative kind is an enum');
select ok(not public.analytics_properties_are_safe_v2('{"creative_count":401}'),'counts are bounded');

-- 062 edge follow-ups.
select ok(has_function_privilege('service_role','public.service_confirm_catalog_creative_links(uuid)','execute') and not has_function_privilege('authenticated','public.service_confirm_catalog_creative_links(uuid)','execute'),'creative link confirmation is service only');
select throws_ok($$select public.service_confirm_catalog_creative_links(gen_random_uuid())$$,'P0002','NOT_FOUND','an unknown job has no links');

-- 062 publication lane: an image catalog's R2 switch publishes H through a runnable job.
insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values
 ('c0620000-0000-4000-8000-000000000063','c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000031','multi-s3','Sheet 3','file','other','application/vnd.google-apps.spreadsheet','1');
insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot)
 values('c0620000-0000-4000-8000-000000000063','c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000045','https://offer.example.invalid/',2,
  'https://docs.google.com/spreadsheets/d/s3/edit',null,'{"_catalogCreativeKind":"image","_catalogCreatives":[{"ordinal":0,"alias":"c45","kind":"image"}]}');
-- An adopted catalog: its initial delivery was verified.
insert into private.catalog_video_publication_policies(catalog_material_id,team_id,actor_id,revision,mode,target_id,legacy_delivery_unverified)
 values('c0620000-0000-4000-8000-000000000063','c0620000-0000-4000-8000-000000000011','c0620000-0000-4000-8000-000000000001',1,'immediate',(select id from image_probe),false);
select is((public.set_catalog_creative_image_r2('c0620000-0000-4000-8000-000000000063',true))->>'enabled','true','an image catalog switches to R2 links');
select ok(exists(select 1 from private.catalog_video_publication_jobs where catalog_material_id='c0620000-0000-4000-8000-000000000063' and revision=2 and state not in('published','superseded')),'the switch asks for an immediate publication of H');
update private.catalog_video_publication_jobs set worker_id='c0620000-0000-4000-8000-000000000903',lease_until=clock_timestamp()+interval '5 minutes'
 where catalog_material_id='c0620000-0000-4000-8000-000000000063' and revision=2;
create temporary table cells_probe as select public.service_catalog_publication_cells_context((select id from private.catalog_video_publication_jobs where catalog_material_id='c0620000-0000-4000-8000-000000000063' and revision=2),'c0620000-0000-4000-8000-000000000903') value;
select is((select value->>'creativeKind' from cells_probe),'image','the job context names the creative kind');
select ok((select value#>>'{sources,0,kind}'='image' and value#>'{sources,0,r2}'='true'::jsonb and value#>>'{segments,0,rowCount}'='2' from cells_probe),'image sources carry their R2 choice and segments their rows');

select * from finish();
rollback;
