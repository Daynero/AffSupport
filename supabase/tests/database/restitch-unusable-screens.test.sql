begin;
select plan(24);
-- 2026-11-26: one space kept 135 macOS AppleDouble companions («._photo.png») beside its
-- pictures. Every re-stitch drew them, the agent refused them and the next video drew them
-- again. A pool now holds what is proven usable and what nothing is known about; what is proven
-- useless - by its name, by an agent, by Drive - leaves it, and the panel is told which files.
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('c1720000-0000-4000-8000-000000000001','authenticated','authenticated','unusable-owner@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('c1720000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values('c1720000-0000-4000-8000-000000000011','Synthetic unusable screens','c1720000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('c1720000-0000-4000-8000-000000000011','c1720000-0000-4000-8000-000000000001','admin') on conflict do nothing;
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope)
 values('c1720000-0000-4000-8000-000000000021','c1720000-0000-4000-8000-000000000001','unusable-synthetic','unusable-owner@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)
 values('c1720000-0000-4000-8000-000000000031','c1720000-0000-4000-8000-000000000011','c1720000-0000-4000-8000-000000000021','unusable-root','Synthetic root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,mime_type) values
 ('c1720000-0000-4000-8000-000000000040','c1720000-0000-4000-8000-000000000011','c1720000-0000-4000-8000-000000000031','unusable-folder','unusable-root','Screens','folder','application/vnd.google-apps.folder');

-- 1-3. A new service file is never indexed as a picture; an ordinary picture is.
insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version) values
 ('c1720000-0000-4000-8000-000000000041','c1720000-0000-4000-8000-000000000011','c1720000-0000-4000-8000-000000000031','unusable-good','unusable-folder','01 good.png','file','image','image/png',204800,repeat('a',32),'1'),
 ('c1720000-0000-4000-8000-000000000042','c1720000-0000-4000-8000-000000000011','c1720000-0000-4000-8000-000000000031','unusable-unknown','unusable-folder','02 unknown.png','file','image','image/png',300,repeat('b',32),'1'),
 ('c1720000-0000-4000-8000-000000000043','c1720000-0000-4000-8000-000000000011','c1720000-0000-4000-8000-000000000031','unusable-new-companion','unusable-folder','._02 unknown.png','file','image','image/png',250,repeat('c',32),'1'),
 ('c1720000-0000-4000-8000-000000000044','c1720000-0000-4000-8000-000000000011','c1720000-0000-4000-8000-000000000031','unusable-refused','unusable-folder','03 refused.jpg','file','image','image/jpeg',11124,repeat('d',32),'1'),
 ('c1720000-0000-4000-8000-000000000045','c1720000-0000-4000-8000-000000000011','c1720000-0000-4000-8000-000000000031','unusable-tiny','unusable-folder','04 tiny.png','file','image','image/png',200,repeat('e',32),'1');
select is((select category from public.team_materials where id='c1720000-0000-4000-8000-000000000043'),'other','a new AppleDouble companion is indexed as other');
select is((select category from public.team_materials where id='c1720000-0000-4000-8000-000000000041'),'image','an ordinary picture stays an image');
update public.team_materials set name=name,category='image',classification_source='mime' where id='c1720000-0000-4000-8000-000000000043';
select is((select category from public.team_materials where id='c1720000-0000-4000-8000-000000000043'),'other','a later scan cannot make it a picture again');

-- 4. A companion indexed before the rule keeps its category: a frozen candidate list names it.
alter table public.team_materials disable trigger team_materials_os_service_file;
insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version) values
 ('c1720000-0000-4000-8000-000000000046','c1720000-0000-4000-8000-000000000011','c1720000-0000-4000-8000-000000000031','unusable-old-companion','unusable-folder','._01 good.png','file','image','image/png',400,repeat('f',32),'1');
alter table public.team_materials enable trigger team_materials_os_service_file;
update public.team_materials set name=name,category='image' where id='c1720000-0000-4000-8000-000000000046';
select is((select category from public.team_materials where id='c1720000-0000-4000-8000-000000000046'),'image','a companion indexed before the rule is left for the data migration');

insert into public.team_restitch_sources(team_id,slot,material_id,kind,sort_order,added_by) values
 ('c1720000-0000-4000-8000-000000000011','end','c1720000-0000-4000-8000-000000000040','folder',1,'c1720000-0000-4000-8000-000000000001');

-- 5-7. What Drive read: dimensions are kept, silence counts only once the file has settled.
select is(public.service_record_drive_image_probes('c1720000-0000-4000-8000-000000000031',jsonb_build_array(
 jsonb_build_object('driveFileId','unusable-good','checksum',repeat('a',32),'width',1080,'height',1920,'settled',true),
 jsonb_build_object('driveFileId','unusable-unknown','checksum',repeat('b',32),'settled',false),
 jsonb_build_object('driveFileId','unusable-tiny','checksum',repeat('e',32),'settled',true))),2,'dimensions and settled silence are recorded, fresh silence is not');
select is(public.service_record_drive_image_probes('c1720000-0000-4000-8000-000000000031',jsonb_build_array(
 jsonb_build_object('driveFileId','unusable-good','checksum',repeat('a',32),'settled',true))),0,'Drive does not take dimensions back');
select throws_ok($$select public.service_record_drive_image_probes('c1720000-0000-4000-8000-000000000031','{}'::jsonb)$$,'22023','INVALID_INPUT','a probe batch is a list');

-- 8. What an agent found, by content.
insert into private.restitch_screen_verdicts(team_id,checksum,mime_type,verdict,rejections,first_rejected_at,last_rejected_at)
 values('c1720000-0000-4000-8000-000000000011',repeat('d',32),'image/jpeg','unusable',2,now(),now());
select results_eq($$select m.name,private.restitch_screen_defect(m.team_id,m.connection_id,m.drive_file_id,m.name,m.mime_type,m.size_bytes,m.checksum)
  from public.team_materials m where m.team_id='c1720000-0000-4000-8000-000000000011' and m.kind='file' order by m.drive_file_id$$,
 $$values('01 good.png'::text,null::text),('._02 unknown.png','service_file'),('._01 good.png','service_file'),
  ('03 refused.jpg','undecodable'),('04 tiny.png','not_an_image'),('02 unknown.png',null)$$,
 'every file has one answer: usable, or why not');

-- 9-13. The pool holds the proven and the unknown; the listing says what it left out.
select results_eq($$select name from private.restitch_pool_usable_images('c1720000-0000-4000-8000-000000000011',null,'end')$$,
 $$values('01 good.png'::text),('02 unknown.png')$$,'a screen is drawn from what is proven and what nothing is known about');
create temp table unusable_listing as select private.restitch_listing_json('c1720000-0000-4000-8000-000000000011',null)->'pools'->'end' pool;
select is((select (pool->>'eligibleCount')::integer from unusable_listing),2,'the listing counts the pool the same way');
select is((select jsonb_agg(jsonb_build_array(item->>'name',item->>'reason',item->>'folderName') order by ordinality)
  from unusable_listing,jsonb_array_elements(pool->'unusable'->'items') with ordinality as listed(item,ordinality)),
 '[["._01 good.png","service_file","Screens"],["._02 unknown.png","service_file","Screens"],["03 refused.jpg","undecodable","Screens"],["04 tiny.png","not_an_image","Screens"]]'::jsonb,
 'the panel is told which files and why, whatever category they were indexed as');
select is((select (pool->'unusable'->>'count')::integer from unusable_listing),4,'and how many there are');
select is((select pool->'sources'->0->>'imageCount' from unusable_listing),'2','a folder is worth the pictures the pool takes from it');

-- 14-15. What a new operation or catalog set freezes: complete, and without the useless files.
create temp table unusable_snapshot as select private.restitch_selection_pool_snapshot('c1720000-0000-4000-8000-000000000011',null,'end') pool;
select is((select jsonb_agg(candidate->>'materialId' order by candidate->>'materialId') from unusable_snapshot,jsonb_array_elements(pool->'candidates') candidate),
 '["c1720000-0000-4000-8000-000000000041","c1720000-0000-4000-8000-000000000042"]'::jsonb,'only usable pictures are frozen');
select is((select pool-'candidates' from unusable_snapshot),
 '{"complete":true,"eligibleObserved":2,"ineligibleObserved":3,"unknownObserved":0,"sourceCount":1,"unknownSourceCount":0,"truncated":false}'::jsonb,
 'a known defect is ineligible, never unknown: the pool stays complete');

-- 16-17. A decode outranks what Drive did not see; new bytes start clean.
insert into private.restitch_screen_verdicts(team_id,checksum,mime_type,verdict) values('c1720000-0000-4000-8000-000000000011',repeat('e',32),'image/png','usable');
select is((select count(*)::integer from private.restitch_pool_usable_images('c1720000-0000-4000-8000-000000000011',null,'end')),3,'a picture an agent decoded is usable again');
update public.team_materials set checksum=repeat('9',32) where id='c1720000-0000-4000-8000-000000000044';
select is((select count(*)::integer from private.restitch_pool_usable_images('c1720000-0000-4000-8000-000000000011',null,'end')),4,'new bytes under the same file are a new picture');

-- 18-19. The declared pool is not the evidence's to move: the launch settings version hashed
-- from it stays put when a verdict arrives, and a companion the pool holds keeps its category.
create temp table unusable_version as select private.launch_restitch_settings_version('c1720000-0000-4000-8000-000000000011','c1720000-0000-4000-8000-000000000001') version;
insert into private.restitch_screen_verdicts(team_id,checksum,mime_type,verdict,rejections) values('c1720000-0000-4000-8000-000000000011',repeat('a',32),'image/png','unusable',1);
select is(private.launch_restitch_settings_version('c1720000-0000-4000-8000-000000000011','c1720000-0000-4000-8000-000000000001'),(select version from unusable_version),
 'a verdict does not move the settings version a launch was accepted with');
update public.team_materials as material set category='other',classification_source='fallback'
 where material.kind='file' and material.category is distinct from 'other' and private.os_service_file_name(material.name)
  and not exists(select 1 from private.catalog_video_restitch_candidates c where c.material_id=material.id)
  and not exists(select 1 from private.restitch_selection_candidates c where c.material_id=material.id)
  and not exists(select 1 from (select distinct s.team_id,s.user_id,s.slot from public.team_restitch_sources s where s.team_id=material.team_id) pool
   cross join lateral private.restitch_pool_images(pool.team_id,pool.user_id,pool.slot) member where member.material_id=material.id);
select is((select category from public.team_materials where id='c1720000-0000-4000-8000-000000000046'),'image','the data migration leaves a companion that a declared pool holds');

-- 20-23. Nobody but the service role writes evidence, and no browser reads it.
select ok(not has_table_privilege('authenticated','private.restitch_screen_verdicts','select') and not has_table_privilege('service_role','private.restitch_screen_verdicts','select'),'verdicts are read through functions only');
select ok(not has_table_privilege('authenticated','private.drive_image_probes','select') and not has_table_privilege('service_role','private.drive_image_probes','select'),'probes are read through functions only');
select ok(has_function_privilege('service_role','public.service_record_restitch_screen_verdict(uuid,bytea,text,uuid,text)','execute')
 and not has_function_privilege('authenticated','public.service_record_restitch_screen_verdict(uuid,bytea,text,uuid,text)','execute')
 and not has_function_privilege('anon','public.service_record_restitch_screen_verdict(uuid,bytea,text,uuid,text)','execute'),'only the service role records a verdict');
select ok(has_function_privilege('service_role','public.service_record_drive_image_probes(uuid,jsonb)','execute')
 and not has_function_privilege('authenticated','public.service_record_drive_image_probes(uuid,jsonb)','execute')
 and not has_function_privilege('anon','public.service_record_drive_image_probes(uuid,jsonb)','execute'),'only the service role records a probe');

-- 24. The new tables hold no reference to a material, and the cleanup inventory stays verified.
select ok(private.task_cleanup_coverage_verified(),'task-attachment cleanup coverage is still verified');
select * from finish();
rollback;
