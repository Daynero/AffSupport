begin;
select plan(30);

-- 057 T007: who sees an R2 space and how the lists read it (20261226120000). The old team list
-- never returns an R2 space; the v2 list does and says so. A pilot space opens to pilot users
-- without a 034 tariff. access_epoch rises with every change of who may read. The folder,
-- tree, subtree, material and trash lists answer for R2 rows (parent = folder uuid, no Drive
-- connection) and stay what they were for a Drive space.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05710000-0000-4000-8000-000000000001','authenticated','authenticated','pilot-owner@test.invalid','{}','{}'),
 ('05710000-0000-4000-8000-000000000002','authenticated','authenticated','invited@test.invalid','{}','{}'),
 ('05710000-0000-4000-8000-000000000003','authenticated','authenticated','removed@test.invalid','{}','{}'),
 ('05710000-0000-4000-8000-000000000004','authenticated','authenticated','second-pilot@test.invalid','{}','{}'),
 ('05710000-0000-4000-8000-000000000005','authenticated','authenticated','admin@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('05710000-0000-4000-8000-000000000005');
insert into public.storage_r2_pilots(user_id,max_space_bytes) values
 ('05710000-0000-4000-8000-000000000001',1000000000),('05710000-0000-4000-8000-000000000004',1000000000);
insert into public.teams(id,name,owner_id,storage_backend,storage_pilot) values
 ('05710000-0000-4000-8000-000000000011','Pilot R2','05710000-0000-4000-8000-000000000001','r2',true);
insert into public.teams(id,name,owner_id) values
 ('05710000-0000-4000-8000-000000000013','Drive','05710000-0000-4000-8000-000000000005');
insert into public.team_members(team_id,user_id,base_role) values
 ('05710000-0000-4000-8000-000000000011','05710000-0000-4000-8000-000000000001','admin'),
 ('05710000-0000-4000-8000-000000000011','05710000-0000-4000-8000-000000000002','editor'),
 ('05710000-0000-4000-8000-000000000011','05710000-0000-4000-8000-000000000003','viewer'),
 ('05710000-0000-4000-8000-000000000011','05710000-0000-4000-8000-000000000004','viewer'),
 ('05710000-0000-4000-8000-000000000013','05710000-0000-4000-8000-000000000005','admin'),
 ('05710000-0000-4000-8000-000000000013','05710000-0000-4000-8000-000000000001','editor')
 on conflict do nothing;
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('05710000-0000-4000-8000-000000000021','05710000-0000-4000-8000-000000000005','access-drive','admin@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('05710000-0000-4000-8000-000000000031','05710000-0000-4000-8000-000000000013','05710000-0000-4000-8000-000000000021','access-root','Root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type) values
 ('05710000-0000-4000-8000-000000000141','05710000-0000-4000-8000-000000000013','05710000-0000-4000-8000-000000000031','drive-clip','access-root','Drive clip.mp4','file','video','video/mp4');

-- The R2 tree: Root → (F1 → Deep.mp4), Clip.mp4, Old.mp4 (trashed).
insert into public.team_materials(id,team_id,name,kind) values
 ('05710000-0000-4000-8000-000000000101','05710000-0000-4000-8000-000000000011','Root','folder');
update public.teams set storage_root_material_id='05710000-0000-4000-8000-000000000101' where id='05710000-0000-4000-8000-000000000011';
insert into public.team_materials(id,team_id,name,kind,parent_folder_id) values
 ('05710000-0000-4000-8000-000000000102','05710000-0000-4000-8000-000000000011','F1','folder','05710000-0000-4000-8000-000000000101');
insert into public.space_objects(id,team_id,content_id,byte_size,content_type,r2_key)
 select ('05710000-0000-4000-8000-00000000030'||n)::uuid,'05710000-0000-4000-8000-000000000011',repeat(n::text,64),10*n,'video/mp4',
        't/05710000-0000-4000-8000-000000000011/o/'||repeat(n::text,64)
 from generate_series(1,3) n;
insert into public.team_materials(id,team_id,name,kind,category,mime_type,parent_folder_id,space_object_id,size_bytes) values
 ('05710000-0000-4000-8000-000000000111','05710000-0000-4000-8000-000000000011','Clip.mp4','file','video','video/mp4','05710000-0000-4000-8000-000000000101','05710000-0000-4000-8000-000000000301',10),
 ('05710000-0000-4000-8000-000000000112','05710000-0000-4000-8000-000000000011','Deep.mp4','file','video','video/mp4','05710000-0000-4000-8000-000000000102','05710000-0000-4000-8000-000000000302',20),
 ('05710000-0000-4000-8000-000000000113','05710000-0000-4000-8000-000000000011','Old.mp4','file','video','video/mp4','05710000-0000-4000-8000-000000000101','05710000-0000-4000-8000-000000000303',30);
update public.team_materials set lifecycle='trashed',trashed_at=now() where id='05710000-0000-4000-8000-000000000113';

create temporary table seen(label text, value jsonb);
grant all on seen to authenticated;

-- 1. Team lists ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub','05710000-0000-4000-8000-000000000001',true);
select is((select array_agg(id::text order by id) from public.list_my_teams()),
 array['05710000-0000-4000-8000-000000000013'],'the old list never returns an R2 space, so an old client never opens one');
select is((select array_agg(id::text||':'||storage_backend||':'||storage_pilot order by id) from public.list_my_teams_v2()),
 array['05710000-0000-4000-8000-000000000011:r2:true','05710000-0000-4000-8000-000000000013:drive:false'],
 'the v2 list returns both, each with its backend and pilot mark');
select is((select connection_state from public.list_my_teams_v2() where id='05710000-0000-4000-8000-000000000011'),'none',
 'an R2 space has no Drive connection state');
select is((select content_revision from public.list_my_teams_v2() where id='05710000-0000-4000-8000-000000000011'),0::bigint,
 'and carries its content revision');
select is((select role from public.list_my_teams_v2() where id='05710000-0000-4000-8000-000000000011'),'owner','the owner is the owner');
select set_config('request.jwt.claim.sub','05710000-0000-4000-8000-000000000002',true);
select is((select count(*)::int from public.list_my_teams_v2() where id='05710000-0000-4000-8000-000000000011'),0,
 'an invited member who is not a pilot does not see the pilot space');
select throws_ok($$select public.list_team_folder_page('05710000-0000-4000-8000-000000000011')$$,'42501','PERMISSION_DENIED',
 'nor can they read it');
select set_config('request.jwt.claim.sub','05710000-0000-4000-8000-000000000004',true);
select is((select count(*)::int from public.list_my_teams_v2() where id='05710000-0000-4000-8000-000000000011'),1,
 'a member who is a pilot sees it without any tariff');

-- 2. Lists over R2 rows -------------------------------------------------------------------
select set_config('request.jwt.claim.sub','05710000-0000-4000-8000-000000000001',true);
insert into seen select 'page',public.list_team_folder_page('05710000-0000-4000-8000-000000000011');
insert into seen select 'page_f1',public.list_team_folder_page('05710000-0000-4000-8000-000000000011','05710000-0000-4000-8000-000000000102');
insert into seen select 'subtree',public.list_team_folder_subtree('05710000-0000-4000-8000-000000000011','05710000-0000-4000-8000-000000000101');
insert into seen select 'drive_page',public.list_team_folder_page('05710000-0000-4000-8000-000000000013');
select is((select (value->>'total')::int from seen where label='page'),2,'the folder page of the root counts F1 and Clip');
select is((select array_agg(r->>'name' order by r->>'sortKey') from seen, jsonb_array_elements(value->'rows') r where label='page'),
 array['F1','Clip.mp4'],'folders first, the trashed file left out');
select is((select r->>'parentFolderId' from seen, jsonb_array_elements(value->'rows') r where label='page' and r->>'name'='Clip.mp4'),
 '05710000-0000-4000-8000-000000000101','an R2 row''s parent is its folder''s id');
select ok((select (r->'driveFileId') = 'null'::jsonb from seen, jsonb_array_elements(value->'rows') r where label='page' and r->>'name'='Clip.mp4'),
 'and it has no Drive id');
select is((select array_agg(r->>'name') from seen, jsonb_array_elements(value->'rows') r where label='page_f1'),array['Deep.mp4'],
 'a sub-folder page lists its own children');
select is((select array_agg(r->>'name' order by r->>'name') from seen, jsonb_array_elements(value->'items') r where label='subtree'),
 array['Clip.mp4','Deep.mp4'],'the subtree read walks R2 folders by id');
select is((select (value->>'truncated')::boolean from seen where label='subtree'),false,'and was not cut');
select is((select array_agg(name||':'||child_folder_count||':'||child_file_count order by name) from public.list_team_folder_tree('05710000-0000-4000-8000-000000000011')),
 array['F1:0:1','Root:1:1'],'the tree counts R2 children by folder id');
select is((select parent_folder_id from public.list_team_folder_tree('05710000-0000-4000-8000-000000000011') where name='F1'),
 '05710000-0000-4000-8000-000000000101','and gives the parent folder id');
select is((select array_agg(name order by name) from public.list_team_materials('05710000-0000-4000-8000-000000000011')),
 array['Clip.mp4','F1'],'the material list defaults to the R2 root');
select is((select array_agg(name) from public.list_team_materials('05710000-0000-4000-8000-000000000011','05710000-0000-4000-8000-000000000102')),
 array['Deep.mp4'],'and reads a given R2 folder');
select is((select name||':'||parent_path_hint from public.list_team_trashed_materials_v2('05710000-0000-4000-8000-000000000011')),
 'Old.mp4:Root','the trash names the R2 parent folder');
select is((select array_agg(r->>'name') from seen, jsonb_array_elements(value->'rows') r where label='drive_page'),array['Drive clip.mp4'],
 'a Drive space still lists by its connection');
select is((select r->>'driveFileId' from seen, jsonb_array_elements(value->'rows') r where label='drive_page'),'drive-clip',
 'with its Drive id');
reset role;

-- 3. access_epoch -------------------------------------------------------------------------
create function pg_temp.epoch(p_team text) returns bigint language sql as $$ select access_epoch from public.teams where id=p_team::uuid $$;
update public.team_members set base_role='viewer' where team_id='05710000-0000-4000-8000-000000000011' and user_id='05710000-0000-4000-8000-000000000002';
select is(pg_temp.epoch('05710000-0000-4000-8000-000000000011'),1::bigint,'a role change raises the epoch');
update public.team_members set permission_overrides='{"download": false}' where team_id='05710000-0000-4000-8000-000000000011' and user_id='05710000-0000-4000-8000-000000000003';
select is(pg_temp.epoch('05710000-0000-4000-8000-000000000011'),2::bigint,'so does a permission override');
update public.team_members set status='removed',removed_at=now() where team_id='05710000-0000-4000-8000-000000000011' and user_id='05710000-0000-4000-8000-000000000003';
select is(pg_temp.epoch('05710000-0000-4000-8000-000000000011'),3::bigint,'and removing a member');
delete from public.team_members where team_id='05710000-0000-4000-8000-000000000011' and user_id='05710000-0000-4000-8000-000000000002';
select is(pg_temp.epoch('05710000-0000-4000-8000-000000000011'),4::bigint,'and deleting a membership row');
update public.team_members set joined_at=joined_at where team_id='05710000-0000-4000-8000-000000000011' and user_id='05710000-0000-4000-8000-000000000004';
select is(pg_temp.epoch('05710000-0000-4000-8000-000000000011'),4::bigint,'a change that grants nothing does not');
select set_config('request.jwt.claim.sub','05710000-0000-4000-8000-000000000005',true);
select ok(public.admin_remove_storage_r2_pilot('05710000-0000-4000-8000-000000000004'),'the administrator removes a pilot');
select is(pg_temp.epoch('05710000-0000-4000-8000-000000000011'),5::bigint,'which raises the epoch of the pilot spaces they belong to');
update public.team_members set base_role='viewer' where team_id='05710000-0000-4000-8000-000000000013' and user_id='05710000-0000-4000-8000-000000000001';
select is(pg_temp.epoch('05710000-0000-4000-8000-000000000013'),0::bigint,'a Drive space keeps epoch 0: no grant reads it');

select * from finish();
rollback;
