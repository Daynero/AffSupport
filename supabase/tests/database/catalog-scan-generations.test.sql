begin;
select plan(14);
insert into auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
values ('fc270000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'generations@example.test', '{}', '{}');
insert into public.teams(id, name, owner_id)
values ('fc270000-0000-4000-8000-000000000002', 'Generations', 'fc270000-0000-4000-8000-000000000001');
insert into private.google_drive_credentials(id, connected_by, google_permission_id, google_account_email, vault_secret_id, scope)
values ('fc270000-0000-4000-8000-000000000003', 'fc270000-0000-4000-8000-000000000001',
  'generations', 'generations@example.test', gen_random_uuid(), 'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id, team_id, credential_id, root_folder_id, root_folder_name, drive_kind, state)
values ('fc270000-0000-4000-8000-000000000004', 'fc270000-0000-4000-8000-000000000002',
  'fc270000-0000-4000-8000-000000000003', 'root', 'Root', 'my_drive', 'connected');
select private.enqueue_catalog_sync('fc270000-0000-4000-8000-000000000004', 'initial_scan', '{}', '["root"]');
update private.catalog_sync_jobs set next_attempt_at = now() + interval '1 day'
where connection_id <> 'fc270000-0000-4000-8000-000000000004';
create temp table scan_claim as select * from public.service_claim_catalog_sync_work('scan-test', 1, 180);
create temp table scan_generation as select g.* from scan_claim c,
  lateral public.service_begin_catalog_folder(c.job_id, 'scan-test', c.lease_epoch, 'root') g;
select is((select count(*)::int from scan_generation), 1, 'lease opens one generation');
select ok(public.service_commit_catalog_scan_page((select job_id from scan_claim), 'scan-test',
  (select lease_epoch from scan_claim), (select generation from scan_generation), null, 'page-2',
  '[{"drive_file_id":"child","name":"Child","kind":"folder","parent_folder_id":"root"}]', false),
  'catalog, seen entries, frontier and checkpoint commit together');
select is((select page_token from private.catalog_scan_generations where id = (select generation from scan_generation)),
  'page-2', 'page position is durable');
select is((select count(*)::int from private.catalog_scan_seen where generation = (select generation from scan_generation)),
  1, 'seen set is durable');
select is((select state from private.catalog_scan_frontier where job_id = (select job_id from scan_claim) and folder_id = 'child'),
  'queued', 'child traversal is durable');
select ok(not public.service_commit_catalog_scan_page((select job_id from scan_claim), 'scan-test',
  (select lease_epoch from scan_claim), (select generation from scan_generation), null, null, '[]', true),
  'out-of-order page is refused');
select throws_ok($$select public.service_commit_catalog_scan_page((select job_id from scan_claim), 'scan-test',
  (select lease_epoch from scan_claim), (select generation from scan_generation), 'page-2', null, '[]', false)$$,
  '22023', 'INCOMPLETE_LISTING', 'incomplete final page is not absence proof');
create temp table scan_restart as select g.* from scan_claim c,
  lateral public.service_begin_catalog_folder(c.job_id, 'scan-test', c.lease_epoch, 'root', true) g;
select isnt((select generation from scan_restart), (select generation from scan_generation), 'restart creates a distinct generation');
select ok(not public.service_commit_catalog_scan_page((select job_id from scan_claim), 'scan-test',
  (select lease_epoch from scan_claim), (select generation from scan_generation), 'page-2', null, '[]', true),
  'abandoned generation cannot commit');
select ok(not has_table_privilege('authenticated', 'private.catalog_scan_seen', 'select'), 'browser cannot inspect staging');
select ok(not has_function_privilege('authenticated',
  'public.service_commit_catalog_scan_page(uuid,text,bigint,uuid,text,text,jsonb,boolean)', 'execute'), 'browser cannot commit scans');
select ok(not has_function_privilege('service_role',
  'private.upsert_catalog_snapshot(uuid,text,jsonb,pg_snapshot)', 'execute'), 'guarded upsert cannot bypass lease RPC');
select ok(has_function_privilege('authenticated', 'public.get_team_folder_sync_status(uuid,uuid)', 'execute'), 'members can request a safe status projection');
select throws_ok($$select public.service_resolve_catalog_candidate((select job_id from scan_claim), 'scan-test',
  (select lease_epoch from scan_claim), (select generation from scan_restart), 'child', 0, 'present',
  '{"drive_file_id":"child","trashed":false}')$$,
  '22023', 'PROVIDER_PROOF_REQUIRED', 'partial metadata cannot consume a missing candidate');
select * from finish();
rollback;
