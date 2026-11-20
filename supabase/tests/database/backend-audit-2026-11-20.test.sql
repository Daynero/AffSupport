begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(24);

-- Backend audit 2026-11-20 (20261220100000 … 20261220140000). The PGlite suites cover what
-- the functions answer. This file covers what only a real Supabase database has: default
-- privileges on new public objects, the analytics read-only role, pg_cron, and Vault as an
-- extension-owned table.

-- The attachment cleanup inventory -------------------------------------------------------
select ok(private.task_cleanup_coverage_verified(),
  'every table that can hold a material reference still carries the cleanup guard');
select is(
  (select count(*)::int from private.task_cleanup_reference_tables()
    where table_name = 'team_recovery_claim_receipts'),
  0, 'recovery receipts gained no jsonb column and stay outside the inventory');
select has_trigger('public', 'analytics_tool_contract_sets', 'task_cleanup_reference_fence',
  'the contract dictionary carries the cleanup guard');

-- The contract dictionary ----------------------------------------------------------------
select ok((select relrowsecurity from pg_class
            where oid = 'public.analytics_tool_contract_sets'::regclass),
  'the dictionary has RLS enabled');
select ok(not has_table_privilege('anon', 'public.analytics_tool_contract_sets', 'select'),
  'anon cannot read the dictionary');
select ok(not has_table_privilege('authenticated', 'public.analytics_tool_contract_sets', 'select'),
  'authenticated cannot read the dictionary');
select ok(not has_table_privilege('authenticated', 'public.analytics_tool_contract_sets', 'insert'),
  'authenticated cannot write the dictionary directly');
select ok(not has_table_privilege('service_role', 'public.analytics_tool_contract_sets', 'insert'),
  'service_role holds no grant on the dictionary');
select ok(has_table_privilege('wishly_analytics_ro', 'public.analytics_tool_contract_sets', 'select'),
  'the analytics CLI role can read the dictionary');
select ok(not has_table_privilege('wishly_analytics_ro', 'public.analytics_tool_contract_sets', 'insert'),
  'the analytics CLI role cannot write it');
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'analytics_tool_contract_sets'
      and policyname = 'analytics_readonly_select' and roles = '{wishly_analytics_ro}'),
  1, 'the only policy on the dictionary is the read-only one');
select ok(not has_function_privilege('authenticated',
    'private.analytics_tool_contract_list_is_plain(jsonb)', 'execute'),
  'the shape test is not callable by API roles');

-- Ingestion as PostgREST reaches it ------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data)
values ('f1000000-0000-4000-8000-0000000000a1', 'audit-lean@example.test', '{"full_name":"Lean"}'::jsonb);

set local role authenticated;
set local request.jwt.claim.sub = 'f1000000-0000-4000-8000-0000000000a1';
select results_eq(
  $$select accepted from public.ingest_analytics_events(
      '[{"event_id":"f1000000-0000-4000-8000-0000000000a2","event_name":"tool_opened",
         "properties":{},"tool_contracts":{"compressor":3,"teamWorkspace":2}},
        {"event_id":"f1000000-0000-4000-8000-0000000000a3","event_name":"tool_opened",
         "properties":{},"tool_contracts":{"note":"free text"}},
        {"event_id":"f1000000-0000-4000-8000-0000000000a4","event_name":"tool_opened",
         "properties":{},"tool_contracts":[1]}]'::jsonb) order by event_id$$,
  array[true, true, false],
  'a plain list and an odd object are accepted, a non-object is refused as before');
reset role;

select is(
  (select tool_contracts::text || ' ' || (tool_contract_set_id is not null)::text
     from public.analytics_events where event_id = 'f1000000-0000-4000-8000-0000000000a2'),
  '{} true', 'a plain list is referenced, not repeated in the event');
select is(
  (select tool_contracts::text || ' ' || (tool_contract_set_id is not null)::text
     from public.analytics_events where event_id = 'f1000000-0000-4000-8000-0000000000a3'),
  '{"note": "free text"} false', 'anything else stays in its own event');
select is(
  (select contracts::text from public.analytics_tool_contract_sets
    where id = (select tool_contract_set_id from public.analytics_events
                 where event_id = 'f1000000-0000-4000-8000-0000000000a2')),
  '{"compressor": 3, "teamWorkspace": 2}', 'the dictionary holds the list');

-- Indexes --------------------------------------------------------------------------------
select has_index('public', 'analytics_events', 'analytics_events_installation_created_idx',
  'the index `analytics investigate <installation id>` resolves through is kept');
select hasnt_index('public', 'analytics_events', 'analytics_events_local_build_idx',
  'the never-read build index is gone');
select hasnt_index('public', 'analytics_events', 'analytics_events_user_id_idx',
  'the copy of the leading column of the user/time index is gone');
select has_index('private', 'catalog_video_variants', 'catalog_video_variants_output_material_idx',
  'a variant can be found by its output');

-- Retention jobs and their functions -----------------------------------------------------
select is(
  (select schedule from cron.job where jobname = 'soty-restitch-candidate-retention'),
  '23 * * * *', 'the candidate retention job is scheduled hourly');
select ok(not has_function_privilege('service_role',
    'private.prune_settled_restitch_candidates(integer)', 'execute'),
  'the candidate prune is not callable by API roles');
select ok(not has_function_privilege('service_role',
    'private.prune_empty_recovery_claims(integer)', 'execute'),
  'the recovery prune is not callable by API roles');

-- The recovery prune against the real Vault: a jobless receipt goes with its secret.
-- Only the receipt and its secret matter here; who the delegation belongs to is covered by
-- the recovery suites, so the fixture rows skip the ownership checks.
do $$
declare
  v_delegation uuid := gen_random_uuid(); v_secret uuid;
begin
  v_secret := vault.create_secret('{"job":null,"operationCredential":null}',
    'soty-recovery-claim-' || gen_random_uuid()::text, 'Scoped recovery claim');
  set local session_replication_role = replica;
  insert into private.team_recovery_delegations (id, team_id, actor_id, installation_id, refresh_hash)
  values (v_delegation, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
    decode(repeat('a9', 32), 'hex'));
  insert into private.team_recovery_claim_receipts
    (delegation_id, request_id, state, response_secret_id, created_at)
  values (v_delegation, gen_random_uuid(), 'confirmed', v_secret, clock_timestamp() - interval '2 hours');
  set local session_replication_role = origin;
  perform set_config('soty.audit_secret', v_secret::text, true);
  perform private.prune_empty_recovery_claims(100000);
end $$;
select is(
  (select count(*)::int from vault.secrets
    where id = current_setting('soty.audit_secret')::uuid),
  0, 'the prune removes a jobless receipt''s secret from the real Vault');

select * from finish();
rollback;
