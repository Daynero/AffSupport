begin;
select plan(14);

insert into auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
values ('fc260000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'ownership@example.test', '{}', '{}');
insert into public.teams(id, name, owner_id)
values ('fc260000-0000-4000-8000-000000000002', 'Ownership', 'fc260000-0000-4000-8000-000000000001');
insert into private.google_drive_credentials(id, connected_by, google_permission_id, google_account_email, vault_secret_id, scope)
values ('fc260000-0000-4000-8000-000000000003', 'fc260000-0000-4000-8000-000000000001',
  'ownership', 'ownership@example.test', gen_random_uuid(), 'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id, team_id, credential_id, root_folder_id, root_folder_name, drive_kind, state)
values ('fc260000-0000-4000-8000-000000000004', 'fc260000-0000-4000-8000-000000000002',
  'fc260000-0000-4000-8000-000000000003', 'root', 'Root', 'my_drive', 'connected');
select private.enqueue_catalog_sync('fc260000-0000-4000-8000-000000000004', 'initial_scan',
  '{"changePageToken":"opaque-bootstrap"}', '["root"]');
select private.enqueue_catalog_sync('fc260000-0000-4000-8000-000000000004', 'initial_scan', '{}', '["child"]');
select is((select count(*)::int from private.catalog_sync_jobs where connection_id = 'fc260000-0000-4000-8000-000000000004'
  and job_kind = 'incremental'), 1, 'one canonical job');
select throws_ok($$insert into private.catalog_sync_jobs(connection_id, phase, job_kind)
  values ('fc260000-0000-4000-8000-000000000004', 'incremental', 'incremental')$$,
  '23505', null, 'active duplicate rejected by unique index');
update private.catalog_sync_jobs set next_attempt_at = now() + interval '1 day'
where connection_id <> 'fc260000-0000-4000-8000-000000000004';
create temp table ownership_claim as select * from public.service_claim_catalog_sync_work('ownership-test', 3, 60);
select is((select count(*)::int from ownership_claim), 1, 'one lease per connection in a batch');
select ok(private.lock_catalog_sync_lease((select job_id from ownership_claim), 'ownership-test',
  (select lease_epoch from ownership_claim)), 'current lease is authoritative');
select ok(not private.lock_catalog_sync_lease((select job_id from ownership_claim), 'ownership-test',
  (select lease_epoch - 1 from ownership_claim)), 'old epoch rejected');
select ok(public.service_complete_catalog_sync_job((select job_id from ownership_claim), 'ownership-test', 'finite-token'),
  'scan reaches replay barrier');
select is((select state from private.catalog_sync_jobs where id = (select job_id from ownership_claim)),
  'pending', 'finite scan waits for feed replay');
select is((select confirmed_cursor from private.catalog_sync_authority where connection_id = 'fc260000-0000-4000-8000-000000000004'),
  null::text, 'finite token is not a confirmed cursor');
update private.catalog_sync_jobs set next_attempt_at = now() + interval '1 day'
where connection_id = 'fc260000-0000-4000-8000-000000000004' and job_kind <> 'incremental';
create temp table ownership_feed as select * from public.service_claim_catalog_sync_work('feed-test', 1, 60);
select ok(public.service_complete_catalog_sync_job((select job_id from ownership_feed), 'feed-test', 'confirmed-token'),
  'canonical feed commits its cursor');
select is((select state from private.catalog_sync_jobs where id = (select job_id from ownership_claim)),
  'succeeded', 'canonical replay completes finite scan');
select ok(not has_table_privilege('authenticated', 'private.catalog_sync_authority', 'select'), 'cursor provenance is private');
select ok(not has_function_privilege('authenticated', 'public.service_claim_catalog_sync_work(text,integer,integer)', 'execute'),
  'browser cannot claim work');
select ok(not has_function_privilege('service_role', 'public.service_claim_catalog_sync_jobs(text,integer,integer)', 'execute'),
  'old workers cannot acquire new work');
-- Use native Postgres for the long-running regression; a single 1,005-iteration
-- wasm query blocks Vitest's worker event loop and its heartbeat.
do $$ declare canonical uuid; claimed uuid; begin
  select job_id into canonical from ownership_feed;
  for i in 1..1005 loop
    update private.catalog_sync_jobs set next_attempt_at = clock_timestamp() where id = canonical;
    select id into claimed from private.claim_catalog_sync_jobs('no-change', 1, 60);
    if claimed is distinct from canonical then raise exception 'LOST_CANONICAL'; end if;
    perform public.service_complete_catalog_sync_job(canonical, 'no-change', 'confirmed-token');
  end loop;
end $$;
select is((select attempts from private.catalog_sync_jobs where id = (select job_id from ownership_feed)),
  0, '1,005 successful no-change polls do not exhaust the retry budget');
select * from finish();
rollback;
