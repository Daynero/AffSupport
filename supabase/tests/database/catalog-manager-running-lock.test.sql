begin;
select plan(20);

-- 072 П5 (20261224230000): a running catalog's settings are not changed mid-round; a catalog of a
-- folder the space no longer uses is named as such, not as «reconnect Drive»; the same folder
-- connected again takes its materials back at once; the manager row carries a sign of life.
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('c0720000-0000-4000-8000-000000000001','authenticated','authenticated','running-lock-owner@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('c0720000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
 ('c0720000-0000-4000-8000-000000000011','Running lock fixture','c0720000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000001','admin')
 on conflict do nothing;
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('c0720000-0000-4000-8000-000000000021','c0720000-0000-4000-8000-000000000001','lock-test','running-lock-owner@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('c0720000-0000-4000-8000-000000000031','c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000021','lock-root','Old folder','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version,checksum,lifecycle) values
 ('c0720000-0000-4000-8000-000000000041','c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000031','lock-v1','Alpha.mp4','file','video','video/mp4','1','0123456789abcdef0123456789abcdef','active');
insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version,companion_of,companion_kind,lifecycle) values
 ('c0720000-0000-4000-8000-000000000061','c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000031','lock-s1','Sheet','file','other','application/vnd.google-apps.spreadsheet','1','c0720000-0000-4000-8000-000000000041','product_catalog','active');
insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot)
 values('c0720000-0000-4000-8000-000000000061','c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000041','https://offer.example.invalid/',4,
  'https://docs.google.com/spreadsheets/d/lock/edit','https://drive.google.com/file/d/lock-v1/view','{}');

create function pg_temp.open_round() returns void language sql as $$
 insert into public.team_catalog_updaters(team_id) values('c0720000-0000-4000-8000-000000000011') on conflict (team_id) do nothing;
 insert into public.team_catalog_updater_items(catalog_material_id,team_id,round_due_at,next_attempt_at)
  values('c0720000-0000-4000-8000-000000000061','c0720000-0000-4000-8000-000000000011',clock_timestamp(),clock_timestamp()-interval '1 minute')
  on conflict (catalog_material_id) do update set round_due_at=excluded.round_due_at,next_attempt_at=excluded.next_attempt_at,lease_owner=null,lease_expires_at=null;
$$;
create function pg_temp.close_round() returns void language sql as $$
 update public.team_catalog_update_attempts set result='cancelled',ended_at=clock_timestamp()
  where catalog_material_id='c0720000-0000-4000-8000-000000000061' and result='running';
 update public.team_catalog_updater_items set round_due_at=null,lease_owner=null,lease_expires_at=null
  where catalog_material_id='c0720000-0000-4000-8000-000000000061';
$$;
create function pg_temp.patch(p jsonb) returns jsonb language sql as $$
 select public.patch_team_catalog_update_profile('c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000061',
  (select version from public.team_catalog_update_profiles where catalog_material_id='c0720000-0000-4000-8000-000000000061'),p);
$$;
create function pg_temp.row() returns jsonb language sql as $$
 select e from jsonb_array_elements(public.list_team_catalog_manager_snapshot('c0720000-0000-4000-8000-000000000011')->'catalogs') e
  where e->>'catalog_id'='c0720000-0000-4000-8000-000000000061';
$$;
select set_config('request.jwt.claim.sub','c0720000-0000-4000-8000-000000000001',true);

