begin;
select plan(8);

select ok(has_function_privilege('authenticated',
  'public.get_team_storage_health_v2(uuid)', 'execute'),
  'members may request coverage health');
select ok(not has_function_privilege('anon',
  'public.get_team_storage_health_v2(uuid)', 'execute'),
  'anonymous callers cannot request coverage health');

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
values ('b0270000-0000-4000-8000-000000000001','authenticated','authenticated',
  'coverage-pgtap@example.test','{}','{}');
insert into public.teams(id,name,owner_id)
values ('b0270000-0000-4000-8000-000000000011','Coverage health',
  'b0270000-0000-4000-8000-000000000001');
insert into public.admin_users(user_id)
values ('b0270000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role)
values ('b0270000-0000-4000-8000-000000000011',
  'b0270000-0000-4000-8000-000000000001','admin');
insert into private.google_drive_credentials
  (id,google_permission_id,google_account_email,scope,vault_secret_id,connected_by)
values ('b0270000-0000-4000-8000-000000000021','coverage-pgtap',
  'coverage-pgtap@example.test','https://www.googleapis.com/auth/drive.file',
  gen_random_uuid(),'b0270000-0000-4000-8000-000000000001');
insert into public.team_drive_connections
  (id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state)
values ('b0270000-0000-4000-8000-000000000031',
  'b0270000-0000-4000-8000-000000000011',
  'b0270000-0000-4000-8000-000000000021','root','Root','my_drive','connected');
insert into private.catalog_sync_jobs(id,connection_id,job_kind,phase,cursor)
values ('b0270000-0000-4000-8000-000000000041',
  'b0270000-0000-4000-8000-000000000031','incremental','incremental','{}');

select set_config('request.jwt.claim.sub','b0270000-0000-4000-8000-000000000001',true);
select is(public.get_team_storage_health_v2('b0270000-0000-4000-8000-000000000011')->>'coverage',
  'unknown', 'an empty unconfirmed catalog is not complete');
select is(public.get_team_storage_health_v2('b0270000-0000-4000-8000-000000000011')->>'lastConfirmedAt',
  null, 'connection creation is not a confirmed sync');
update public.team_drive_connections set initial_sync_state = 'ready', last_synced_at = now()
where id = 'b0270000-0000-4000-8000-000000000031';
select is(public.get_team_storage_health_v2('b0270000-0000-4000-8000-000000000011')->>'coverage',
  'complete', 'confirmed empty listing is complete');
insert into private.catalog_sync_jobs(connection_id,job_kind,phase,cursor,requested_folder_id,state)
values ('b0270000-0000-4000-8000-000000000031','discovered_subtree',
  'initial_scan','{}','moved-in','pending');
select is(public.get_team_storage_health_v2('b0270000-0000-4000-8000-000000000011')->>'coverage',
  'partial', 'an unscanned discovered subtree makes coverage partial');
update private.catalog_sync_jobs set state = 'retry', last_error_code = 'RATE_LIMITED'
where id = 'b0270000-0000-4000-8000-000000000041';
select is(public.get_team_storage_health_v2('b0270000-0000-4000-8000-000000000011')->>'syncHealth',
  'delayed', 'rate limit is delayed, not authorization loss');
update public.team_drive_connections set state = 'needs_reauth'
where id = 'b0270000-0000-4000-8000-000000000031';
select is(public.get_team_storage_health_v2('b0270000-0000-4000-8000-000000000011')->>'nextAction',
  'reconnect', 'authorization loss has a distinct action');

select * from finish();
rollback;
