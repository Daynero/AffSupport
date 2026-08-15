begin;

select plan(267);

select has_schema('private', 'private integration schema exists');
select has_table('public', 'teams', 'teams table exists');
select has_table('public', 'team_members', 'team membership table exists');
select has_table('public', 'team_invitations', 'team invitations table exists');
select has_table('public', 'team_materials', 'team material catalog exists');
select has_table('public', 'team_operations', 'team operation authority exists');
select has_table('private', 'google_drive_credentials', 'Drive credentials are private');
select has_table('private', 'team_transfer_grants', 'transfer grants are private');

select is_empty(
  $$
    select p.oid::regprocedure::text
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and (
        p.proname like 'team_%'
        or p.proname like '%invitation%'
        or p.proname like '%drive%'
        or p.proname like 'service_%'
        or p.proname in (
          'create_team', 'list_my_teams', 'list_team_materials', 'list_team_members',
          'update_membership', 'remove_member', 'transfer_ownership',
          'list_team_audit_events', 'owned_team_count',
          'search_materials', 'get_team_vocab_and_facets', 'update_material_metadata',
          'get_material_preview', 'get_operation', 'get_material_provenance',
          'cancel_team_operation',
          'refresh_team_material_search', 'invoke_catalog_sync_worker',
          'effective_permissions', 'can', 'can_access_team_workspace',
          'record_team_audit', 'issue_team_transfer_grant', 'consume_team_transfer_grant',
          'request_team_catalog_resync'
        )
      )
      and not p.prosecdef
  $$,
  'every team feature function is security definer'
);

select is_empty(
  $$
    select p.oid::regprocedure::text
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and (
        p.proname like 'team_%'
        or p.proname like '%invitation%'
        or p.proname like '%drive%'
        or p.proname like 'service_%'
        or p.proname in (
          'create_team', 'list_my_teams', 'list_team_materials', 'list_team_members',
          'update_membership', 'remove_member', 'transfer_ownership',
          'list_team_audit_events', 'owned_team_count',
          'search_materials', 'get_team_vocab_and_facets', 'update_material_metadata',
          'get_material_preview', 'get_operation', 'get_material_provenance',
          'cancel_team_operation',
          'refresh_team_material_search', 'invoke_catalog_sync_worker',
          'effective_permissions', 'can', 'can_access_team_workspace',
          'record_team_audit', 'issue_team_transfer_grant', 'consume_team_transfer_grant',
          'request_team_catalog_resync'
        )
      )
      and not coalesce(p.proconfig, '{}'::text[]) @> array['search_path=""']::text[]
  $$,
  'every team feature function pins an empty search_path'
);

select is_empty(
  $$
    select p.oid::regprocedure::text
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and (
        p.proname like 'team_%'
        or p.proname like '%invitation%'
        or p.proname like '%drive%'
        or p.proname like 'service_%'
        or p.proname in (
          'create_team', 'list_my_teams', 'list_team_materials', 'list_team_members',
          'update_membership', 'remove_member', 'transfer_ownership',
          'list_team_audit_events', 'owned_team_count',
          'search_materials', 'get_team_vocab_and_facets', 'update_material_metadata',
          'get_material_preview', 'get_operation', 'get_material_provenance',
          'cancel_team_operation',
          'refresh_team_material_search', 'invoke_catalog_sync_worker',
          'effective_permissions', 'can', 'can_access_team_workspace',
          'record_team_audit', 'issue_team_transfer_grant', 'consume_team_transfer_grant',
          'request_team_catalog_resync'
        )
      )
      and has_function_privilege('public', p.oid, 'execute')
  $$,
  'PUBLIC cannot execute a team feature function'
);

select is_empty(
  $$
    select format('%I.%I', n.nspname, c.relname)
    from pg_catalog.pg_class as c
    join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p')
      and n.nspname in ('public', 'private')
      and (
        c.relname like 'team_%'
        or c.relname in (
          'teams', 'geo_options', 'language_options', 'drive_credential_references'
        )
      )
      and (not c.relrowsecurity or not c.relforcerowsecurity)
  $$,
  'all public and private team tables enable and force RLS'
);

select is_empty(
  $$
    select table_name
    from information_schema.role_table_grants
    where table_schema = 'private'
      and table_name in (
        'google_drive_credentials', 'drive_oauth_transactions',
        'team_transfer_grants', 'team_operation_intents',
        'catalog_sync_jobs', 'drive_credential_references'
      )
      and grantee in ('anon', 'authenticated')
  $$,
  'private integration tables have no client grants'
);

select is_empty(
  $$
    select tablename
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and tablename in (
        'team_members', 'team_invitations', 'team_drive_connections',
        'team_materials', 'team_audit_events', 'team_landing_renders'
      )
  $$,
  'Realtime excludes membership, credential-bearing catalog, transcript, and audit rows'
);

select is(
  private.can('00000000-0000-0000-0000-000000000000'::uuid, 'unknown_permission', null),
  false,
  'null/spoofed caller and unknown permission fail closed'
);

select is_empty(
  $$
    select p.oid::regprocedure::text
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and (
        p.proname like 'team_%'
        or p.proname like '%invitation%'
        or p.proname like '%drive%'
        or p.proname like 'service_%'
        or p.proname in (
          'create_team', 'list_my_teams', 'list_team_materials', 'list_team_members',
          'update_membership', 'remove_member', 'transfer_ownership',
          'list_team_audit_events', 'owned_team_count',
          'search_materials', 'get_team_vocab_and_facets', 'update_material_metadata',
          'get_material_preview', 'get_operation', 'get_material_provenance',
          'cancel_team_operation',
          'refresh_team_material_search', 'invoke_catalog_sync_worker',
          'effective_permissions', 'can', 'can_access_team_workspace',
          'record_team_audit', 'issue_team_transfer_grant', 'consume_team_transfer_grant',
          'request_team_catalog_resync'
        )
      )
      and has_function_privilege('authenticated', p.oid, 'execute')
      and not (
        (n.nspname = 'private' and p.proname = 'can')
        or (n.nspname = 'public' and p.proname in (
          'create_team', 'list_my_teams', 'can_access_team_workspace', 'lookup_invitable_account',
          'create_invitation', 'list_my_invitations', 'accept_invitation',
          'list_team_invitations', 'decline_invitation', 'revoke_invitation', 'resend_invitation',
          'get_drive_connection_status', 'request_team_catalog_resync', 'list_team_materials'
          , 'list_team_members', 'update_membership', 'remove_member',
          'transfer_ownership', 'list_team_audit_events',
          'search_materials', 'get_team_vocab_and_facets', 'update_material_metadata',
          'get_material_preview', 'get_operation', 'get_material_provenance',
          'cancel_team_operation', 'list_landing_renders'
        ))
      )
  $$,
  'authenticated can execute only the policy helper and caller-checked RPCs'
);

select is_empty(
  $$
    select p.oid::regprocedure::text
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where (
        (n.nspname = 'private' and p.proname in (
          'record_team_audit', 'store_google_drive_credential',
          'read_google_drive_credential', 'update_google_drive_refresh_token',
          'delete_google_drive_credential', 'create_drive_oauth_transaction',
          'consume_drive_oauth_transaction', 'issue_team_transfer_grant',
          'consume_team_transfer_grant', 'revoke_team_transfer_grants',
          'enqueue_catalog_sync', 'claim_catalog_sync_jobs',
          'checkpoint_catalog_sync_job', 'commit_team_transcript',
          'tombstone_team_material'
        ))
        or (n.nspname = 'public' and p.proname in (
          'read_google_drive_credential', 'issue_team_transfer_grant',
          'consume_team_transfer_grant', 'record_team_audit',
          'service_start_team_operation', 'service_set_team_operation_intent',
          'service_get_team_operation', 'service_bind_team_operation_source',
          'service_get_team_operation_source_binding',
          'service_get_material_operation_context', 'service_resolve_team_folder',
          'service_find_team_name_conflicts', 'service_transition_team_operation',
          'service_release_team_name_reservation', 'service_finalize_uploaded_material',
          'service_commit_team_text_edit', 'service_commit_team_material_mutation'
        ))
      )
      and not has_function_privilege('service_role', p.oid, 'execute')
  $$,
  'every service helper has its required service_role EXECUTE grant'
);

insert into auth.users (
  id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '10000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
    'foundation-owner@example.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '10000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
    'foundation-foreign@example.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '10000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated',
    'foundation-blocked@example.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
  );

update public.profiles
set account_status = 'blocked'
where id = '10000000-0000-4000-8000-000000000003';

-- The test workspace is the designated admin-owned workspace. All following
-- members model the approved team rather than arbitrary user-created teams.
insert into public.admin_users (user_id)
values ('10000000-0000-4000-8000-000000000001');

insert into public.teams (id, name, owner_id)
values (
  '20000000-0000-4000-8000-000000000001',
  'Foundation security team',
  '10000000-0000-4000-8000-000000000001'
);
insert into public.team_members (team_id, user_id, base_role)
values
  (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'admin'
  ),
  (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000003',
    'viewer'
  );

-- A historical self-created team must never satisfy the pilot gate.
insert into public.teams (id, name, owner_id)
values (
  '20000000-0000-4000-8000-000000000002',
  'Legacy self-created team',
  '10000000-0000-4000-8000-000000000002'
);
insert into public.team_members (team_id, user_id, base_role)
values (
  '20000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002',
  'admin'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);

select is(
  public.can_access_team_workspace(),
  true,
  'a product admin may enter the Team Workspace pilot'
);

select is(
  private.can(
    '20000000-0000-4000-8000-000000000001',
    'view',
    '10000000-0000-4000-8000-000000000001'
  ),
  true,
  'active owner receives the generated permission set'
);

select is(
  private.can(
    '20000000-0000-4000-8000-000000000001',
    'view',
    '10000000-0000-4000-8000-000000000002'
  ),
  false,
  'a caller cannot spoof another actor through the helper parameter'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000002',
  true
);

select is(
  public.can_access_team_workspace(),
  false,
  'a legacy self-created team does not unlock the Team Workspace pilot'
);

select is(
  private.can(
    '20000000-0000-4000-8000-000000000002',
    'view',
    '10000000-0000-4000-8000-000000000002'
  ),
  false,
  'the authorization helper denies every action in an undesignated workspace'
);

select is(
  (select count(*) from public.list_my_teams()),
  0::bigint,
  'list_my_teams does not reveal a legacy self-created workspace'
);

select is(
  private.can(
    '20000000-0000-4000-8000-000000000001',
    'view',
    '10000000-0000-4000-8000-000000000002'
  ),
  false,
  'foreign-team caller is denied'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000003',
  true
);

select is(
  private.can(
    '20000000-0000-4000-8000-000000000001',
    'view',
    '10000000-0000-4000-8000-000000000003'
  ),
  false,
  'blocked caller is denied despite active membership and JWT identity'
);

create temporary table team_permissions (permission text primary key);
insert into pg_temp.team_permissions values ('shadow_grant');
set local search_path = pg_temp, public, extensions;

select is(
  private.can(
    '20000000-0000-4000-8000-000000000001',
    'shadow_grant',
    '10000000-0000-4000-8000-000000000003'
  ),
  false,
  'caller search-path shadow objects cannot change fully-qualified behavior'
);

select has_function('public', 'create_team', array['text'], 'US1 create_team RPC exists');
select has_function('public', 'list_my_teams', array[]::text[], 'US1 team list RPC exists');
select has_function(
  'public',
  'can_access_team_workspace',
  array[]::text[],
  'Team Workspace access gate RPC exists'
);
select has_function(
  'public',
  'lookup_invitable_account',
  array['uuid', 'text'],
  'US1 minimal account lookup RPC exists'
);
select has_function(
  'public',
  'create_invitation',
  array['uuid', 'text', 'text', 'bytea'],
  'US1 invitation create RPC exists'
);
select has_function(
  'public',
  'list_my_invitations',
  array[]::text[],
  'US1 caller invitation list RPC exists'
);
select has_function(
  'public',
  'accept_invitation',
  array['uuid', 'text'],
  'US1 invitation acceptance RPC exists'
);
select has_function(
  'public',
  'list_team_invitations',
  array['uuid'],
  'US1 manager invitation list RPC exists'
);
select has_function(
  'public',
  'decline_invitation',
  array['uuid', 'text'],
  'US1 invitation decline RPC exists'
);
select has_function(
  'public',
  'revoke_invitation',
  array['uuid'],
  'US1 invitation revocation RPC exists'
);
select has_function(
  'public',
  'resend_invitation',
  array['uuid', 'bytea'],
  'US1 invitation resend RPC exists'
);
select has_function(
  'public',
  'set_invitation_delivery_state',
  array['uuid', 'text', 'text'],
  'US1 service-only delivery state RPC exists'
);
select has_function(
  'public',
  'get_drive_connection_status',
  array['uuid'],
  'US1 connection status RPC exists'
);
select has_function(
  'public',
  'request_team_catalog_resync',
  array['uuid'],
  'owner-requested catalog resync RPC exists'
);
select has_function(
  'public',
  'service_confirm_drive_connection',
  array['uuid', 'uuid', 'uuid', 'text', 'text', 'text', 'text', 'jsonb'],
  'US1 service-only connection confirmation RPC exists'
);
select has_function(
  'public',
  'service_direct_add_registered_member',
  array['uuid', 'uuid', 'text', 'text'],
  'US1 test-mode direct member add RPC exists'
);

