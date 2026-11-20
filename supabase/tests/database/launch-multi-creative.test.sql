begin;
select plan(35);

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

select * from finish();
rollback;
