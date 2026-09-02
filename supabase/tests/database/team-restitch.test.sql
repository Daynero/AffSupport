begin;

select plan(29);

-- Feature 015. What is proved here is the posture, not the behaviour: that the three new
-- tables cannot be read or written around their functions, and that each function asks for
-- the permission it should.

select has_table('public', 'team_restitch_defaults', 'space re-stitch defaults table exists');
select has_table(
  'public', 'team_material_restitch_prep', 'per-material preparation table exists'
);
select has_table('public', 'team_workspace_folders', 'space working folder table exists');

select ok(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'public.team_restitch_defaults'::regclass),
  'defaults table has row level security'
);
select ok(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'public.team_material_restitch_prep'::regclass),
  'preparation table has row level security'
);
select ok(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'public.team_workspace_folders'::regclass),
  'workspace folder table has row level security'
);

-- Direct writes are revoked everywhere: every path goes through a function that re-checks the
-- caller's effective permission.
select is_empty(
  $$
    select table_name || '.' || privilege_type
    from information_schema.role_table_grants
    where grantee in ('anon', 'authenticated')
      and table_schema = 'public'
      and table_name in (
        'team_restitch_defaults', 'team_material_restitch_prep', 'team_workspace_folders'
      )
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  $$,
  'no client role may write the new tables directly'
);

-- The marker is never exposed to the browser: only the edge function that resolves the folder
-- has any use for it, and a leaked marker would let anyone claim a space's folder.
select is_empty(
  $$
    select column_name
    from information_schema.column_privileges
    where grantee in ('anon', 'authenticated')
      and table_schema = 'public'
      and table_name = 'team_workspace_folders'
      and column_name = 'marker'
  $$,
  'the workspace folder marker is not readable by a client role'
);

select has_function('public', 'get_restitch_defaults', array['uuid'], 'defaults reader exists');
select has_function(
  'public', 'set_restitch_defaults', array['uuid', 'jsonb'], 'defaults writer exists'
);
select has_function(
  'public', 'get_material_restitch_prep', array['uuid', 'uuid[]'], 'preparation reader exists'
);
select has_function(
  'public', 'set_material_restitch_prep', array['uuid', 'text', 'jsonb'],
  'preparation writer exists'
);

-- Every one of them is `security definer` with an empty search_path and fully-qualified
-- names; without this a schema on the caller's path could shadow a table.
select ok(
  (select bool_and(p.prosecdef)
   from pg_catalog.pg_proc as p
   join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like '%restitch%'),
  'every re-stitch function is security definer'
);
select ok(
  (select bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%')
   from pg_catalog.pg_proc as p
   join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like '%restitch%'),
  'every re-stitch function pins its search_path'
);

-- Execute is granted to authenticated and to nobody else.
select is_empty(
  $$
    select p.oid::regprocedure::text
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.proname like '%restitch%'
      and has_function_privilege('anon', p.oid, 'execute')
  $$,
  'anonymous callers cannot execute any re-stitch function'
);

select ok(
  (select bool_and(has_function_privilege('authenticated', p.oid, 'execute'))
   from pg_catalog.pg_proc as p
   join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like '%restitch%'),
  'signed-in callers may execute the re-stitch functions'
);

-- The value checks are the last line of defence against a direct call; the shared clamp is
-- the rule the product actually uses.
select col_has_check('public', 'team_restitch_defaults', 'operation', 'operation is checked');
select col_has_check('public', 'team_restitch_defaults', 'fit_mode', 'fit mode is checked');
select col_has_check(
  'public', 'team_restitch_defaults', 'final_duration_mode', 'duration mode is checked'
);

-- The invalidation rule lives in the read, so it cannot be forgotten by a caller.
select ok(
  (select pg_catalog.pg_get_functiondef(p.oid) like '%drive_version is not distinct from%'
   from pg_catalog.pg_proc as p
   join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_material_restitch_prep'),
  'preparation is only returned while it still describes the material'
);

-- The two permissions this feature separates: changing what a space does is a management act,
-- recording what a run found is part of running a tool.
select ok(
  (select pg_catalog.pg_get_functiondef(p.oid) like '%manage_metadata%'
   from pg_catalog.pg_proc as p
   join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'set_restitch_defaults'),
  'only a space manager may change the defaults'
);
select ok(
  (select pg_catalog.pg_get_functiondef(p.oid) like '%''process''%'
   from pg_catalog.pg_proc as p
   join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'set_material_restitch_prep'),
  'recording a preparation needs the process permission'
);

-- A set that cannot produce a file is refused rather than stored as "configured".
select ok(
  (select pg_catalog.pg_get_functiondef(p.oid) like '%RESTITCH_NO_SCREENS%'
   from pg_catalog.pg_proc as p
   join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'set_restitch_defaults'),
  'saving without a usable photo is refused by name'
);

-- The folder's whereabouts are the edge function's business and nobody else's: the marker is
-- what finds it again after a rename, and no client has any use for it.
select ok(
  not has_function_privilege('anon', 'public.service_get_workspace_folder(uuid)', 'execute'),
  'anon cannot read where a space keeps its folder'
);
select ok(
  not has_function_privilege('authenticated', 'public.service_get_workspace_folder(uuid)', 'execute'),
  'a signed-in member cannot read it either'
);
select ok(
  not has_function_privilege('anon', 'public.service_commit_workspace_folder(uuid, text, text)', 'execute'),
  'anon cannot record a space folder'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.service_commit_workspace_folder(uuid, text, text)', 'execute'
  ),
  'a signed-in member cannot record one either'
);
select ok(
  has_function_privilege(
    'service_role', 'public.service_commit_workspace_folder(uuid, text, text)', 'execute'
  ),
  'the edge function can'
);

-- A refusal is a record too: it says the fast path cannot serve this file, which is exactly
-- what stops the answer being worked out again on every download.
select col_is_null(
  'public', 'team_material_restitch_prep', 'source_profile',
  'a preparation may describe a refusal, which has no profile to carry'
);

select * from finish();
rollback;