select is_empty(
  $$
    select expected.signature
    from (values
      ('public.create_team(text)'),
      ('public.list_my_teams()'),
      ('public.can_access_team_workspace()'),
      ('public.lookup_invitable_account(uuid,text)'),
      ('public.create_invitation(uuid,text,text,bytea)'),
      ('public.list_my_invitations()'),
      ('public.list_team_invitations(uuid)'),
      ('public.accept_invitation(uuid,text)'),
      ('public.decline_invitation(uuid,text)'),
      ('public.revoke_invitation(uuid)'),
      ('public.resend_invitation(uuid,bytea)'),
      ('public.get_drive_connection_status(uuid)'),
      ('public.request_team_catalog_resync(uuid)'),
      ('public.list_team_materials(uuid,text)')
    ) as expected(signature)
    where not has_function_privilege('authenticated', expected.signature, 'execute')
  $$,
  'authenticated has every intended US1 caller RPC grant'
);

select is_empty(
  $$
    select p.oid::regprocedure::text
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (
        p.proname like 'service_%'
        or p.proname in ('set_invitation_delivery_state', 'expire_team_invitations')
      )
      and has_function_privilege('authenticated', p.oid, 'execute')
  $$,
  'authenticated cannot execute any US1 service RPC'
);

select is_empty(
  $$
    select expected.signature
    from (values
      ('public.set_invitation_delivery_state(uuid,text,text)'),
      ('public.expire_team_invitations()'),
      ('public.service_direct_add_registered_member(uuid,uuid,text,text)'),
      ('public.service_create_drive_oauth_transaction(uuid,uuid,bytea,text,text,timestamp with time zone)'),
      ('public.service_peek_drive_oauth_transaction(bytea)'),
      ('public.service_consume_drive_oauth_transaction(bytea)'),
      ('public.service_store_google_drive_credential(uuid,text,text,text,text,uuid)'),
      ('public.service_bind_drive_credential(uuid,uuid,uuid)'),
      ('public.service_get_drive_credential_reference(uuid,uuid)'),
      ('public.service_delete_google_drive_credential(uuid)'),
      ('public.service_get_drive_connection_credential(uuid,uuid)'),
      ('public.service_confirm_drive_connection(uuid,uuid,uuid,text,text,text,text,jsonb)'),
      ('public.service_replace_drive_connection(uuid,uuid,uuid,text,text,text,text,jsonb)'),
      ('public.service_detach_drive_connection(uuid,uuid,uuid)'),
      ('public.service_mark_drive_needs_reauth(uuid)'),
      ('public.service_claim_catalog_sync_jobs(text,integer,integer)'),
      ('public.service_upsert_catalog_page(uuid,text,jsonb)'),
      ('public.service_checkpoint_initial_sync(uuid,text,jsonb,text)'),
      ('public.service_begin_change_replay(uuid,uuid)')
    ) as expected(signature)
    where not has_function_privilege('service_role', expected.signature, 'execute')
  $$,
  'service_role has every intended US1 service RPC grant'
);

insert into auth.users (
  id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '10000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated',
    'wrong-identity@example.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '10000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated',
    'decline-target@example.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '10000000-0000-4000-8000-000000000006', 'authenticated', 'authenticated',
    'expired-target@example.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '10000000-0000-4000-8000-000000000010', 'authenticated', 'authenticated',
    'direct-member@example.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '10000000-0000-4000-8000-000000000011', 'authenticated', 'authenticated',
    'direct-unconfirmed@example.test', null, '{}'::jsonb, '{}'::jsonb, now(), now()
  );

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);

create temporary table us1_created_team as
select * from public.create_team('  US1 Media Buyers  ');

select is(
  (select count(*) from pg_temp.us1_created_team),
  1::bigint,
  'create_team returns one closed team context'
);

select is(
  (
    select count(*)
    from public.teams as team
    where team.id = (select id from pg_temp.us1_created_team)
      and team.owner_id = '10000000-0000-4000-8000-000000000001'
  ),
  1::bigint,
  'team creation stores exactly one canonical owner'
);

select is(
  (
    select count(*)
    from public.team_members as member
    where member.team_id = (select id from pg_temp.us1_created_team)
      and member.user_id = '10000000-0000-4000-8000-000000000001'
      and member.status = 'active'
  ),
  1::bigint,
  'team creation atomically stores the active owner membership'
);

select throws_ok(
  $$select * from public.create_team('us1 media buyers')$$,
  '23505',
  'NAME_CONFLICT',
  'case-insensitive duplicate team names are rejected for the caller'
);

select is(
  (
    select count(*)
    from public.list_my_teams() as team
    where team.id = (select id from pg_temp.us1_created_team)
      and team.role = 'owner'
  ),
  1::bigint,
  'list_my_teams returns only caller memberships with computed role'
);

create temporary table us1_direct_invitation as
select *
from public.create_invitation(
  (select id from pg_temp.us1_created_team),
  'direct-member@example.test',
  'viewer',
  extensions.digest(convert_to('direct-member-invitation-token', 'UTF8'), 'sha256')
);

create temporary table us1_direct_member as
select *
from public.service_direct_add_registered_member(
  '10000000-0000-4000-8000-000000000001',
  (select id from pg_temp.us1_created_team),
  ' DIRECT-MEMBER@EXAMPLE.TEST ',
  'editor'
);

select is(
  (select base_role from pg_temp.us1_direct_member),
  'editor',
  'test-mode direct add returns the closed member projection with the requested role'
);

select is(
  (
    select count(*)
    from public.team_members as member
    where member.team_id = (select id from pg_temp.us1_created_team)
      and member.user_id = '10000000-0000-4000-8000-000000000010'
      and member.status = 'active'
  ),
  1::bigint,
  'test-mode direct add creates exactly one active membership'
);

select is(
  (
    select state
    from public.team_invitations as invitation
    where invitation.id = (select id from pg_temp.us1_direct_invitation)
  ),
  'revoked',
  'test-mode direct add closes an obsolete pending invitation for the same identity'
);

select is(
  (
    select count(*)
    from public.team_audit_events as event
    where event.team_id = (select id from pg_temp.us1_created_team)
      and event.actor_id = '10000000-0000-4000-8000-000000000001'
      and event.action = 'membership.direct_added'
      and event.target ->> 'member_id' = '10000000-0000-4000-8000-000000000010'
  ),
  1::bigint,
  'test-mode direct add records one content-free membership audit event'
);

select throws_ok(
  $$
    select * from public.service_direct_add_registered_member(
      '10000000-0000-4000-8000-000000000001',
      (select id from pg_temp.us1_created_team),
      'direct-member@example.test',
      'viewer'
    )
  $$,
  '23505',
  'ALREADY_MEMBER',
  'test-mode direct add rejects an already-active member without a duplicate'
);

select throws_ok(
  $$
    select * from public.service_direct_add_registered_member(
      '10000000-0000-4000-8000-000000000001',
      (select id from pg_temp.us1_created_team),
      'missing@example.test',
      'viewer'
    )
  $$,
  'P0002',
  'NOT_FOUND',
  'test-mode direct add reports no account for an unknown email'
);

select throws_ok(
  $$
    select * from public.service_direct_add_registered_member(
      '10000000-0000-4000-8000-000000000001',
      (select id from pg_temp.us1_created_team),
      'direct-unconfirmed@example.test',
      'viewer'
    )
  $$,
  'P0002',
  'NOT_FOUND',
  'test-mode direct add treats an unconfirmed account as unavailable'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000002',
  true
);
select throws_ok(
  $$
    select * from public.service_direct_add_registered_member(
      '10000000-0000-4000-8000-000000000002',
      (select id from pg_temp.us1_created_team),
      'direct-unconfirmed@example.test',
      'viewer'
    )
  $$,
  '42501',
  'PERMISSION_DENIED',
  'test-mode direct add rechecks the supplied actor manage-members authority'
);
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);

insert into auth.users (
  id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select md5('direct-capacity-' || fixture.number::text)::uuid,
       'authenticated',
       'authenticated',
       'direct-capacity-' || fixture.number::text || '@example.test',
       now(),
       '{}'::jsonb,
       '{}'::jsonb,
       now(),
       now()
from generate_series(1, 50) as fixture(number);

create temporary table us1_direct_capacity_team as
select * from public.create_team('Direct capacity team');

insert into public.team_members (team_id, user_id, base_role)
select (select id from pg_temp.us1_direct_capacity_team),
       md5('direct-capacity-' || fixture.number::text)::uuid,
       'viewer'
from generate_series(1, 49) as fixture(number);

select throws_ok(
  $$
    select * from public.service_direct_add_registered_member(
      '10000000-0000-4000-8000-000000000001',
      (select id from pg_temp.us1_direct_capacity_team),
      'direct-capacity-50@example.test',
      'viewer'
    )
  $$,
  '22023',
  'TEAM_MEMBER_LIMIT',
  'test-mode direct add cannot create active member 51'
);

create temporary table us1_first_invitation as
select *
from public.create_invitation(
  (select id from pg_temp.us1_created_team),
  ' FOUNDATION-FOREIGN@EXAMPLE.TEST ',
  'viewer',
  extensions.digest(convert_to('first-invitation-token', 'UTF8'), 'sha256')
);

select is(
  (select target_email from pg_temp.us1_first_invitation),
  'foundation-foreign@example.test',
  'invitation creation canonicalizes confirmed account identity'
);

select is(
  (
    select count(*)
    from public.list_team_invitations((select id from pg_temp.us1_created_team)) as invitation
    where invitation.id = (select id from pg_temp.us1_first_invitation)
      and invitation.delivery_state = 'pending'
  ),
  1::bigint,
  'manager invitation reads return safe delivery state without token material'
);

select is(
  (
    select octet_length(invitation.accept_token_hash)
    from public.team_invitations as invitation
    where invitation.id = (select id from pg_temp.us1_first_invitation)
  ),
  32,
  'invitation persistence contains only a fixed SHA-256 token hash'
);

select throws_ok(
  $$
    select * from public.create_invitation(
      (select id from pg_temp.us1_created_team),
      'foundation-foreign@example.test',
      'editor',
      extensions.digest(convert_to('duplicate-invitation-token', 'UTF8'), 'sha256')
    )
  $$,
  '23505',
  'ALREADY_INVITED',
  'account and email invitation forms dedupe to one pending identity'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000004',
  true
);

select throws_ok(
  $$
    select * from public.accept_invitation(
      (select id from pg_temp.us1_first_invitation),
      'first-invitation-token'
    )
  $$,
  '42501',
  'PERMISSION_DENIED',
  'a valid token cannot substitute for matching confirmed identity'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000002',
  true
);

select throws_ok(
  $$
    select * from public.accept_invitation(
      (select id from pg_temp.us1_first_invitation),
      'wrong-invitation-token'
    )
  $$,
  '42501',
  'PERMISSION_DENIED',
  'an emailed invitation rejects the wrong plaintext token'
);

select lives_ok(
  $$
    select * from public.accept_invitation(
      (select id from pg_temp.us1_first_invitation),
      null
    )
  $$,
  'an authenticated matching account can accept an in-app invitation by id'
);

select is(
  (
    select count(*)
    from public.team_members as member
    join public.team_invitations as invitation
      on invitation.team_id = member.team_id
     and invitation.target_user_id = member.user_id
    where invitation.id = (select id from pg_temp.us1_first_invitation)
      and invitation.state = 'accepted'
      and member.status = 'active'
  ),
  1::bigint,
  'acceptance commits membership and invitation state together'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);

create temporary table us1_decline_invitation as
select *
from public.create_invitation(
  (select id from pg_temp.us1_created_team),
  'decline-target@example.test',
  'editor',
  extensions.digest(convert_to('decline-invitation-token', 'UTF8'), 'sha256')
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000005',
  true
);

select lives_ok(
  $$
    select public.decline_invitation(
      (select id from pg_temp.us1_decline_invitation),
      'decline-invitation-token'
    )
  $$,
  'the matching identity can decline a pending invitation'
);

select is(
  (
    select invitation.state
    from public.team_invitations as invitation
    where invitation.id = (select id from pg_temp.us1_decline_invitation)
  ),
  'declined',
  'decline persists the terminal invitation state'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);

create temporary table us1_expired_invitation as
select *
from public.create_invitation(
  (select id from pg_temp.us1_created_team),
  'expired-target@example.test',
  'viewer',
  extensions.digest(convert_to('expired-invitation-token', 'UTF8'), 'sha256')
);

update public.team_invitations
set created_at = clock_timestamp() - interval '15 days',
    expires_at = clock_timestamp() - interval '1 day'
where id = (select id from pg_temp.us1_expired_invitation);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000006',
  true
);

select throws_ok(
  $$
    select * from public.accept_invitation(
      (select id from pg_temp.us1_expired_invitation),
      'expired-invitation-token'
    )
  $$,
  '22023',
  'EXPIRED',
  'accept-time expiry is authoritative even before a sweep runs'
);

select is(
  (
    select invitation.state
    from public.list_my_invitations() as invitation
    where invitation.id = (select id from pg_temp.us1_expired_invitation)
  ),
  'expired',
  'caller invitation reads materialize and expose safe expiry state'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);

create temporary table us1_resend_invitation as
select *
from public.create_invitation(
  (select id from pg_temp.us1_created_team),
  'new-member@example.test',
  'viewer',
  extensions.digest(convert_to('old-resend-token', 'UTF8'), 'sha256')
);

create temporary table us1_old_invitation_hash as
select invitation.accept_token_hash
from public.team_invitations as invitation
where invitation.id = (select id from pg_temp.us1_resend_invitation);

