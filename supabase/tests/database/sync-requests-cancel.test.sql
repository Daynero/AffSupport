begin;
select plan(12);

-- 028, release B: requests, cancel and counters. The state machine is covered
-- by tests/catalog-sync-cancel.test.ts; this suite pins the schema, grants and
-- the fence on the new replay overloads.

select has_table('private', 'catalog_sync_requests', 'requests table');
select col_is_unique('private', 'catalog_sync_requests', array['team_id', 'request_key'], 'one row per key per team');
select has_column('private', 'catalog_sync_jobs', 'cancel_requested_at', 'cancel marker');
select has_column('private', 'catalog_sync_jobs', 'files_added', 'files_added counter');
select has_column('private', 'catalog_sync_jobs', 'folders_done', 'folders_done counter');

select has_function('public', 'request_team_folder_resync', array['uuid', 'text', 'text'], 'keyed folder request');
select has_function('public', 'request_team_catalog_resync', array['uuid', 'text'], 'keyed root request');
select has_function('public', 'cancel_team_folder_sync', array['uuid', 'uuid'], 'cancel RPC');
select has_function('public', 'service_upsert_catalog_page', array['uuid', 'text', 'bigint', 'uuid', 'text', 'jsonb'], 'fenced replay upsert');

select ok(has_function_privilege('authenticated', 'public.cancel_team_folder_sync(uuid, uuid)', 'execute'),
  'members may call cancel (the body checks who may)');
select ok(not has_function_privilege('authenticated', 'public.service_upsert_catalog_page(uuid, text, bigint, uuid, text, jsonb)', 'execute'),
  'the fenced replay upsert is service-only');
select ok(not has_table_privilege('authenticated', 'private.catalog_sync_requests', 'select'),
  'requests are reachable only through RPC');

select * from finish();
rollback;