-- 1. Settings of a running catalog.
select ok(not has_function_privilege('authenticated','private.catalog_has_active_work(uuid)','execute'),'the running check stays private');
select ok(not has_function_privilege('authenticated','private.catalog_manager_runtime(uuid,uuid,uuid)','execute'),'the row runtime stays private');
select lives_ok($$select pg_temp.patch('{"refreshTexts":false}')$$,'an idle catalog takes a settings change');
select pg_temp.open_round();
select ok(private.catalog_has_active_work('c0720000-0000-4000-8000-000000000061'),'an open round is running work');
select throws_ok($$select pg_temp.patch('{"refreshTexts":true}')$$,'55000','WRONG_STATE','a running catalog refuses a settings change');
select throws_ok($$select pg_temp.patch('{"updateInterval":"1h"}')$$,'55000','WRONG_STATE','and a schedule change through the manager');
select is((select refresh_texts from public.team_catalog_update_profiles where catalog_material_id='c0720000-0000-4000-8000-000000000061'),false,'the refused change left the settings as the round took them');
select pg_temp.close_round();
-- An unscheduled item is forgotten once its round ends; the check that follows keeps its own row.
insert into public.team_catalog_updater_items(catalog_material_id,team_id,reconciliation_required)
 values('c0720000-0000-4000-8000-000000000061','c0720000-0000-4000-8000-000000000011',true)
 on conflict (catalog_material_id) do update set reconciliation_required=true;
select throws_ok($$select pg_temp.patch('{"refreshTexts":true}')$$,'55000','WRONG_STATE','a delivery check still being made also holds the settings');
update public.team_catalog_updater_items set reconciliation_required=false where catalog_material_id='c0720000-0000-4000-8000-000000000061';
select lives_ok($$select pg_temp.patch('{"refreshTexts":true}')$$,'after the round the change goes through');

-- 2. A sign of life on the manager row.
select pg_temp.open_round();
select is(pg_temp.row()->>'work_heartbeat_at',null,'a round nobody has reported on has no sign of life');
insert into private.catalog_update_progress(catalog_material_id,worker,stage,updated_at)
 values('c0720000-0000-4000-8000-000000000061','worker-1','refreshing',clock_timestamp())
 on conflict (catalog_material_id) do update set worker=excluded.worker,stage=excluded.stage,updated_at=excluded.updated_at;
select isnt(pg_temp.row()->>'work_heartbeat_at',null,'a stage report is a sign of life');
select isnt(pg_temp.row()->>'round_next_attempt_at',null,'a running round says when it is tried next');
select is(pg_temp.row()#>>'{drive_connection,state}','connected','the row names its Drive connection');

-- 3. The space moves to another folder: the old catalogs are named as such.
update public.team_drive_connections set state='detached',detached_at=now() where id='c0720000-0000-4000-8000-000000000031';
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('c0720000-0000-4000-8000-000000000032','c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000021','other-root','New folder','my_drive','connected',now());
select is((select connection_id from public.team_materials where id='c0720000-0000-4000-8000-000000000061'),'c0720000-0000-4000-8000-000000000031'::uuid,'another folder does not take the old folder''s catalogs');
select is(pg_temp.row()->'drive_connection','{"state":"detached","folderName":"Old folder","spaceFolderName":"New folder"}'::jsonb,'the row says which folder the catalog is in and which one the space uses');
delete from private.catalog_update_progress where catalog_material_id='c0720000-0000-4000-8000-000000000061';
select private.close_unreachable_catalog_rounds();
select is((select result||':'||failure_code from public.team_catalog_update_attempts where catalog_material_id='c0720000-0000-4000-8000-000000000061' order by started_at desc limit 1),'failed:CONNECTION_DETACHED','a round of the previous folder ends as detached, not as «sign in again»');
select is((select last_update_error from public.team_product_catalogs where material_id='c0720000-0000-4000-8000-000000000061'),'CONNECTION_DETACHED','the catalog''s last error says the same');

-- 4. The same folder connected again (disconnect, then connect): the materials come back at once.
update public.team_drive_connections set state='detached',detached_at=now() where id='c0720000-0000-4000-8000-000000000032';
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('c0720000-0000-4000-8000-000000000033','c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000021','lock-root','Old folder','my_drive','connected',now());
select is((select count(*)::integer from public.team_materials where team_id='c0720000-0000-4000-8000-000000000011' and connection_id='c0720000-0000-4000-8000-000000000033'),2,'the sheet and its video move to the new connection of the same folder');
select is(private.catalog_connection_usable('c0720000-0000-4000-8000-000000000061'),true,'the catalog can be updated again');
select is(pg_temp.row()#>>'{drive_connection,state}','connected','and the row no longer reads as another folder''s');

select * from finish();
rollback;
