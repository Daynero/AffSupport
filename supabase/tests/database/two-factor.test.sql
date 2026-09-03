begin;

select plan(14);

-- Feature 016. The posture of the 2FA notebook, against a real Postgres.
--
-- The Vitest suite (tests/two-factor-sql.test.ts) covers the behaviour, but it
-- runs on a PGlite superuser connection with a JWT claim set, so it can only
-- observe that grants and RLS exist. Whether they are *enforced* — whether a
-- client role can reach around the functions to the table, or call a function it
-- was never granted — is this file's question, because only a real Postgres with
-- real roles can answer it.

select has_schema('private', 'the private schema exists');
select has_table('private', 'two_factor_entries', 'the notebook table exists');

select ok(
  (select relrowsecurity
   from pg_catalog.pg_class
   where oid = 'private.two_factor_entries'::regclass),
  'the notebook table has row level security'
);

-- No policy at all, and that is the design rather than an omission: the definer
-- functions are meant to be the only door, so there is nothing for a policy to
-- let through. A policy appearing here later would be a second door.
select is_empty(
  $$
    select policyname
    from pg_catalog.pg_policies
    where schemaname = 'private' and tablename = 'two_factor_entries'
  $$,
  'no row policy exists on the notebook table'
);

-- A client role holds nothing on the table — not write, not read. A seed is
-- standing account access; the table is not something to be selective about.
select is_empty(
  $$
    select privilege_type
    from information_schema.role_table_grants
    where grantee in ('anon', 'authenticated')
      and table_schema = 'private'
      and table_name = 'two_factor_entries'
  $$,
  'no client role holds any grant on the notebook table'
);

select is_empty(
  $$
    select column_name
    from information_schema.column_privileges
    where grantee in ('anon', 'authenticated')
      and table_schema = 'private'
      and table_name = 'two_factor_entries'
  $$,
  'no client role holds a column grant on the notebook table'
);

-- Every function is a definer with a pinned search path. Without the pin, a
-- caller who can create a schema can shadow an unqualified name and be run as
-- the definer.
select ok(
  (select bool_and(p.prosecdef)
   from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like '%two_factor%'),
  'every notebook function runs as security definer'
);

select ok(
  (select bool_and(array_to_string(p.proconfig, ',') like '%search_path=%')
   from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like '%two_factor%'),
  'every notebook function pins its search path'
);

-- The signed-in owner is the only caller these functions answer.
select function_privs_are(
  'public', 'list_two_factor_entries', array[]::text[],
  'authenticated', array['EXECUTE'],
  'a signed-in person may list their notebook'
);
select function_privs_are(
  'public', 'create_two_factor_entry', array['text', 'text'],
  'authenticated', array['EXECUTE'],
  'a signed-in person may add an entry'
);
select function_privs_are(
  'public', 'update_two_factor_entry', array['uuid', 'text', 'text'],
  'authenticated', array['EXECUTE'],
  'a signed-in person may edit an entry'
);
select function_privs_are(
  'public', 'delete_two_factor_entry', array['uuid'],
  'authenticated', array['EXECUTE'],
  'a signed-in person may delete an entry'
);

-- A signed-out visitor may not call any of them. `anon` reaching
-- list_two_factor_entries would be every notebook in the database, because the
-- function runs as its definer.
select is_empty(
  $$
    select p.proname
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like '%two_factor%'
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  $$,
  'a signed-out visitor may call none of the notebook functions'
);

-- The validation helper is internal: it is a boundary check the functions run,
-- not an oracle for anyone to ask about seed shapes.
select is_empty(
  $$
    select p.proname
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.proname = 'two_factor_secret_is_plausible'
      and (has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  $$,
  'no client role may call the seed validation helper'
);

select * from finish();

rollback;