select lives_ok(
  $$
    select * from public.resend_invitation(
      (select id from pg_temp.us1_resend_invitation),
      extensions.digest(convert_to('rotated-resend-token', 'UTF8'), 'sha256')
    )
  $$,
  'resend rotates the existing invitation token without creating another row'
);

select ok(
  (
    select count(*) = 1
      and bool_and(invitation.accept_token_hash <>
        (select accept_token_hash from pg_temp.us1_old_invitation_hash))
    from public.team_invitations as invitation
    where invitation.id = (select id from pg_temp.us1_resend_invitation)
      and invitation.delivery_state = 'pending'
  ),
  'resend keeps one pending row with a rotated token and reset delivery state'
);

select lives_ok(
  $$select public.revoke_invitation((select id from pg_temp.us1_resend_invitation))$$,
  'an authorized owner can revoke the pending invitation'
);

select is(
  (
    select invitation.state
    from public.team_invitations as invitation
    where invitation.id = (select id from pg_temp.us1_resend_invitation)
  ),
  'revoked',
  'revocation persists a terminal state and invalidates future acceptance'
);

create temporary table us1_capacity_team as
select * from public.create_team('US1 Capacity Team');

create temporary table us1_capacity_users as
select gen_random_uuid() as id, sequence
from generate_series(1, 49) as sequence;

insert into auth.users (
  id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select capacity.id,
       'authenticated',
       'authenticated',
       format('capacity-%s@example.test', capacity.sequence),
       now(),
       '{}'::jsonb,
       '{}'::jsonb,
       now(),
       now()
from pg_temp.us1_capacity_users as capacity;

insert into public.team_members (team_id, user_id, base_role)
select (select id from pg_temp.us1_capacity_team), capacity.id, 'viewer'
from pg_temp.us1_capacity_users as capacity;

select is(
  (
    select count(*)
    from public.team_members as member
    where member.team_id = (select id from pg_temp.us1_capacity_team)
      and member.status = 'active'
  ),
  50::bigint,
  'the documented team capacity includes the owner'
);

select throws_ok(
  $$
    select * from public.create_invitation(
      (select id from pg_temp.us1_capacity_team),
      'over-capacity@example.test',
      'viewer',
      extensions.digest(convert_to('over-capacity-token', 'UTF8'), 'sha256')
    )
  $$,
  '22023',
  'TEAM_MEMBER_LIMIT',
  'invitation creation rechecks the 50-member cap under the team lock'
);

select lives_ok(
  $$
    select public.service_create_drive_oauth_transaction(
      (select id from pg_temp.us1_created_team),
      '10000000-0000-4000-8000-000000000001',
      extensions.digest(convert_to('one-time-oauth-state', 'UTF8'), 'sha256'),
      repeat('p', 48),
      'http://127.0.0.1:5173',
      clock_timestamp() + interval '5 minutes'
    )
  $$,
  'an owner-bound, expiring state and PKCE transaction can be created'
);

select is(
  (
    select count(*)
    from public.service_peek_drive_oauth_transaction(
      extensions.digest(convert_to('one-time-oauth-state', 'UTF8'), 'sha256')
    )
  ),
  1::bigint,
  'callback can inspect safe transaction origin before the second mode gate'
);

select is(
  (
    select count(*)
    from public.service_consume_drive_oauth_transaction(
      extensions.digest(convert_to('one-time-oauth-state', 'UTF8'), 'sha256')
    )
  ),
  1::bigint,
  'OAuth state consumption returns its one-time PKCE verifier once'
);

select is(
  (
    select count(*)
    from public.service_consume_drive_oauth_transaction(
      extensions.digest(convert_to('one-time-oauth-state', 'UTF8'), 'sha256')
    )
  ),
  0::bigint,
  'OAuth state replay returns no transaction and causes no credential change'
);

create temporary table us1_credential as
select public.service_store_google_drive_credential(
  '10000000-0000-4000-8000-000000000001',
  'google-permission-id-us1',
  'drive-owner@example.test',
  'https://www.googleapis.com/auth/drive',
  'refresh-token-for-us1-tests',
  null
) as id;

create temporary table us1_connection as
select *
from public.service_confirm_drive_connection(
  (select id from pg_temp.us1_created_team),
  '10000000-0000-4000-8000-000000000001',
  (select id from pg_temp.us1_credential),
  'root-folder-us1',
  'US1 Team Media',
  null,
  'my_drive',
  jsonb_build_object('canListChildren', true, 'startPageToken', 'change-token-0')
);

select is(
  (select count(*) from pg_temp.us1_connection where state = 'connected'),
  1::bigint,
  'service confirmation persists a closed connected-root result'
);

select is(
  (
    select count(*)
    from private.catalog_sync_jobs as job
    where job.id = (select sync_job_id from pg_temp.us1_connection)
      and job.phase = 'initial_scan'
  ),
  1::bigint,
  'root confirmation atomically enqueues the initial breadth-first scan'
);

select is(
  (
    select count(*)
    from public.team_drive_connections as connection
    where connection.team_id = (select id from pg_temp.us1_created_team)
      and connection.state <> 'detached'
  ),
  1::bigint,
  'a team has exactly one non-detached root connection'
);

select throws_ok(
  $$
    select * from public.service_confirm_drive_connection(
      (select id from pg_temp.us1_created_team),
      '10000000-0000-4000-8000-000000000001',
      (select id from pg_temp.us1_credential),
      'second-root-us1',
      'Second Root',
      null,
      'my_drive',
      jsonb_build_object('canListChildren', true)
    )
  $$,
  '23505',
  'WRONG_STATE',
  'a second active root is rejected before a second sync job is created'
);

select is(
  (
    select status.connected_account_email
    from public.get_drive_connection_status((select id from pg_temp.us1_created_team)) as status
  ),
  'drive-owner@example.test',
  'owner connection status includes the safe connected-account display value'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000002',
  true
);

select ok(
  (
    select status.connected_account_email is null
    from public.get_drive_connection_status((select id from pg_temp.us1_created_team)) as status
  ),
  'viewer connection status omits owner/admin-only connected account identity'
);

select throws_ok(
  $$
    select *
    from public.get_drive_connection_status((select id from pg_temp.us1_capacity_team))
  $$,
  '42501',
  'PERMISSION_DENIED',
  'connection status rejects a caller outside the requested team'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);

insert into public.team_materials (
  team_id, connection_id, drive_file_id, parent_folder_id,
  name, mime_type, file_extension, kind, category
) values (
  (select id from pg_temp.us1_created_team),
  (select connection_id from pg_temp.us1_connection),
  'visible-file-us1',
  'root-folder-us1',
  'launch.mp4',
  'video/mp4',
  'mp4',
  'file',
  'video'
);

select is(
  (
    select count(*)
    from public.list_team_materials(
      (select id from pg_temp.us1_created_team), null
    ) as material
    where material.name = 'launch.mp4'
  ),
  1::bigint,
  'a member sees the connected Drive root as the first visible catalog page'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000002',
  true
);

select throws_ok(
  $$
    select *
    from public.list_team_materials((select id from pg_temp.us1_capacity_team), null)
  $$,
  '42501',
  'PERMISSION_DENIED',
  'catalog rows and counts cannot be queried across team boundaries'
);

select has_function(
  'public',
  'list_team_members',
  array['uuid'],
  'US2 caller-checked member list RPC exists'
);
select has_function(
  'public',
  'update_membership',
  array['uuid', 'uuid', 'text', 'jsonb'],
  'US2 membership update RPC exists'
);
select has_function(
  'public',
  'remove_member',
  array['uuid', 'uuid'],
  'US2 member removal RPC exists'
);
select has_function(
  'public',
  'transfer_ownership',
  array['uuid', 'uuid', 'text'],
  'US2 ownership transfer RPC exists'
);
select has_function(
  'public',
  'list_team_audit_events',
  array['uuid', 'integer', 'timestamp with time zone'],
  'US2 owner/admin audit projection RPC exists'
);
select has_function(
  'public',
  'owned_team_count',
  array['uuid'],
  'US2 account deletion ownership preflight exists'
);
select has_function(
  'public',
  'service_revoke_user_team_grants',
  array['uuid'],
  'US2 deleted-user grant cleanup exists'
);

select is_empty(
  $$
    select expected.signature
    from (values
      ('public.list_team_members(uuid)'),
      ('public.update_membership(uuid,uuid,text,jsonb)'),
      ('public.remove_member(uuid,uuid)'),
      ('public.transfer_ownership(uuid,uuid,text)'),
      ('public.list_team_audit_events(uuid,integer,timestamp with time zone)')
    ) as expected(signature)
    where not has_function_privilege('authenticated', expected.signature, 'execute')
  $$,
  'authenticated has every intended US2 caller RPC grant'
);

select is_empty(
  $$
    select expected.signature
    from (values
      ('public.owned_team_count(uuid)'),
      ('public.service_revoke_user_team_grants(uuid)')
    ) as expected(signature)
    where not has_function_privilege('service_role', expected.signature, 'execute')
  $$,
  'service_role has every intended US2 account-lifecycle RPC grant'
);

select is_empty(
  $$
    select expected.signature
    from (values
      ('public.owned_team_count(uuid)'),
      ('public.service_revoke_user_team_grants(uuid)')
    ) as expected(signature)
    where has_function_privilege('authenticated', expected.signature, 'execute')
  $$,
  'authenticated cannot execute US2 account-lifecycle service RPCs'
);

select is_empty(
  $$
    select p.oid::regprocedure::text
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('update_membership', 'remove_member', 'transfer_ownership')
      and position('for update' in lower(pg_get_functiondef(p.oid))) = 0
  $$,
  'every competing US2 membership action serializes on locked authority rows'
);

insert into auth.users (
  id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '10000000-0000-4000-8000-000000000007', 'authenticated', 'authenticated',
    'us2-admin@example.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '10000000-0000-4000-8000-000000000008', 'authenticated', 'authenticated',
    'us2-editor@example.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '10000000-0000-4000-8000-000000000009', 'authenticated', 'authenticated',
    'us2-removal@example.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
  );

insert into public.team_members (team_id, user_id, base_role)
values
  (
    (select id from pg_temp.us1_created_team),
    '10000000-0000-4000-8000-000000000007',
    'admin'
  ),
  (
    (select id from pg_temp.us1_created_team),
    '10000000-0000-4000-8000-000000000008',
    'editor'
  ),
  (
    (select id from pg_temp.us1_created_team),
    '10000000-0000-4000-8000-000000000009',
    'viewer'
  );

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);

select is(
  (
    select count(*)
    from public.list_team_members((select id from pg_temp.us1_created_team)) as member
    where member.user_id in (
      '10000000-0000-4000-8000-000000000007',
      '10000000-0000-4000-8000-000000000008',
      '10000000-0000-4000-8000-000000000009'
    )
  ),
  3::bigint,
  'member list returns the requested active team projection only'
);

select lives_ok(
  $$
    select * from public.update_membership(
      (select id from pg_temp.us1_created_team),
      '10000000-0000-4000-8000-000000000008',
      'editor',
      '{"edit":false,"manage_metadata":true}'::jsonb
    )
  $$,
  'an authorized manager can persist sparse independent overrides'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000008',
  true
);

select is(
  private.can(
    (select id from pg_temp.us1_created_team),
    'edit',
    '10000000-0000-4000-8000-000000000008'
  ),
  false,
  'edit can be denied independently from metadata management'
);
select is(
  private.can(
    (select id from pg_temp.us1_created_team),
    'manage_metadata',
    '10000000-0000-4000-8000-000000000008'
  ),
  true,
  'metadata management remains allowed when edit is denied'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);

select lives_ok(
  $$
    select * from public.update_membership(
      (select id from pg_temp.us1_created_team),
      '10000000-0000-4000-8000-000000000008',
      'editor',
      '{"edit":true,"manage_metadata":false}'::jsonb
    )
  $$,
  'the independent override direction can be inverted'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000008',
  true
);
select is(
  private.can(
    (select id from pg_temp.us1_created_team),
    'edit',
    '10000000-0000-4000-8000-000000000008'
  ),
  true,
  'edit is allowed after the next-action permission read'
);
select is(
  private.can(
    (select id from pg_temp.us1_created_team),
    'manage_metadata',
    '10000000-0000-4000-8000-000000000008'
  ),
  false,
  'metadata management is denied independently on the next action'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);
select throws_ok(
  $$
    select * from public.update_membership(
      (select id from pg_temp.us1_created_team),
      '10000000-0000-4000-8000-000000000008',
      'editor',
      '{"unknown_permission":true}'::jsonb
    )
  $$,
  '22023',
  'INVALID_INPUT',
  'unknown permission overrides are rejected rather than silently stored'
);
select throws_ok(
  $$
    select * from public.update_membership(
      (select id from pg_temp.us1_created_team),
      '10000000-0000-4000-8000-000000000001',
      'viewer',
      '{}'::jsonb
    )
  $$,
  '42501',
  'PERMISSION_DENIED',
  'the canonical owner cannot be edited through ordinary membership mutation'
);

select lives_ok(
  $$
    select * from public.update_membership(
      (select id from pg_temp.us1_created_team),
      '10000000-0000-4000-8000-000000000008',
      'admin',
      '{}'::jsonb
    )
  $$,
  'role updates persist together with a safe override reset'
);

select ok(
  (
    select count(*) >= 3
    from public.team_audit_events as event
    where event.team_id = (select id from pg_temp.us1_created_team)
      and event.action = 'membership.updated'
      and event.result = 'succeeded'
  ),
  'membership role and override updates append durable audit events'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000002',
  true
);
select throws_ok(
  $$
    select * from public.list_team_audit_events(
      (select id from pg_temp.us1_created_team), 50, null
    )
  $$,
  '42501',
  'PERMISSION_DENIED',
  'a viewer cannot read the owner/admin audit projection'
);

