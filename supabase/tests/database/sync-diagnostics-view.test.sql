begin;
select plan(9);

-- 028, release A: the diagnostics view is a whitelist. Anything that could
-- name a Drive item or move a cursor must never appear in it, and only the
-- read-only analytics role may read it.

select has_view('public', 'analytics_catalog_sync_jobs', 'diagnostics view exists');

select is(
  (select count(*)::int from information_schema.columns
   where table_schema = 'public' and table_name = 'analytics_catalog_sync_jobs'
     and column_name in ('cursor', 'folder_queue', 'confirmed_cursor', 'page_token', 'lease_owner',
       'requested_folder_id', 'change_page_token', 'name', 'root_folder_name')),
  0, 'no cursor, token, lease owner or name column');

select ok(
  array['job_id', 'team_id', 'connection_id', 'connection_state', 'job_kind', 'phase', 'state',
    'scope_hash', 'created_at', 'scan_completed_at', 'last_progress_at', 'lease_expires_at',
    'attempts', 'lease_lost_count', 'next_attempt_at', 'replay_after', 'canonical_state',
    'canonical_error_code', 'last_error_code', 'error_detail', 'recovery_count'] <@
  (select array_agg(column_name::text) from information_schema.columns
   where table_schema = 'public' and table_name = 'analytics_catalog_sync_jobs'),
  'every contract column is present');

select ok(not has_table_privilege('authenticated', 'public.analytics_catalog_sync_jobs', 'select'),
  'authenticated cannot read diagnostics');
select ok(not has_table_privilege('anon', 'public.analytics_catalog_sync_jobs', 'select'),
  'anon cannot read diagnostics');
select ok(not has_table_privilege('service_role', 'public.analytics_catalog_sync_jobs', 'select'),
  'service_role does not need diagnostics');
select ok(has_table_privilege('wishly_analytics_ro', 'public.analytics_catalog_sync_jobs', 'select'),
  'the read-only analytics role may read diagnostics');
select ok(not has_table_privilege('wishly_analytics_ro', 'public.analytics_catalog_sync_jobs', 'insert'),
  'the read-only analytics role cannot write through the view');

select is((select reloptions::text from pg_class
  where relname = 'analytics_catalog_sync_jobs' and relnamespace = 'public'::regnamespace),
  '{security_invoker=false}', 'the view reads private tables as its owner');

select * from finish();
rollback;
