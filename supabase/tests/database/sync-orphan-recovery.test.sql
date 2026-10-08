begin;
select plan(16);

-- 028, release A: orphaned replay waiters recover by the clock, a manual
-- request wakes a retrying feed, expired leases are counted, and the cron
-- maintenance entry point exists. PGlite covers the state machine in detail
-- (tests/catalog-sync-lifecycle.test.ts); this suite pins grants, search_path
-- and the live schedule, which PGlite cannot see.

select has_column('private', 'catalog_sync_jobs', 'error_detail', 'error_detail column');
select has_column('private', 'catalog_sync_jobs', 'scan_completed_at', 'scan_completed_at column');
select has_column('private', 'catalog_sync_jobs', 'lease_lost_count', 'lease_lost_count column');
select has_column('private', 'catalog_sync_authority', 'recovery_count', 'recovery_count column');
select has_column('private', 'catalog_sync_authority', 'last_recovery_at', 'last_recovery_at column');

select has_function('private', 'sweep_catalog_sync_orphans', array['integer', 'interval'], 'sweep function');
select has_function('private', 'run_catalog_sync_maintenance', 'maintenance entry point');
select has_function('private', 'nudge_catalog_sync_feed', array['uuid'], 'feed nudge');
select has_function('private', 'recover_catalog_sync_feed', array['uuid', 'interval'], 'feed recovery');
select has_function('public', 'find_team_folder_sync_request', array['uuid', 'text'], 'request lookup');

select is(
  (select array_agg(proconfig::text) from pg_proc
   where proname in ('sweep_catalog_sync_orphans', 'run_catalog_sync_maintenance',
     'nudge_catalog_sync_feed', 'recover_catalog_sync_feed', 'find_team_folder_sync_request')
     and not ('search_path=' = any(proconfig))),
  null, 'every new function pins search_path to empty');

select ok(not has_function_privilege('authenticated', 'private.sweep_catalog_sync_orphans(integer, interval)', 'execute'),
  'authenticated cannot run the sweep');
select ok(not has_function_privilege('service_role', 'private.run_catalog_sync_maintenance()', 'execute'),
  'service_role cannot run maintenance');
select ok(has_function_privilege('authenticated', 'public.find_team_folder_sync_request(uuid, text)', 'execute'),
  'members may look a request up');

select is((select count(*)::int from cron.job where jobname = 'wishly-catalog-sync-retention'
  and command like '%run_catalog_sync_maintenance%'), 1, 'retention cron runs the maintenance entry point');

select is((select private.sweep_catalog_sync_orphans(10) ? 'canonical_created'), true,
  'sweep reports its counters');

select * from finish();
rollback;
