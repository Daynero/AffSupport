begin;
select plan(18);

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
values ('fd000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
  'folder-resync@example.test', '{}', '{}');
insert into public.admin_users (user_id) values ('fd000000-0000-4000-8000-000000000001');
insert into public.teams (id, name, owner_id) values
  ('fd000000-0000-4000-8000-000000000002', 'Folder resync test', 'fd000000-0000-4000-8000-000000000001');
insert into public.team_members (team_id, user_id, base_role) values
  ('fd000000-0000-4000-8000-000000000002', 'fd000000-0000-4000-8000-000000000001', 'admin');
insert into private.google_drive_credentials
  (id, connected_by, google_permission_id, google_account_email, vault_secret_id, scope)
values ('fd000000-0000-4000-8000-000000000003', 'fd000000-0000-4000-8000-000000000001',
  'resync-test', 'folder-resync@example.test', gen_random_uuid(), 'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections
  (id, team_id, credential_id, root_folder_id, root_folder_name, drive_kind, state, initial_sync_state, change_page_token)
values ('fd000000-0000-4000-8000-000000000004', 'fd000000-0000-4000-8000-000000000002',
  'fd000000-0000-4000-8000-000000000003', 'root', 'Root', 'my_drive', 'connected', 'ready', 'original');
insert into public.team_materials (team_id, connection_id, drive_file_id, parent_folder_id, name, kind)
values ('fd000000-0000-4000-8000-000000000002', 'fd000000-0000-4000-8000-000000000004',
  'doctors', 'root', 'Doctors', 'folder');
select set_config('request.jwt.claim.sub', 'fd000000-0000-4000-8000-000000000001', true);
create temp table resync_test_job as
  select * from public.request_team_folder_resync('fd000000-0000-4000-8000-000000000002', 'doctors');
select is((select sync_job_id from public.request_team_folder_resync(
  'fd000000-0000-4000-8000-000000000002', 'doctors')),
  (select sync_job_id from resync_test_job), 'repeated clicks reuse the active scan');
select is((select folder_queue from private.catalog_sync_jobs where id = (select sync_job_id from resync_test_job)),
  '["doctors"]'::jsonb, 'only the requested subtree is queued');
insert into public.team_materials (team_id, connection_id, drive_file_id, parent_folder_id, name, kind)
values ('fd000000-0000-4000-8000-000000000002', 'fd000000-0000-4000-8000-000000000004',
  'root', null, 'Root', 'folder'),
  ('fd000000-0000-4000-8000-000000000002', 'fd000000-0000-4000-8000-000000000004',
  'please', 'doctors', 'Please', 'folder');
select is((select sync_job_id from public.request_team_folder_resync(
  'fd000000-0000-4000-8000-000000000002', 'please')),
  (select sync_job_id from resync_test_job), 'descendant joins active ancestor');
select is((select sync_job_id from public.request_team_folder_resync(
  'fd000000-0000-4000-8000-000000000002', 'root')),
  (select sync_job_id from resync_test_job), 'queued descendant widens to requested ancestor');
select is((select requested_folder_id from private.catalog_sync_jobs where id = (select sync_job_id from resync_test_job)),
  'root', 'widening stores the broader scope');
select is((select status from public.get_team_folder_resync_status(
  'fd000000-0000-4000-8000-000000000002', (select sync_job_id from resync_test_job))), 'running', 'queued is not done');
update private.catalog_sync_jobs set next_attempt_at = now() + interval '1 day'
where connection_id <> 'fd000000-0000-4000-8000-000000000004';
select id from private.claim_catalog_sync_jobs('test', 1, 60);
select ok(public.service_complete_catalog_sync_job((select sync_job_id from resync_test_job), 'test', 'new-token'),
  'worker completes listing');
select is((select status from public.get_team_folder_resync_status(
  'fd000000-0000-4000-8000-000000000002', (select sync_job_id from resync_test_job))), 'running', 'listing waits for canonical replay');
select is((select change_page_token from public.team_drive_connections where id = 'fd000000-0000-4000-8000-000000000004'),
  'original', 'manual scan preserves the background cursor');
select public.service_complete_catalog_sync_job(id, 'feed', 'canonical-token')
from private.claim_catalog_sync_jobs('feed', 1, 60);
select is((select status from public.get_team_folder_resync_status(
  'fd000000-0000-4000-8000-000000000002', (select sync_job_id from resync_test_job))), 'succeeded', 'completion is observable');
select is((select state from private.catalog_sync_jobs where id = (select sync_job_id from resync_test_job)),
  'succeeded', 'manual scan does not become a permanent poller');
select is((select change_page_token from public.team_drive_connections where id = 'fd000000-0000-4000-8000-000000000004'),
  'canonical-token', 'only the canonical feed advances the cursor');
select ok(not has_function_privilege('anon', 'public.get_team_folder_resync_status(uuid,uuid)', 'execute'),
  'anonymous callers cannot read job status');
select set_config('request.jwt.claim.sub', 'fd000000-0000-4000-8000-000000000099', true);
select throws_ok($$select public.get_team_folder_resync_status('fd000000-0000-4000-8000-000000000002',
  (select sync_job_id from resync_test_job))$$, '42501', 'PERMISSION_DENIED', 'foreign caller cannot inspect a job');
select throws_ok($$select public.request_team_folder_resync('fd000000-0000-4000-8000-000000000002', 'doctors')$$,
  '42501', 'PERMISSION_DENIED', 'foreign caller cannot queue a scan');
select set_config('request.jwt.claim.sub', 'fd000000-0000-4000-8000-000000000001', true);
insert into public.team_materials (team_id, connection_id, drive_file_id, parent_folder_id, name, kind)
values ('fd000000-0000-4000-8000-000000000002', 'fd000000-0000-4000-8000-000000000004',
  'campaign', 'root', 'Campaign', 'folder'),
  ('fd000000-0000-4000-8000-000000000002', 'fd000000-0000-4000-8000-000000000004',
  'other', 'campaign', 'Other', 'folder');
create temp table narrow_request as select * from public.request_team_folder_resync(
  'fd000000-0000-4000-8000-000000000002', 'other');
update private.catalog_sync_jobs set state = 'leased', scan_initialized = true,
  lease_owner = 'running', lease_expires_at = now() + interval '3 minutes'
  where id = (select sync_job_id from narrow_request);
create temp table broad_request as select * from public.request_team_folder_resync(
  'fd000000-0000-4000-8000-000000000002', 'campaign');
select isnt((select sync_job_id from broad_request), (select sync_job_id from narrow_request),
  'running descendant gets a broader follow-up');
select is((select sync_job_id from public.request_team_folder_resync(
  'fd000000-0000-4000-8000-000000000002', 'campaign')),
  (select sync_job_id from broad_request), 'repeated broader request joins one follow-up');
select is((select count(*)::int from private.catalog_sync_jobs where connection_id =
  'fd000000-0000-4000-8000-000000000004' and requested_folder_id = 'campaign'
  and state in ('pending', 'leased', 'retry')), 1, 'only one active broad job exists');
select * from finish();
rollback;