insert into private.team_transfer_grants (
  token_hash, team_id, actor_id, purpose, max_range_bytes, expires_at
) values (
  extensions.digest(convert_to('us2-member-removal-grant', 'UTF8'), 'sha256'),
  (select id from pg_temp.us1_created_team),
  '10000000-0000-4000-8000-000000000009',
  'download_range',
  1048576,
  clock_timestamp() + interval '10 minutes'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);
select lives_ok(
  $$
    select * from public.remove_member(
      (select id from pg_temp.us1_created_team),
      '10000000-0000-4000-8000-000000000009'
    )
  $$,
  'member removal commits through the caller-checked RPC'
);
select is(
  (
    select status
    from public.team_members
    where team_id = (select id from pg_temp.us1_created_team)
      and user_id = '10000000-0000-4000-8000-000000000009'
  ),
  'removed',
  'member removal preserves history with a removed state'
);
select ok(
  (
    select revoked_at is not null
    from private.team_transfer_grants
    where token_hash = extensions.digest(
      convert_to('us2-member-removal-grant', 'UTF8'), 'sha256'
    )
  ),
  'member removal revokes outstanding scoped transfer grants'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000009',
  true
);
select is(
  private.can(
    (select id from pg_temp.us1_created_team),
    'view',
    '10000000-0000-4000-8000-000000000009'
  ),
  false,
  'removed membership denies the very next protected action'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);
select lives_ok(
  $$
    select * from public.transfer_ownership(
      (select id from pg_temp.us1_created_team),
      '10000000-0000-4000-8000-000000000007',
      'editor'
    )
  $$,
  'ownership transfer commits atomically with an explicit former-owner role'
);
select is(
  (
    select count(*)
    from public.teams as team
    join public.team_members as member
      on member.team_id = team.id
     and member.user_id = team.owner_id
     and member.status = 'active'
    where team.id = (select id from pg_temp.us1_created_team)
  ),
  1::bigint,
  'serialized transfer leaves exactly one active canonical owner membership'
);
select is(
  (
    select owner_id
    from public.teams
    where id = (select id from pg_temp.us1_created_team)
  ),
  '10000000-0000-4000-8000-000000000007'::uuid,
  'the selected active member becomes canonical owner'
);
select is(
  (
    select base_role
    from public.team_members
    where team_id = (select id from pg_temp.us1_created_team)
      and user_id = '10000000-0000-4000-8000-000000000001'
      and status = 'active'
  ),
  'editor',
  'the former owner receives the explicit demotion role'
);
select is(
  private.team_role(
    (select id from pg_temp.us1_created_team),
    '10000000-0000-4000-8000-000000000001'
  ),
  'editor',
  'the former owner effective role changes on the next authority read'
);
select throws_ok(
  $$
    select * from public.remove_member(
      (select id from pg_temp.us1_created_team),
      '10000000-0000-4000-8000-000000000007'
    )
  $$,
  '42501',
  'PERMISSION_DENIED',
  'a serialized competing removal loses former-owner authority after transfer commits'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000007',
  true
);
select is(
  (
    select count(*)
    from public.list_team_audit_events(
      (select id from pg_temp.us1_created_team), 100, null
    ) as event
    where event.action = 'ownership.transferred'
      and event.result = 'succeeded'
  ),
  1::bigint,
  'the new owner can read the safe ownership-transfer audit event'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000008',
  true
);
select ok(
  (
    select count(*) > 0
    from public.list_team_audit_events(
      (select id from pg_temp.us1_created_team), 100, null
    )
  ),
  'an administrator can read the same closed audit projection'
);

select is(
  public.owned_team_count('10000000-0000-4000-8000-000000000007'),
  1,
  'account deletion preflight counts teams owned by the target identity'
);
select is(
  public.owned_team_count('10000000-0000-4000-8000-000000000008'),
  0,
  'account deletion preflight permits a non-owner identity'
);

update public.profiles
set account_status = 'blocked'
where id = '10000000-0000-4000-8000-000000000007';

select is(
  public.owned_team_count('10000000-0000-4000-8000-000000000007'),
  1,
  'blocked owners remain subject to ownership transfer preflight'
);

insert into private.team_transfer_grants (
  token_hash, team_id, actor_id, purpose, max_range_bytes, expires_at
) values (
  extensions.digest(convert_to('us2-account-cleanup-grant', 'UTF8'), 'sha256'),
  (select id from pg_temp.us1_created_team),
  '10000000-0000-4000-8000-000000000008',
  'download_range',
  1048576,
  clock_timestamp() + interval '10 minutes'
);

select is(
  public.service_revoke_user_team_grants('10000000-0000-4000-8000-000000000008'),
  1,
  'account cleanup revokes every outstanding grant for the deleted non-owner'
);
select ok(
  (
    select revoked_at is not null
    from private.team_transfer_grants
    where token_hash = extensions.digest(
      convert_to('us2-account-cleanup-grant', 'UTF8'), 'sha256'
    )
  ),
  'deleted-user grant cleanup persists revocation without changing audit identity'
);

-- User Story 3: exact-team catalog search, metadata-only writes, and durable sync state.
select has_function(
  'public', 'search_materials', array['uuid', 'text', 'jsonb', 'integer', 'integer'],
  'US3 caller-checked catalog search RPC exists'
);
select has_function(
  'public', 'get_team_vocab_and_facets', array['uuid'],
  'US3 caller-checked catalog vocabulary RPC exists'
);
select has_function(
  'public', 'update_material_metadata', array['uuid', 'uuid', 'jsonb'],
  'US3 metadata-only mutation RPC exists'
);
select has_trigger(
  'public', 'team_materials', 'team_materials_refresh_search',
  'catalog rows maintain their normalized search vector through a definer trigger'
);
select has_index(
  'public', 'team_materials', 'team_materials_search_gin_idx',
  'catalog text search has a GIN index'
);
select has_index(
  'public', 'team_materials', 'team_materials_geo_facet_idx',
  'catalog team/lifecycle facets have a btree index'
);
select has_index(
  'public', 'team_materials', 'team_materials_missing_geo_idx',
  'catalog unfilled metadata flow has a partial index'
);

