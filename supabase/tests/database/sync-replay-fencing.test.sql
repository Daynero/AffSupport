begin;
select plan(8);

-- 028, release D: the fenced overloads exist, are service-only, and the
-- liveness check is readable by the service role.

select has_column('private', 'catalog_sync_jobs', 'no_progress_runs', 'no_progress_runs column');
select has_function('public', 'service_catalog_sync_lease_live', array['uuid', 'text', 'bigint'], 'liveness check');
select has_function('public', 'service_invalidate_landing_renders', array['uuid', 'text', 'bigint', 'uuid', 'text[]'], 'fenced invalidate');
select has_function('public', 'service_mark_folder_indexed', array['uuid', 'text', 'bigint', 'uuid', 'text'], 'fenced mark indexed');
select has_function('public', 'service_mark_root_state', array['uuid', 'text', 'bigint', 'uuid', 'text', 'text'], 'fenced root state');
select has_function('public', 'service_touch_catalog_reconciled', array['uuid', 'text', 'bigint', 'uuid'], 'fenced touch');
select has_function('public', 'service_enqueue_catalog_reconciliation', array['uuid', 'text', 'bigint', 'uuid'], 'fenced enqueue');
select ok(not has_function_privilege('authenticated', 'public.service_catalog_sync_lease_live(uuid, text, bigint)', 'execute'),
  'liveness check is service-only');

select * from finish();
rollback;
