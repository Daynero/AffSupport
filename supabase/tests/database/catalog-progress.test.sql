begin;
select plan(5);

select is(
  (select schedule from cron.job where jobname = 'wishly-catalog-sync'),
  '10 seconds', 'catalog continuations are eligible every ten seconds'
);
select is_empty(
  $$select p.oid::regprocedure::text from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in
      ('service_save_catalog_sync_progress', 'service_release_catalog_sync_job')
    and (not p.prosecdef or not coalesce(p.proconfig, '{}'::text[]) @> array['search_path=""']::text[])$$,
  'progress helpers are definers with an empty search path'
);
select is_empty(
  $$select p.oid::regprocedure::text from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in
      ('service_save_catalog_sync_progress', 'service_release_catalog_sync_job')
    and (has_function_privilege('anon', p.oid, 'execute')
      or has_function_privilege('authenticated', p.oid, 'execute'))$$,
  'browser callers cannot save or release worker progress'
);
select ok(has_function_privilege('service_role',
  'public.service_save_catalog_sync_progress(uuid,text,text,text,text,jsonb,jsonb)', 'execute'),
  'worker can save progress');
select ok(has_function_privilege('service_role',
  'public.service_release_catalog_sync_job(uuid,text)', 'execute'),
  'worker can release progress');

select * from finish();
rollback;