select is_empty(
  $$
    select expected.signature
    from (values
      ('public.search_materials(uuid,text,jsonb,integer,integer)'),
      ('public.get_team_vocab_and_facets(uuid)'),
      ('public.update_material_metadata(uuid,uuid,jsonb)')
    ) as expected(signature)
    where not has_function_privilege('authenticated', expected.signature, 'execute')
  $$,
  'authenticated has only the three intended US3 caller RPC grants'
);
select is_empty(
  $$
    select p.oid::regprocedure::text
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like 'service_%catalog%'
      and has_function_privilege('authenticated', p.oid, 'execute')
  $$,
  'authenticated cannot execute any catalog service helper'
);
select is_empty(
  $$
    select expected.signature
    from (values
      ('public.service_checkpoint_catalog_sync_job(uuid,text,text,text,text,jsonb,jsonb)'),
      ('public.service_complete_catalog_sync_job(uuid,text,text,text)'),
      ('public.service_retry_catalog_sync_job(uuid,text,text,timestamp with time zone,boolean)'),
      ('public.service_tombstone_catalog_files(uuid,jsonb)'),
      ('public.service_requeue_catalog_transcripts(uuid,jsonb)'),
      ('public.service_list_pending_catalog_transcripts(uuid,jsonb)'),
      ('public.service_commit_catalog_transcript(uuid,text,text,text,text,text,text,integer,text)'),
      ('public.service_enqueue_catalog_reconciliation(uuid)')
    ) as expected(signature)
    where not has_function_privilege('service_role', expected.signature, 'execute')
  $$,
  'service_role has every intended US3 catalog helper grant'
);
select is(
  (select count(*) from cron.job where jobname = 'wishly-catalog-sync'),
  1::bigint,
  'one global named catalog schedule replaces per-team cron fanout'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000004', true);
insert into public.teams (id, name, owner_id)
values (
  '20000000-0000-4000-8000-000000000099',
  'US3 hidden benchmark team',
  '10000000-0000-4000-8000-000000000004'
);
insert into public.team_members (team_id, user_id, base_role)
values (
  '20000000-0000-4000-8000-000000000099',
  '10000000-0000-4000-8000-000000000004',
  'admin'
);
create temporary table us3_hidden_credential as
select public.service_store_google_drive_credential(
  '10000000-0000-4000-8000-000000000004',
  'google-permission-id-us3-hidden',
  'hidden-owner@example.test',
  'https://www.googleapis.com/auth/drive',
  'refresh-token-for-us3-hidden-tests',
  null
) as id;
create temporary table us3_hidden_connection as
select * from public.service_confirm_drive_connection(
  '20000000-0000-4000-8000-000000000099',
  '10000000-0000-4000-8000-000000000004',
  (select id from pg_temp.us3_hidden_credential),
  'hidden-root-us3', 'Hidden root', null, 'my_drive',
  pg_catalog.jsonb_build_object('canListChildren', true, 'startPageToken', 'hidden-change-0')
);

update public.team_materials
set geo = 'UA', language = 'uk', offer = 'Summer Sale', tags = array['UGC'],
    drive_version = '7', checksum = 'launch-checksum-7'
where team_id = (select id from pg_temp.us1_created_team)
  and drive_file_id = 'visible-file-us1';

insert into public.team_materials (
  team_id, connection_id, drive_file_id, parent_folder_id, name,
  mime_type, file_extension, kind, category, geo, language, offer, tags,
  drive_version, checksum, modified_at
)
select (select id from pg_temp.us1_created_team),
       (select connection_id from pg_temp.us1_connection),
       'benchmark-visible-' || pg_catalog.lpad(series.value::text, 5, '0'),
       'root-folder-us1',
       case when series.value = 49999 then 'Benchmark needle creative'
         else 'Campaign creative ' || series.value::text end,
       case when series.value % 6 = 1 then 'image/webp'
         when series.value % 6 = 2 then 'application/zip'
         when series.value % 6 = 3 then 'text/plain'
         when series.value % 6 = 4 then 'text/html'
         else 'video/mp4' end,
       case when series.value % 6 = 1 then 'webp'
         when series.value % 6 = 2 then 'zip'
         when series.value % 6 = 3 then 'txt'
         when series.value % 6 = 4 then 'html'
         else 'mp4' end,
       'file',
       (array['video','image','archive','transcript','landing','other'])[(series.value % 6) + 1],
       case when series.value % 7 = 0 then null
         else (array['UA','US','DE','BR','PL'])[(series.value % 5) + 1] end,
       case when series.value % 11 = 0 then null
         else (array['uk','en','de','pt-BR','pl'])[(series.value % 5) + 1] end,
       case when series.value % 13 = 0 then null
         else (array['Summer Sale','Evergreen','Trial'])[(series.value % 3) + 1] end,
       array['batch-' || (series.value % 100)::text, case when series.value % 2 = 0 then 'UGC' else 'studio' end],
       'v-' || series.value::text,
       'checksum-' || series.value::text,
       '2026-08-01T12:00:00Z'::timestamptz + (series.value * interval '1 second')
from pg_catalog.generate_series(1, 49999) as series(value);

insert into public.team_materials (
  team_id, connection_id, drive_file_id, parent_folder_id, name,
  mime_type, file_extension, kind, category, offer, tags
)
select '20000000-0000-4000-8000-000000000099'::uuid,
       (select connection_id from pg_temp.us3_hidden_connection),
       'benchmark-hidden-' || pg_catalog.lpad(series.value::text, 4, '0'),
       'hidden-root-us3',
       'Secret competitor creative ' || series.value::text,
       'video/mp4', 'mp4', 'file', 'video', 'Secret Offer', array['SecretTag']
from pg_catalog.generate_series(1, 137) as series(value);

select is(
  (select count(*) from public.team_materials
   where team_id = (select id from pg_temp.us1_created_team) and lifecycle = 'active'),
  50000::bigint,
  'the deterministic application benchmark team contains exactly 50000 visible rows'
);
select is(
  (select count(*) from public.team_materials
   where team_id = '20000000-0000-4000-8000-000000000099' and lifecycle = 'active'),
  137::bigint,
  'the deterministic benchmark includes separate hidden-team rows'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000008', true);
create temporary table us3_safe_search as
select public.search_materials(
  (select id from pg_temp.us1_created_team), 'benchmark needle', '{}'::jsonb, 1, 50
) as payload;
select ok(
  (select (payload ->> 'total')::integer = 1
     and payload #>> '{items,0,name}' = 'Benchmark needle creative'
     and not ((payload #> '{items,0}') ? 'transcriptText')
     and not ((payload #> '{items,0}') ? 'driveFileId')
   from pg_temp.us3_safe_search),
  'search returns one closed safe result without transcript or provider identity'
);
select is(
  (
    public.search_materials(
      (select id from pg_temp.us1_created_team), 'launch',
      '{"geo":["UA"],"language":["uk"],"offer":["summer sale"],"category":["video"],"originalType":["mp4"]}'::jsonb,
      1, 50
    ) ->> 'total'
  )::integer,
  1,
  'all active catalog facets combine with AND semantics'
);
select is(
  (
    public.search_materials(
      (select id from pg_temp.us1_created_team), 'Secret competitor creative 1', '{}'::jsonb, 1, 50
    ) ->> 'total'
  )::integer,
  0,
  'an exact hidden-team filename contributes no visible search count'
);
select ok(
  pg_catalog.strpos(
    public.get_team_vocab_and_facets((select id from pg_temp.us1_created_team))::text,
    'Secret Offer'
  ) = 0,
  'hidden-team metadata contributes no facet or vocabulary hint'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000004', true);
select throws_ok(
  $$select public.search_materials((select id from pg_temp.us1_created_team), null, '{}'::jsonb, 1, 50)$$,
  '42501', 'PERMISSION_DENIED',
  'a non-member cannot search another team even with its exact id'
);

update public.team_members
set base_role = 'editor', permission_overrides = '{"edit":false,"manage_metadata":true}'::jsonb
where team_id = (select id from pg_temp.us1_created_team)
  and user_id = '10000000-0000-4000-8000-000000000008';
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000008', true);
select ok(
  not private.can((select id from pg_temp.us1_created_team), 'edit', auth.uid())
  and private.can((select id from pg_temp.us1_created_team), 'manage_metadata', auth.uid()),
  'metadata management remains independently authorized when file editing is denied'
);

create temporary table us3_identity_before as
select id, drive_file_id, name, mime_type, lifecycle, transcript_text
from public.team_materials
where team_id = (select id from pg_temp.us1_created_team)
  and drive_file_id = 'visible-file-us1';
create temporary table us3_metadata_result as
select public.update_material_metadata(
  (select id from pg_temp.us1_created_team),
  (select id from pg_temp.us3_identity_before),
  '{"geo":"us","language":"PT-br","offer":"  Evergreen   Offer ","tags":[" UGC ","ugc","Креатив"]}'::jsonb
) as payload;
select is(
  (select (payload ->> 'geo') || '|' || (payload ->> 'language') || '|' || (payload ->> 'offer')
          || '|' || (payload -> 'tags')::text from pg_temp.us3_metadata_result),
  'US|pt-BR|Evergreen Offer|["UGC", "Креатив"]',
  'metadata-only writes normalize controlled values and case-insensitively dedupe tags'
);
select throws_ok(
  $$
    select public.update_material_metadata(
      (select id from pg_temp.us1_created_team),
      (select id from pg_temp.us3_identity_before),
      '{"name":"forbidden.mp4"}'::jsonb
    )
  $$,
  '22023', 'INVALID_INPUT',
  'metadata RPC rejects Drive/system/content columns instead of silently applying them'
);
select is(
  (
    select row(current.drive_file_id, current.name, current.mime_type, current.lifecycle, current.transcript_text)::text
    from public.team_materials as current
    where current.id = (select id from pg_temp.us3_identity_before)
  ),
  (
    select row(before.drive_file_id, before.name, before.mime_type, before.lifecycle, before.transcript_text)::text
    from pg_temp.us3_identity_before as before
  ),
  'metadata mutation preserves every sampled provider, lifecycle, and content field'
);

create temporary table us3_transcript as
with inserted as (
  insert into public.team_materials (
    team_id, connection_id, drive_file_id, parent_folder_id, name,
    mime_type, file_extension, kind, category, drive_version, checksum,
    transcript_text, transcript_ingest_state, transcript_source_version,
    transcript_source_checksum, transcript_indexed_bytes
  ) values (
    (select id from pg_temp.us1_created_team),
    (select connection_id from pg_temp.us1_connection),
    'us3-transcript-file', 'root-folder-us1', 'captions.txt',
    'text/plain', 'txt', 'file', 'transcript', '7', 'checksum-7',
    'stale searchable text', 'full', '7', 'checksum-7', 21
  ) returning id
)
select id from inserted;

select lives_ok(
  $$
    select public.service_upsert_catalog_page(
      (select connection_id from pg_temp.us1_connection),
      'root-folder-us1',
      '[{"drive_file_id":"us3-transcript-file","parent_folder_id":"root-folder-us1","name":"captions.txt","mime_type":"text/plain","file_extension":"txt","kind":"file","category":"transcript","classification_version":1,"classification_source":"mime","size_bytes":42,"modified_at":"2026-08-01T13:00:00Z","drive_version":"8","checksum":"checksum-8"}]'::jsonb
    )
  $$,
  'a source identity change upserts through the canonical catalog service path'
);
select is(
  (
    select transcript_ingest_state || '|' || coalesce(transcript_text, '<null>')
    from public.team_materials where id = (select id from pg_temp.us3_transcript)
  ),
  'pending|<null>',
  'a changed transcript is cleared and requeued before stale text can remain searchable'
);
select is(
  public.service_commit_catalog_transcript(
    (select id from pg_temp.us3_transcript), '7', 'checksum-7', 'text/plain', 'txt',
    'full', 'late stale body', 15, null
  ),
  false,
  'a late transcript commit is discarded after its source identity changes'
);
select is(
  public.service_commit_catalog_transcript(
    (select id from pg_temp.us3_transcript), '8', 'checksum-8', 'text/plain', 'txt',
    'full', 'bounded searchable words', 24, null
  ),
  true,
  'the current version-bound transcript commit succeeds'
);

-- User Story 4: preview reads stay caller-bound while transfer/provider context
-- and landing promotion remain service-only and source-identity-bound.
select has_function(
  'public', 'get_material_preview', array['uuid', 'uuid'],
  'US4 caller-checked material preview RPC exists'
);
select has_function(
  'public', 'service_get_material_transfer_context', array['uuid', 'uuid', 'uuid'],
  'US4 service-only transfer context RPC exists'
);
select has_function(
  'public', 'service_commit_landing_preview_validation',
  array['uuid', 'uuid', 'uuid', 'text', 'text', 'text'],
  'US4 source-bound landing validation RPC exists'
);
select is_empty(
  $$
    select expected.signature
    from (values ('public.get_material_preview(uuid,uuid)')) as expected(signature)
    where not has_function_privilege('authenticated', expected.signature, 'execute')
  $$,
  'authenticated has the intended caller-checked preview read grant'
);
select is_empty(
  $$
    select expected.signature
    from (values
      ('public.service_get_material_transfer_context(uuid,uuid,uuid)'),
      ('public.service_commit_landing_preview_validation(uuid,uuid,uuid,text,text,text)')
    ) as expected(signature)
    where not has_function_privilege('service_role', expected.signature, 'execute')
  $$,
  'service_role has the intended transfer-context and landing-validation grants'
);
select is(
  (
    select preview.transcript_ingest_state || '|' || preview.transcript_text || '|'
           || preview.can_download::text || '|' || preview.can_edit::text
    from public.get_material_preview(
      (select id from pg_temp.us1_created_team),
      (select id from pg_temp.us3_transcript)
    ) as preview
  ),
  'full|bounded searchable words|true|false',
  'preview returns explicit transcript state and independently permission-gated actions'
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000004', true);
select throws_ok(
  $$
    select * from public.get_material_preview(
      (select id from pg_temp.us1_created_team),
      (select id from pg_temp.us3_transcript)
    )
  $$,
  '42501', 'PERMISSION_DENIED',
  'a non-member cannot read transcript preview text by exact identifiers'
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000008', true);
select is(
  (
    select context.drive_file_id || '|' || context.root_folder_id
    from public.service_get_material_transfer_context(
      (select id from pg_temp.us1_created_team),
      (select id from pg_temp.us3_transcript),
      '10000000-0000-4000-8000-000000000008'
    ) as context
  ),
  'us3-transcript-file|root-folder-us1',
  'service transfer context resolves only a currently visible material beneath the active root'
);

create temporary table us4_landing_archive as
with inserted as (
  insert into public.team_materials (
    team_id, connection_id, drive_file_id, parent_folder_id, name,
    mime_type, file_extension, kind, category, drive_version, checksum
  ) values (
    (select id from pg_temp.us1_created_team),
    (select connection_id from pg_temp.us1_connection),
    'us4-landing-archive', 'root-folder-us1', 'campaign.zip',
    'application/zip', 'zip', 'file', 'archive', '17', 'landing-checksum-17'
  ) returning id
)
select id from inserted;
select is(
  public.service_commit_landing_preview_validation(
    (select id from pg_temp.us1_created_team),
    (select id from pg_temp.us4_landing_archive),
    '10000000-0000-4000-8000-000000000008',
    '17', 'landing-checksum-17', repeat('a', 64)
  ),
  true,
  'an exact source-version/checksum validation promotes an archive to landing'
);
select is(
  (
    select category || '|' || classification_source || '|' || landing_validation_state || '|'
           || landing_validation_version || '|' || landing_validation_fingerprint
    from public.team_materials where id = (select id from pg_temp.us4_landing_archive)
  ),
  'landing|inspected_landing|validated|17|' || repeat('a', 64),
  'landing promotion persists the exact validation identity and fingerprint'
);
select is(
  public.service_commit_landing_preview_validation(
    (select id from pg_temp.us1_created_team),
    (select id from pg_temp.us4_landing_archive),
    '10000000-0000-4000-8000-000000000008',
    'stale-version', 'landing-checksum-17', repeat('b', 64)
  ),
  false,
  'a stale landing validation cannot mutate the material'
);
select lives_ok(
  $$
    select public.service_upsert_catalog_page(
      (select connection_id from pg_temp.us1_connection),
      'root-folder-us1',
      '[{"drive_file_id":"us4-landing-archive","parent_folder_id":"root-folder-us1","name":"campaign.zip","mime_type":"application/zip","file_extension":"zip","kind":"file","category":"archive","classification_version":1,"classification_source":"mime","size_bytes":42,"modified_at":"2026-08-01T14:00:00Z","drive_version":"18","checksum":"landing-checksum-18"}]'::jsonb
    )
  $$,
  'a later Drive identity is reconciled through the canonical sync path'
);
select is(
  (
    select category || '|' || coalesce(landing_validation_state, '<null>') || '|'
           || coalesce(landing_validation_version, '<null>') || '|'
           || coalesce(landing_validation_fingerprint, '<null>')
    from public.team_materials where id = (select id from pg_temp.us4_landing_archive)
  ),
  'archive|<null>|<null>|<null>',
  'a changed Drive version clears promotion before any later revalidation'
);
select is(
  (
    public.search_materials(
      (select id from pg_temp.us1_created_team), 'bounded searchable words', '{}'::jsonb, 1, 50
    ) ->> 'total'
  )::integer,
  1,
  'authorized full-text search includes bounded transcript text without returning its body'
);
select lives_ok(
  $$
    insert into public.team_material_links (
      team_id, source_material_id, derivative_material_id, relation,
      source_name_snapshot, created_by
    ) values (
      (select id from pg_temp.us1_created_team),
      (select id from pg_temp.us3_identity_before),
      (select id from pg_temp.us3_transcript),
      'processed_from', 'launch.mp4', '10000000-0000-4000-8000-000000000008'
    )
  $$,
  'catalog provenance is recorded independently from searchable lifecycle state'
);
select is(
  public.service_tombstone_catalog_files(
    (select connection_id from pg_temp.us1_connection),
    '[{"file_id":"us3-transcript-file","lifecycle":"missing"}]'::jsonb
  ),
  1,
  'root loss tombstones the known catalog row without deleting it'
);
select is(
  (
    select lifecycle || '|' || transcript_ingest_state || '|' || coalesce(transcript_text, '<null>')
    from public.team_materials where id = (select id from pg_temp.us3_transcript)
  ),
  'missing|unavailable|<null>',
  'tombstoning immediately removes transcript text from active search'
);
select is(
  (
    select count(*) from public.team_material_links
    where derivative_material_id = (select id from pg_temp.us3_transcript)
  ),
  1::bigint,
  'tombstones preserve durable provenance links'
);
select lives_ok(
  $$
    explain (analyze, buffers)
    select public.search_materials(
      (select id from pg_temp.us1_created_team), 'benchmark needle', '{}'::jsonb, 1, 50
    )
  $$,
  'EXPLAIN ANALYZE remains diagnostic evidence separate from the application benchmark'
);

-- User Story 5: operation authority, reservations, exact result commits, and
-- provenance are exposed only through caller-checked/service-only definers.
select has_table('private', 'team_operation_intents', 'operation intent details stay private');
select has_function(
  'public', 'get_operation', array['uuid', 'uuid'],
  'US5 caller-checked operation read RPC exists'
);
select has_function(
  'public', 'get_material_provenance', array['uuid', 'uuid'],
  'US5 caller-checked provenance RPC exists'
);
select has_function(
  'public', 'cancel_team_operation', array['uuid', 'uuid'],
  'US5 caller-bound operation cancellation RPC exists'
);
select has_function(
  'public', 'service_start_team_operation',
  array['uuid','uuid','text','text','text','uuid','uuid','text','timestamp with time zone','bigint'],
  'US5 idempotent operation start RPC exists'
);
select has_function(
  'public', 'service_transition_team_operation',
  array['uuid','text','text','integer','uuid','text','boolean'],
  'US5 operation transition RPC exists'
);
select has_function(
  'public', 'service_set_team_operation_intent',
  array['uuid','uuid','text','text','bigint','uuid','uuid','text','integer'],
  'US5 private operation-intent binding RPC exists'
);
select has_function(
  'public', 'service_get_team_operation', array['uuid', 'uuid'],
  'US5 service operation authority RPC exists'
);
select has_function(
  'public', 'service_bind_team_operation_source',
  array['uuid','uuid','text','text','text'],
  'US5 expected source identity binding RPC exists'
);
select has_function(
  'public', 'service_get_team_operation_source_binding', array['uuid','uuid'],
  'US5 service source identity read RPC exists'
);
select has_function(
  'public', 'service_get_material_operation_context',
  array['uuid','uuid','uuid','text','boolean'],
  'US5 exact material action context RPC exists'
);
select has_function(
  'public', 'service_resolve_team_folder', array['uuid','uuid','text','text'],
  'US5 permission-checked catalog folder resolver exists'
);
select has_function(
  'public', 'service_finalize_uploaded_material', array['uuid','uuid','jsonb'],
  'US5 verified upload/version/process finalizer exists'
);
select has_function(
  'public', 'service_commit_team_text_edit',
  array['uuid','uuid','text','text','text','text','text','bigint'],
  'US5 source-identity-bound TXT commit RPC exists'
);
select has_function(
  'public', 'service_commit_team_material_mutation', array['uuid','uuid','jsonb'],
  'US5 exact rename/move/trash/restore commit RPC exists'
);

select is_empty(
  $$
    select expected.signature
    from (values
      ('public.get_operation(uuid,uuid)'),
      ('public.get_material_provenance(uuid,uuid)'),
      ('public.cancel_team_operation(uuid,uuid)')
    ) as expected(signature)
    where not has_function_privilege('authenticated', expected.signature, 'execute')
  $$,
  'authenticated has exactly the intended US5 caller RPC entry points'
);
select is_empty(
  $$
    select p.oid::regprocedure::text
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like 'service_%team%operation%'
      and has_function_privilege('authenticated', p.oid, 'execute')
  $$,
  'authenticated cannot execute US5 operation service definers'
);
select is_empty(
  $$
    select expected.signature
    from (values
      ('public.service_start_team_operation(uuid,uuid,text,text,text,uuid,uuid,text,timestamp with time zone,bigint)'),
      ('public.service_set_team_operation_intent(uuid,uuid,text,text,bigint,uuid,uuid,text,integer)'),
      ('public.service_get_team_operation(uuid,uuid)'),
      ('public.service_bind_team_operation_source(uuid,uuid,text,text,text)'),
      ('public.service_get_team_operation_source_binding(uuid,uuid)'),
      ('public.service_get_material_operation_context(uuid,uuid,uuid,text,boolean)'),
      ('public.service_resolve_team_folder(uuid,uuid,text,text)'),
      ('public.service_find_team_name_conflicts(uuid,uuid,uuid,text)'),
      ('public.service_transition_team_operation(uuid,text,text,integer,uuid,text,boolean)'),
      ('public.service_release_team_name_reservation(uuid)'),
      ('public.service_finalize_uploaded_material(uuid,uuid,jsonb)'),
      ('public.service_commit_team_text_edit(uuid,uuid,text,text,text,text,text,bigint)'),
      ('public.service_commit_team_material_mutation(uuid,uuid,jsonb)')
    ) as expected(signature)
    where not has_function_privilege('service_role', expected.signature, 'execute')
  $$,
  'service_role has every exact US5 saga function grant'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
create temporary table us5_folder as
with inserted as (
  insert into public.team_materials (
    team_id, connection_id, drive_file_id, parent_folder_id, name,
    mime_type, kind, category, lifecycle
  ) values (
    (select id from pg_temp.us1_created_team),
    (select connection_id from pg_temp.us1_connection),
    'us5-folder-drive-id', 'root-folder-us1', 'US5 Folder',
    'application/vnd.google-apps.folder', 'folder', null, 'active'
  ) returning id
)
select id from inserted;
create temporary table us5_source as
with inserted as (
  insert into public.team_materials (
    team_id, connection_id, drive_file_id, parent_folder_id, name,
    mime_type, file_extension, kind, category, size_bytes, drive_version, checksum,
    geo, language, offer, tags, transcript_text, transcript_ingest_state,
    transcript_indexed_bytes, transcript_source_version, transcript_source_checksum,
    preview_state
  ) values (
    (select id from pg_temp.us1_created_team),
    (select connection_id from pg_temp.us1_connection),
    'us5-source-drive-id', 'us5-folder-drive-id', 'source.txt',
    'text/plain', 'txt', 'file', 'transcript', 5, '1', 'source-check-1',
    'US', 'en', 'Evergreen', array['UGC'], 'start', 'full', 5, '1', 'source-check-1',
    'ready'
  ) returning id
)
select id from inserted;

create temporary table us5_upload_operation as
select * from public.service_start_team_operation(
  (select id from pg_temp.us1_created_team),
  '10000000-0000-4000-8000-000000000001',
  'upload', 'us5-upload-idempotency', 'us5-upload-request', null,
  (select id from pg_temp.us5_folder), 'upload.bin',
  pg_catalog.clock_timestamp() + interval '10 minutes', 4
);
select is(
  (select reused from pg_temp.us5_upload_operation), false,
  'a fresh upload creates one pending operation and reservation'
);
select is(
  (
    select reused from public.service_start_team_operation(
      (select id from pg_temp.us1_created_team),
      '10000000-0000-4000-8000-000000000001',
      'upload', 'us5-upload-idempotency', 'us5-upload-request', null,
      (select id from pg_temp.us5_folder), 'upload.bin',
      pg_catalog.clock_timestamp() + interval '10 minutes', 4
    )
  ),
  true,
  'the same operation key and binding reuses its operation'
);
select is(
  (
    select count(*) from public.team_operations
    where team_id = (select id from pg_temp.us1_created_team)
      and idempotency_key = 'us5-upload-idempotency'
  ),
  1::bigint,
  'idempotent start persists exactly one operation row'
);
select throws_ok(
  $$
    select * from public.service_start_team_operation(
      (select id from pg_temp.us1_created_team),
      '10000000-0000-4000-8000-000000000001',
      'upload', 'us5-upload-conflict', 'us5-conflict-request', null,
      (select id from pg_temp.us5_folder), 'upload.bin',
      pg_catalog.clock_timestamp() + interval '10 minutes', 4
    )
  $$,
  '23505', 'NAME_CONFLICT',
  'an active normalized-name reservation serializes conflicting mutations'
);
select lives_ok(
  $$
    select public.service_set_team_operation_intent(
      (select operation_id from pg_temp.us5_upload_operation),
      '10000000-0000-4000-8000-000000000001',
      'upload.bin', 'application/octet-stream', 4, null, null, null, null
    )
  $$,
  'upload intent binds expected name, MIME, and exact size once'
);
select lives_ok(
  $$
    select public.service_transition_team_operation(
      (select operation_id from pg_temp.us5_upload_operation),
      'running', 'uploading', 25, null, null, false
    )
  $$,
  'the operation follows pending to running with monotonic progress'
);
select throws_ok(
  $$
    select public.service_transition_team_operation(
      (select operation_id from pg_temp.us5_upload_operation),
      'pending', 'rewound', 25, null, null, false
    )
  $$,
  '23514', 'INVALID_OPERATION_TRANSITION',
  'a running operation cannot transition backward to pending'
);

select lives_ok(
  $$
    select public.issue_team_transfer_grant(
      extensions.digest(convert_to('us5-one-use-finalize-ticket', 'UTF8'), 'sha256'),
      (select operation_id from pg_temp.us5_upload_operation),
      (select id from pg_temp.us1_created_team),
      '10000000-0000-4000-8000-000000000001',
      'finalize', null, (select id from pg_temp.us5_folder), null,
      33554432, pg_catalog.clock_timestamp() + interval '10 minutes', 1
    )
  $$,
  'a finalize grant is scoped to one actor/team/destination/operation'
);
select is(
  (
    select count(*) from public.consume_team_transfer_grant(
      extensions.digest(convert_to('us5-one-use-finalize-ticket', 'UTF8'), 'sha256'),
      'finalize'
    )
  ),
  1::bigint,
  'the scoped one-use grant is consumed once'
);
select is(
  (
    select count(*) from public.consume_team_transfer_grant(
      extensions.digest(convert_to('us5-one-use-finalize-ticket', 'UTF8'), 'sha256'),
      'finalize'
    )
  ),
  0::bigint,
  'grant replay fails closed without returning scope'
);

create temporary table us5_upload_result as
select public.service_finalize_uploaded_material(
  (select operation_id from pg_temp.us5_upload_operation),
  '10000000-0000-4000-8000-000000000001',
  jsonb_build_object(
    'driveFileId', 'us5-upload-drive-id',
    'parentFolderId', 'us5-folder-drive-id',
    'name', 'upload.bin',
    'mimeType', 'application/octet-stream',
    'fileExtension', 'bin',
    'kind', 'file',
    'category', 'other',
    'classificationSource', 'extension',
    'sizeBytes', 4,
    'modifiedAt', '2026-08-01T15:00:00Z',
    'driveVersion', '1',
    'checksum', 'upload-check-1'
  )
) as payload;
select is(
  (select payload ->> 'state' from pg_temp.us5_upload_result),
  'succeeded',
  'only the exact verified Drive upload result becomes successful'
);
select ok(
  (
    select operation.state = 'succeeded'
       and operation.progress = 100
       and operation.result_material_id is not null
       and operation.reservation_released_at is not null
       and operation.finished_at is not null
    from public.team_operations as operation
    where operation.id = (select operation_id from pg_temp.us5_upload_operation)
  ),
  'success atomically sets the verified result and releases its reservation'
);
select is(
  (
    select count(*) from public.team_audit_events as audit
    where audit.team_id = (select id from pg_temp.us1_created_team)
      and audit.action = 'material.uploaded'
      and audit.target ? 'operation_id'
      and not (audit.target ?| array['name','path','drive_file_id','session_uri','token'])
  ),
  1::bigint,
  'upload audit is append-only and contains only opaque allowlisted identifiers'
);

create temporary table us5_version_operation as
select * from public.service_start_team_operation(
  (select id from pg_temp.us1_created_team),
  '10000000-0000-4000-8000-000000000001',
  'new_version', 'us5-version-idempotency', 'us5-version-request',
  (select id from pg_temp.us5_source), (select id from pg_temp.us5_folder),
  'source-v2.txt', pg_catalog.clock_timestamp() + interval '10 minutes', 5
);
select lives_ok(
  $$
    select public.service_set_team_operation_intent(
      (select operation_id from pg_temp.us5_version_operation),
      '10000000-0000-4000-8000-000000000001',
      'source-v2.txt', 'text/plain', 5, null,
      (select id from pg_temp.us5_source), null, null
    );
    select public.service_transition_team_operation(
      (select operation_id from pg_temp.us5_version_operation),
      'running', 'uploading', 50, null, null, false
    );
  $$,
  'a separate-version operation binds its one predecessor before upload'
);
select lives_ok(
  $$
    select public.service_bind_team_operation_source(
      (select operation_id from pg_temp.us5_version_operation),
      '10000000-0000-4000-8000-000000000001',
      'us5-source-drive-id', '1', 'source-check-1'
    )
  $$,
  'separate-version upload binds the exact live source identity'
);
select is(
  (
    select drive_file_id || '|' || drive_version || '|' || checksum
    from public.service_get_team_operation_source_binding(
      (select operation_id from pg_temp.us5_version_operation),
      '10000000-0000-4000-8000-000000000001'
    )
  ),
  'us5-source-drive-id|1|source-check-1',
  'the service reads back only the bound provider identity'
);
select throws_ok(
  $$
    select public.service_bind_team_operation_source(
      (select operation_id from pg_temp.us5_version_operation),
      '10000000-0000-4000-8000-000000000001',
      'us5-source-drive-id', '2', 'source-check-2'
    )
  $$,
  '23514', 'SOURCE_CHANGED',
  'a source identity binding cannot be changed after it is established'
);
create temporary table us5_version_result as
select public.service_finalize_uploaded_material(
  (select operation_id from pg_temp.us5_version_operation),
  '10000000-0000-4000-8000-000000000001',
  jsonb_build_object(
    'driveFileId', 'us5-version-drive-id',
    'parentFolderId', 'us5-folder-drive-id',
    'name', 'source-v2.txt',
    'mimeType', 'text/plain',
    'fileExtension', 'txt',
    'kind', 'file',
    'category', 'transcript',
    'classificationSource', 'mime',
    'sizeBytes', 5,
    'modifiedAt', '2026-08-01T15:10:00Z',
    'driveVersion', '1',
    'checksum', 'version-check-1'
  )
) as payload;
select is(
  (select payload ->> 'state' from pg_temp.us5_version_result),
  'succeeded',
  'a distinct verified version file finalizes successfully'
);
select ok(
  (
    select derivative.id <> source.id
       and derivative.geo = source.geo
       and derivative.language = source.language
       and derivative.offer = source.offer
       and derivative.tags = source.tags
       and link.relation = 'version_of'
    from public.team_materials as source
    join public.team_material_links as link on link.source_material_id = source.id
    join public.team_materials as derivative on derivative.id = link.derivative_material_id
    where source.id = (select id from pg_temp.us5_source)
      and derivative.id = ((select payload ->> 'materialId' from pg_temp.us5_version_result)::uuid)
  ),
  'separate version is distinct, inherits metadata, and has one version_of predecessor'
);
select ok(
  (
    select (retry ->> 'reused')::boolean
       and (
         select count(*) from public.team_material_links
         where team_id = (select id from pg_temp.us1_created_team)
           and relation = 'version_of'
           and source_material_id = (select id from pg_temp.us5_source)
       ) = 1
    from (
      select public.service_finalize_uploaded_material(
        (select operation_id from pg_temp.us5_version_operation),
        '10000000-0000-4000-8000-000000000001', '{}'::jsonb
      ) as retry
    ) as retried
  ),
  'version finalization retry returns the existing result without a duplicate link'
);
select throws_ok(
  $$
    insert into public.team_material_links (
      team_id, source_material_id, derivative_material_id, relation,
      source_name_snapshot, created_by
    ) values (
      (select id from pg_temp.us1_created_team),
      ((select payload ->> 'materialId' from pg_temp.us5_version_result)::uuid),
      (select id from pg_temp.us5_source),
      'version_of', 'source-v2.txt', '10000000-0000-4000-8000-000000000001'
    )
  $$,
  '23514', 'MATERIAL_LINK_CYCLE',
  'version lineage rejects cycles while permitting branches from one source'
);

create temporary table us5_text_operation as
select * from public.service_start_team_operation(
  (select id from pg_temp.us1_created_team),
  '10000000-0000-4000-8000-000000000001',
  'content_edit', 'us5-text-idempotency', 'us5-text-request',
  (select id from pg_temp.us5_source), null, null, null, 5
);
select lives_ok(
  $$
    select public.service_transition_team_operation(
      (select operation_id from pg_temp.us5_text_operation),
      'running', 'writing', 50, null, null, false
    )
  $$,
  'eligible TXT edit enters the running state without a name reservation'
);
select is(
  (
    public.service_commit_team_text_edit(
      (select operation_id from pg_temp.us5_text_operation),
      '10000000-0000-4000-8000-000000000001',
      '1', 'source-check-1', '2', 'source-check-2', 'hello', 5
    ) ->> 'state'
  ),
  'succeeded',
  'complete bounded TXT commits only after its expected source identity matches'
);
select is(
  (
    select geo || '|' || language || '|' || offer || '|' || tags::text
    from public.team_materials where id = (select id from pg_temp.us5_source)
  ),
  'US|en|Evergreen|{UGC}',
  'TXT content edit preserves independently managed metadata'
);
create temporary table us5_stale_text_operation as
select * from public.service_start_team_operation(
  (select id from pg_temp.us1_created_team),
  '10000000-0000-4000-8000-000000000001',
  'content_edit', 'us5-stale-idempotency', 'us5-stale-request',
  (select id from pg_temp.us5_source), null, null, null, 5
);
select throws_ok(
  $$
    select public.service_commit_team_text_edit(
      (select operation_id from pg_temp.us5_stale_text_operation),
      '10000000-0000-4000-8000-000000000001',
      '1', 'source-check-1', '3', 'source-check-3', 'stale', 5
    )
  $$,
  '23514', 'SOURCE_CHANGED',
  'stale TXT identity fails before any catalog commit'
);
create temporary table us5_srt as
with inserted as (
  insert into public.team_materials (
    team_id, connection_id, drive_file_id, parent_folder_id, name,
    mime_type, file_extension, kind, category, size_bytes, drive_version, checksum,
    transcript_text, transcript_ingest_state, transcript_indexed_bytes,
    transcript_source_version, transcript_source_checksum
  ) values (
    (select id from pg_temp.us1_created_team),
    (select connection_id from pg_temp.us1_connection),
    'us5-srt-drive-id', 'us5-folder-drive-id', 'captions.srt',
    'application/x-subrip', 'srt', 'file', 'transcript', 5, '1', 'srt-check-1',
    'cue', 'full', 3, '1', 'srt-check-1'
  ) returning id
)
select id from inserted;
create temporary table us5_srt_operation as
select * from public.service_start_team_operation(
  (select id from pg_temp.us1_created_team),
  '10000000-0000-4000-8000-000000000001',
  'content_edit', 'us5-srt-idempotency', 'us5-srt-request',
  (select id from pg_temp.us5_srt), null, null, null, 4
);
select throws_ok(
  $$
    select public.service_commit_team_text_edit(
      (select operation_id from pg_temp.us5_srt_operation),
      '10000000-0000-4000-8000-000000000001',
      '1', 'srt-check-1', '2', 'srt-check-2', 'edit', 4
    )
  $$,
  '22023', 'UNSUPPORTED_MEDIA',
  'SRT/VTT-style transcript files remain read-only even when fully ingested'
);

update public.team_members
set permission_overrides = permission_overrides || '{"delete":true}'::jsonb
where team_id = (select id from pg_temp.us1_created_team)
  and user_id = '10000000-0000-4000-8000-000000000001';
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
create temporary table us5_trash_operation as
select * from public.service_start_team_operation(
  (select id from pg_temp.us1_created_team),
  '10000000-0000-4000-8000-000000000001',
  'trash', 'us5-trash-idempotency', 'us5-trash-request',
  (select id from pg_temp.us5_source), null, null, null, 5
);
select lives_ok(
  $$
    select public.service_transition_team_operation(
      (select operation_id from pg_temp.us5_trash_operation),
      'running', 'trashing', 50, null, null, false
    )
  $$,
  'trash enters its guarded running state'
);
select is(
  (
    public.service_commit_team_material_mutation(
      (select operation_id from pg_temp.us5_trash_operation),
      '10000000-0000-4000-8000-000000000001',
      jsonb_build_object(
        'driveFileId', 'us5-source-drive-id', 'name', 'source.txt',
        'parentFolderId', 'us5-folder-drive-id', 'driveVersion', '3',
        'checksum', 'source-check-3', 'sizeBytes', 5, 'trashed', true
      )
    ) ->> 'state'
  ),
  'succeeded',
  'trash records a tombstone and never requires permanent provider deletion'
);
select ok(
  (
    select source.lifecycle = 'trashed'
       and source.trashed_at is not null
       and exists (
         select 1 from public.team_material_links as link
         where link.source_material_id = source.id and link.relation = 'version_of'
       )
    from public.team_materials as source
    where source.id = (select id from pg_temp.us5_source)
  ),
  'trash preserves durable version provenance on the tombstone'
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select is(
  (
    select operation.state from public.get_operation(
      (select id from pg_temp.us1_created_team),
      (select operation_id from pg_temp.us5_trash_operation)
    ) as operation
  ),
  'succeeded',
  'caller-checked operation reads expose only the safe authoritative snapshot'
);
select is(
  (
    select count(*) from public.get_material_provenance(
      (select id from pg_temp.us1_created_team),
      (select id from pg_temp.us5_source)
    )
    where relation = 'version_of'
  ),
  1::bigint,
  'caller provenance navigation remains available for a tombstoned source'
);

insert into private.team_transfer_grants (
  token_hash, team_id, actor_id, purpose, material_id,
  max_range_bytes, created_at, expires_at, max_uses
) values (
  extensions.digest(convert_to('us5-expired-download-ticket', 'UTF8'), 'sha256'),
  (select id from pg_temp.us1_created_team),
  '10000000-0000-4000-8000-000000000001',
  'download_range', ((select payload ->> 'materialId' from pg_temp.us5_version_result)::uuid),
  33554432, pg_catalog.clock_timestamp() - interval '2 minutes',
  pg_catalog.clock_timestamp() - interval '1 minute', 1
);
select is(
  (
    select count(*) from public.consume_team_transfer_grant(
      extensions.digest(convert_to('us5-expired-download-ticket', 'UTF8'), 'sha256'),
      'download_range'
    )
  ),
  0::bigint,
  'expired transfer capability cannot be consumed'
);
insert into private.team_transfer_grants (
  token_hash, team_id, actor_id, purpose, material_id,
  max_range_bytes, expires_at, revoked_at, max_uses
) values (
  extensions.digest(convert_to('us5-revoked-download-ticket', 'UTF8'), 'sha256'),
  (select id from pg_temp.us1_created_team),
  '10000000-0000-4000-8000-000000000001',
  'download_range', ((select payload ->> 'materialId' from pg_temp.us5_version_result)::uuid),
  33554432, pg_catalog.clock_timestamp() + interval '10 minutes',
  pg_catalog.clock_timestamp(), 1
);
select is(
  (
    select count(*) from public.consume_team_transfer_grant(
      extensions.digest(convert_to('us5-revoked-download-ticket', 'UTF8'), 'sha256'),
      'download_range'
    )
  ),
  0::bigint,
  'revoked transfer capability cannot be consumed'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000004', true);
select throws_ok(
  $$
    select * from public.get_operation(
      (select id from pg_temp.us1_created_team),
      (select operation_id from pg_temp.us5_upload_operation)
    )
  $$,
  '42501', 'PERMISSION_DENIED',
  'a non-member cannot read an operation by exact team and operation ids'
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000008', true);
select throws_ok(
  $$
    select * from public.service_start_team_operation(
      (select id from pg_temp.us1_created_team),
      '10000000-0000-4000-8000-000000000008',
      'rename', 'us5-denied-rename', 'us5-denied-request',
      (select id from pg_temp.us5_srt), null, null, null, null
    )
  $$,
  '42501', 'PERMISSION_DENIED',
  'manage_metadata cannot substitute for independently denied file edit permission'
);

-- Feature 004: a paired agent may fill the shared render cache, while every read remains
-- view-gated and stale source identity can never surface as ready.
select has_table('public', 'team_landing_renders', 'shared landing render pointer table exists');
select ok(
  (
    select catalog.relrowsecurity
       and catalog.relforcerowsecurity
       and not has_table_privilege('authenticated', catalog.oid, 'select')
       and not has_table_privilege('authenticated', catalog.oid, 'insert')
       and not has_table_privilege('authenticated', catalog.oid, 'update')
       and not has_table_privilege('authenticated', catalog.oid, 'delete')
    from pg_catalog.pg_class as catalog
    join pg_catalog.pg_namespace as namespace on namespace.oid = catalog.relnamespace
    where namespace.nspname = 'public' and catalog.relname = 'team_landing_renders'
  ),
  'render pointers force RLS and expose no direct authenticated table capability'
);
select is(
  (
    select count(*)
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'team_landing_renders'
  ),
  0::bigint,
  'raw render artifact folders are never published over Realtime'
);
select has_function(
  'public', 'list_landing_renders', array['uuid', 'uuid[]', 'text'],
  'caller-checked landing render listing exists'
);
select is_empty(
  $$
    select expected.signature
    from (values
      ('public.service_start_landing_render(uuid,uuid,uuid,text,text,text)'),
      ('public.service_commit_landing_render(uuid,text,integer,text)'),
      ('public.service_fail_landing_render(uuid,text)'),
      ('public.service_mark_landing_renders_stale(uuid,uuid)'),
      ('public.service_get_landing_render_artifact(uuid,uuid,text)'),
      ('public.service_get_landing_render_artifact_by_id(uuid,uuid,uuid)'),
      ('public.service_get_landing_render_upload(uuid,uuid,uuid)'),
      ('public.service_invalidate_landing_renders(uuid,text[])')
    ) as expected(signature)
    where not has_function_privilege('service_role', expected.signature, 'execute')
  $$,
  'service_role has every exact render lifecycle and byte-delivery grant'
);
select is_empty(
  $$
    select expected.signature
    from (values
      ('public.service_start_landing_render(uuid,uuid,uuid,text,text,text)'),
      ('public.service_commit_landing_render(uuid,text,integer,text)'),
      ('public.service_fail_landing_render(uuid,text)'),
      ('public.service_mark_landing_renders_stale(uuid,uuid)'),
      ('public.service_get_landing_render_artifact(uuid,uuid,text)'),
      ('public.service_get_landing_render_artifact_by_id(uuid,uuid,uuid)'),
      ('public.service_get_landing_render_upload(uuid,uuid,uuid)'),
      ('public.service_invalidate_landing_renders(uuid,text[])')
    ) as expected(signature)
    where has_function_privilege('authenticated', expected.signature, 'execute')
  $$,
  'authenticated cannot execute render lifecycle or raw artifact helpers'
);
select ok(
  has_function_privilege(
    'authenticated', 'public.list_landing_renders(uuid,uuid[],text)', 'execute'
  ),
  'authenticated can execute only the view-gated render listing'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
create temporary table us6_landing_render as
select public.service_start_landing_render(
  (select id from pg_temp.us1_created_team),
  (select id from pg_temp.us4_landing_archive),
  '10000000-0000-4000-8000-000000000001',
  'default', '18', 'landing-checksum-18'
) as id;
select is(
  (
    select render_state from public.team_landing_renders
    where id = (select id from pg_temp.us6_landing_render)
  ),
  'rendering',
  'an exact current source identity starts one shared render'
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000004', true);
select throws_ok(
  $$
    select * from public.list_landing_renders(
      (select id from pg_temp.us1_created_team),
      array[(select id from pg_temp.us4_landing_archive)], 'default'
    )
  $$,
  '42501', 'PERMISSION_DENIED',
  'a non-member cannot discover another team render pointer'
);
select is(
  public.service_commit_landing_render(
    (select id from pg_temp.us6_landing_render), 'opaque-artifact-folder', 2, repeat('c', 64)
  ),
  'ready',
  'a complete artifact with unchanged source identity commits ready'
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select is(
  (
    select count(*) from public.list_landing_renders(
      (select id from pg_temp.us1_created_team),
      array[(select id from pg_temp.us4_landing_archive)], 'default'
    ) where valid and render_state = 'ready' and segment_count = 2
  ),
  1::bigint,
  'a member sees the valid pointer without its raw artifact folder'
);
select throws_ok(
  $$
    select public.service_start_landing_render(
      (select id from pg_temp.us1_created_team),
      (select id from pg_temp.us4_landing_archive),
      '10000000-0000-4000-8000-000000000001',
      'default', 'stale-version', 'landing-checksum-18'
    )
  $$,
  '23514', 'SOURCE_CHANGED',
  'render start rejects a caller-supplied stale source identity'
);
select public.service_start_landing_render(
  (select id from pg_temp.us1_created_team),
  (select id from pg_temp.us4_landing_archive),
  '10000000-0000-4000-8000-000000000001',
  'default', '18', 'landing-checksum-18'
);
update public.team_materials
set drive_version = '19', checksum = 'landing-checksum-19'
where id = (select id from pg_temp.us4_landing_archive);
select is(
  public.service_commit_landing_render(
    (select id from pg_temp.us6_landing_render), 'stale-artifact-folder', 1, repeat('d', 64)
  ),
  'stale',
  'a source change during rendering commits stale rather than false-ready'
);
select is(
  (
    select render_state || '|' || segment_count::text || '|' || coalesce(artifact_root, '<null>')
    from public.team_landing_renders where id = (select id from pg_temp.us6_landing_render)
  ),
  'stale|0|<null>',
  'stale commit drops all fetchable artifact authority'
);
select public.service_start_landing_render(
  (select id from pg_temp.us1_created_team),
  (select id from pg_temp.us4_landing_archive),
  '10000000-0000-4000-8000-000000000001',
  'default', '19', 'landing-checksum-19'
);
create temporary table us6_failure_event_count as
select count(*) as value
from public.team_catalog_events
where team_id = (select id from pg_temp.us1_created_team)
  and material_id = (select id from pg_temp.us4_landing_archive)
  and event_kind = 'upserted';
select public.service_fail_landing_render(
  (select id from pg_temp.us6_landing_render), 'render_error'
);
select is(
  (
    select render.render_state || '|' || render.failure_reason || '|' ||
           (
             select (
               count(*) - (select value from pg_temp.us6_failure_event_count)
             )::text
             from public.team_catalog_events as event
             where event.team_id = render.team_id
               and event.material_id = render.material_id
               and event.event_kind = 'upserted'
           )
    from public.team_landing_renders as render
    where render.id = (select id from pg_temp.us6_landing_render)
  ),
  'failed|render_error|1',
  'render failure becomes terminal and emits one shared gallery refetch event'
);

select public.service_start_landing_render(
  (select id from pg_temp.us1_created_team),
  (select id from pg_temp.us4_landing_archive),
  '10000000-0000-4000-8000-000000000001',
  'default', '19', 'landing-checksum-19'
);
update public.team_landing_renders
set updated_at = pg_catalog.now() - interval '6 minutes'
where id = (select id from pg_temp.us6_landing_render);
select is(
  (
    select render_state || '|' || coalesce(failure_reason, '<null>')
    from public.list_landing_renders(
      (select id from pg_temp.us1_created_team),
      array[(select id from pg_temp.us4_landing_archive)],
      'default'
    )
  ),
  'failed|render_error',
  'an abandoned rendering row becomes a clear retryable error instead of a permanent spinner'
);

-- A replaced Drive root leaves historical catalog rows behind for audit and
-- reconciliation, but those rows must never reappear in a browse or preview
-- surface. They no longer have readable provider authority.
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
create temporary table us7_detached_connection as
with inserted as (
  insert into public.team_drive_connections (
    team_id, credential_id, root_folder_id, root_folder_name,
    drive_kind, state, initial_sync_state, detached_at
  )
  select (select id from pg_temp.us1_created_team),
         (select credential_id from public.team_drive_connections
          where id = (select connection_id from pg_temp.us1_connection)),
         'detached-root-us7', 'Detached historical root',
         'my_drive', 'detached', 'ready', clock_timestamp()
  returning id
)
select id from inserted;

create temporary table us7_detached_material as
with inserted as (
  insert into public.team_materials (
    team_id, connection_id, drive_file_id, parent_folder_id, name,
    mime_type, file_extension, kind, category, offer, tags,
    drive_version, checksum, library_stage
  )
  values (
    (select id from pg_temp.us1_created_team),
    (select id from pg_temp.us7_detached_connection),
    'detached-only-us7', 'root-folder-us1', 'Detached only landing.zip',
    'application/zip', 'zip', 'file', 'archive', 'Detached only offer', array['detached-only-tag'],
    'detached-version-us7', 'detached-checksum-us7', 'finds'
  )
  returning id
)
select id from inserted;

select is(
  (
    select count(*)
    from public.list_team_materials((select id from pg_temp.us1_created_team), null) as material
    where material.id = (select id from pg_temp.us7_detached_material)
  ),
  0::bigint,
  'the workspace tree excludes a detached-root material even when its parent id collides'
);
select is(
  (
    public.search_materials(
      (select id from pg_temp.us1_created_team), 'Detached only landing', '{}'::jsonb, 1, 50
    ) ->> 'total'
  )::integer,
  0,
  'catalog search excludes a detached-root landing candidate'
);
select ok(
  pg_catalog.strpos(
    public.get_team_vocab_and_facets((select id from pg_temp.us1_created_team))::text,
    'Detached only offer'
  ) = 0,
  'detached-root metadata does not leak into catalog vocabulary'
);
select is(
  (
    select count(*)
    from public.get_material_preview(
      (select id from pg_temp.us1_created_team),
      (select id from pg_temp.us7_detached_material)
    )
  ),
  0::bigint,
  'a detached-root file cannot mint a caller preview context'
);
select is(
  (
    select count(*)
    from public.list_library_materials(
      (select id from pg_temp.us1_created_team), 'finds', null, 50
    ) as material
    where material.id = (select id from pg_temp.us7_detached_material)
  ),
  0::bigint,
  'Creative Library excludes a detached-root file'
);
select is(
  (
    select count(*)
    from public.service_get_library_asset_placement(
      (select id from pg_temp.us1_created_team),
      '10000000-0000-4000-8000-000000000001',
      (select id from pg_temp.us7_detached_material)
    )
  ),
  0::bigint,
  'a detached-root file cannot enter a placement mutation'
);
insert into public.team_landing_renders (
  team_id, material_id, preset, source_version, source_checksum,
  render_state, failure_reason, segment_count, rendered_by
)
values (
  (select id from pg_temp.us1_created_team),
  (select id from pg_temp.us7_detached_material),
  'default', 'detached-version-us7', 'detached-checksum-us7',
  'failed', 'render_error', 0, '10000000-0000-4000-8000-000000000001'
);
select is(
  (
    select count(*)
    from public.list_landing_renders(
      (select id from pg_temp.us1_created_team),
      array[(select id from pg_temp.us7_detached_material)], 'default'
    )
  ),
  0::bigint,
  'the landing gallery cannot surface a render for a detached-root material'
);
select has_function(
  'public', 'get_team_landing_source_status', array['uuid'],
  'the landing gallery has a caller-checked detached-source recovery signal'
);
select is(
  (
    select has_detached_landing_candidates
    from public.get_team_landing_source_status((select id from pg_temp.us1_created_team))
  ),
  true,
  'a detached landing candidate yields a content-free recovery instruction signal'
);
select is(
  (
    select count(*)
    from public.get_material_preview(
      (select id from pg_temp.us1_created_team),
      (select id from pg_temp.us4_landing_archive)
    )
  ),
  1::bigint,
  'a material in the connected root remains previewable'
);

-- A historical copy from the same root is harmless after reconnecting that
-- root. It must not keep a recovery banner alive forever.
create temporary table us7_same_root_team as
select * from public.create_team('US7 Same Root Recovery');

create temporary table us7_same_root_connection as
select *
from public.service_confirm_drive_connection(
  (select id from pg_temp.us7_same_root_team),
  '10000000-0000-4000-8000-000000000001',
  (select id from pg_temp.us1_credential),
  'root-folder-us7-same',
  'US7 Same Root Media',
  null,
  'my_drive',
  jsonb_build_object('canListChildren', true, 'startPageToken', 'change-token-us7-initial')
);

create temporary table us7_same_root_live_material as
with inserted as (
  insert into public.team_materials (
    team_id, connection_id, drive_file_id, parent_folder_id, name,
    mime_type, file_extension, kind, category, drive_version, checksum
  )
  values (
    (select id from pg_temp.us7_same_root_team),
    (select connection_id from pg_temp.us7_same_root_connection),
    'same-root-live-us7', 'root-folder-us7-same', 'Live same root.zip',
    'application/zip', 'zip', 'file', 'archive', 'same-root-live-version-us7', 'same-root-live-checksum-us7'
  )
  returning id
)
select id from inserted;

create temporary table us7_same_root_detached_connection as
with inserted as (
  insert into public.team_drive_connections (
    team_id, credential_id, root_folder_id, root_folder_name,
    drive_kind, state, initial_sync_state, detached_at
  )
  select (select id from pg_temp.us7_same_root_team),
         (select credential_id from public.team_drive_connections
          where id = (select connection_id from pg_temp.us7_same_root_connection)),
         'root-folder-us7-same', 'US7 Same Root Media',
         'my_drive', 'detached', 'ready', clock_timestamp()
  returning id
)
select id from inserted;

create temporary table us7_same_root_detached_material as
with inserted as (
  insert into public.team_materials (
    team_id, connection_id, drive_file_id, parent_folder_id, name,
    mime_type, file_extension, kind, category, drive_version, checksum
  )
  values (
    (select id from pg_temp.us7_same_root_team),
    (select id from pg_temp.us7_same_root_detached_connection),
    'same-root-detached-us7', 'root-folder-us7-same', 'Historical same root.zip',
    'application/zip', 'zip', 'file', 'archive', 'same-root-version-us7', 'same-root-checksum-us7'
  )
  returning id
)
select id from inserted;

select is(
  (
    select has_detached_landing_candidates
    from public.get_team_landing_source_status((select id from pg_temp.us7_same_root_team))
  ),
  false,
  'a detached historical copy of the current root does not yield a recovery instruction'
);

create temporary table us7_same_root_resync as
select *
from public.service_replace_drive_connection(
  (select id from pg_temp.us7_same_root_team),
  '10000000-0000-4000-8000-000000000001',
  (select id from pg_temp.us1_credential),
  'root-folder-us7-same',
  'US7 Same Root Media',
  null,
  'my_drive',
  jsonb_build_object('canListChildren', true, 'startPageToken', 'change-token-resync')
);

select is(
  (select connection_id from pg_temp.us7_same_root_resync),
  (select connection_id from pg_temp.us7_same_root_connection),
  'reselecting the same Drive root keeps its catalog connection instead of detaching it'
);

select is(
  (
    select connection.state || '|' || connection.initial_sync_state || '|' ||
           connection.change_page_token
    from public.team_drive_connections as connection
    where connection.id = (select connection_id from pg_temp.us7_same_root_connection)
  ),
  'connected|scanning|change-token-resync',
  'same-root recovery refreshes the active connection and marks its recursive sync as scanning'
);

select is(
  (
    select count(*)
    from private.catalog_sync_jobs as job
    where job.id = (select sync_job_id from pg_temp.us7_same_root_resync)
      and job.connection_id = (select connection_id from pg_temp.us7_same_root_connection)
      and job.phase = 'initial_scan'
  ),
  1::bigint,
  'same-root recovery queues a new initial scan for the retained connection'
);

select is(
  (
    select count(*)
    from public.list_team_materials((select id from pg_temp.us7_same_root_team), null) as material
    where material.id = (select id from pg_temp.us7_same_root_live_material)
  ),
  1::bigint,
  'the retained connection keeps its existing landing visible while the recovery scan runs'
);

-- A catalog recovery must be runnable without replacing or detaching the
-- selected Drive root. Repeated clicks reuse the pending full scan.
update private.catalog_sync_jobs
set state = 'succeeded', completed_at = clock_timestamp()
where connection_id = (select connection_id from pg_temp.us7_same_root_connection)
  and phase = 'initial_scan';
update public.team_drive_connections
set initial_sync_state = 'ready', last_synced_at = clock_timestamp()
where id = (select connection_id from pg_temp.us7_same_root_connection);

create temporary table us7_manual_resync as
select *
from public.request_team_catalog_resync((select id from pg_temp.us7_same_root_team));

select is(
  (select initial_sync_state from pg_temp.us7_manual_resync),
  'scanning',
  'an owner can queue a recursive resync for the already connected root'
);
select is(
  (
    select connection.state || '|' || connection.initial_sync_state
    from public.team_drive_connections as connection
    where connection.id = (select connection_id from pg_temp.us7_same_root_connection)
  ),
  'connected|scanning',
  'manual resync keeps the current Drive connection intact while scanning'
);
select is(
  (
    select count(*)
    from private.catalog_sync_jobs as job
    where job.connection_id = (select connection_id from pg_temp.us7_same_root_connection)
      and job.phase = 'initial_scan'
      and job.state in ('pending', 'leased', 'retry')
  ),
  1::bigint,
  'manual resync queues exactly one active full scan'
);
select is(
  (
    select sync_job_id
    from public.request_team_catalog_resync((select id from pg_temp.us7_same_root_team))
  ),
  (select sync_job_id from pg_temp.us7_manual_resync),
  'a repeated manual resync reuses the existing full scan job'
);
select is(
  (
    select count(*)
    from private.catalog_sync_jobs as job
    where job.connection_id = (select connection_id from pg_temp.us7_same_root_connection)
      and job.phase = 'initial_scan'
      and job.state in ('pending', 'leased', 'retry')
  ),
  1::bigint,
  'repeat resync clicks do not create competing recursive scans'
);
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000002',
  true
);
select is(
  auth.uid(),
  '10000000-0000-4000-8000-000000000002'::uuid,
  'the resync authorization check runs as the non-owner'
);
select is(
  private.team_role(
    (select id from pg_temp.us7_same_root_team),
    auth.uid()
  ),
  null,
  'the resync authorization check uses an account outside the space'
);
select throws_ok(
  $$
    select *
    from public.request_team_catalog_resync((select id from pg_temp.us7_same_root_team))
  $$,
  '42501',
  'PERMISSION_DENIED',
  'only the space owner can queue a full Drive resync'
);

select * from finish();
rollback;
