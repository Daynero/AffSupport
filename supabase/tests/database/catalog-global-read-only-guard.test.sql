begin;
select plan(3);
-- PostgREST runs a STABLE RPC in a read-only transaction; the guard must not lock there.
set transaction read only;
select lives_ok(
  $$select private.catalog_global_assert_legacy_settings()$$,
  'the legacy-settings guard passes inside a read-only transaction'
);
select is(
  (select provolatile::text from pg_proc where oid = 'public.get_team_product_catalog_settings(uuid)'::regprocedure),
  's',
  'the settings read is still STABLE, so PostgREST still sends it read-only'
);
select ok(
  not has_function_privilege('authenticated', 'private.catalog_global_assert_legacy_settings()', 'EXECUTE'),
  'the browser still cannot call the guard directly'
);
select * from finish();
rollback;
