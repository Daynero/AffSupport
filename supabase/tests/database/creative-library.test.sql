begin;

select plan(79);

select has_table('public', 'team_upload_batches', 'upload batch authority exists');
select has_table('public', 'team_upload_batch_items', 'upload batch items exist');
select has_table('private', 'team_library_folders', 'canonical folder mapping stays private');
select has_table('private', 'team_material_enrichments', 'light enrichment queue stays private');
select has_table('public', 'team_library_requirements', 'shared processing requirements exist');
select has_table('private', 'team_library_attempts', 'lease attempts stay private');
select has_table('public', 'team_library_results', 'accepted shared results exist');
select has_table('private', 'team_material_group_intents', 'group sagas stay private');
select has_table('public', 'team_tasks', 'team tasks exist');
select has_table('public', 'team_task_attachments', 'task reference attachments exist');
select has_table('public', 'team_share_preferences', 'scoped share preferences exist');
select has_table('public', 'team_contribution_records', 'separate contributions exist');

select is_empty(
  $$
    select format('%I.%I', n.nspname, c.relname)
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r','p')
      and c.relname in (
        'team_upload_batches','team_upload_batch_items','team_library_folders',
        'team_material_enrichments','team_library_requirements','team_library_attempts',
        'team_library_results','team_material_group_intents','team_tasks',
        'team_task_attachments','team_share_preferences','team_contribution_records'
      )
      and (not c.relrowsecurity or not c.relforcerowsecurity)
  $$,
  'all Creative Library tables enable and force RLS'
);

select is_empty(
  $$
    select p.oid::regprocedure::text
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','private')
      and (p.proname like '%library%' or p.proname like '%team_task%' or p.proname like '%share_preference%')
      and not p.prosecdef
  $$,
  'every Creative Library function is security definer'
);

select is_empty(
  $$
    select p.oid::regprocedure::text
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','private')
      and (p.proname like '%library%' or p.proname like '%team_task%' or p.proname like '%share_preference%')
      and not coalesce(p.proconfig, '{}'::text[]) @> array['search_path=""']::text[]
  $$,
  'every Creative Library function pins an empty search path'
);

select is_empty(
  $$
    select p.oid::regprocedure::text
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','private')
      and (p.proname like '%library%' or p.proname like '%team_task%' or p.proname like '%share_preference%')
      and has_function_privilege('public', p.oid, 'execute')
  $$,
  'PUBLIC cannot execute Creative Library functions'
);

select is_empty(
  $$
    select table_name
    from information_schema.role_table_grants
    where table_schema = 'private'
      and table_name in (
        'team_library_folders','team_material_enrichments','team_library_attempts',
        'team_material_group_intents'
      )
      and grantee in ('anon','authenticated')
  $$,
  'private library tables have no client grants'
);

select col_is_unique('public', 'team_task_attachments', array['task_id','material_id'],
  'one material attaches once per task');
select col_has_check('public', 'team_tasks', 'progress_max', 'task max has a check');
select col_has_check('public', 'team_tasks', 'progress_value', 'task value has a check');
select col_is_unique('public', 'team_library_requirements',
  array['team_id','source_material_id','source_version','kind','variant'],
  'processing need identity is unique');
select col_is_pk('public', 'team_share_preferences', array['team_id','user_id'],
  'share prompt preference is user and team scoped');

select has_function('public', 'create_team_task', 'task create RPC exists');
select has_function('public', 'list_team_tasks', 'task list RPC exists');
select has_function('public', 'update_team_task', 'task update RPC exists');
select has_function('public', 'attach_team_task_materials', 'task attachment RPC exists');
select has_function('public', 'scan_library_requirements', 'scan RPC exists');
select has_function('public', 'claim_library_job', 'job claim RPC exists');
select has_function('public', 'heartbeat_library_job', 'heartbeat RPC exists');
select has_function('public', 'list_video_text_variants', 'cached video text RPC exists');
select has_function(
  'public', 'service_append_library_contribution',
  'service-only contribution adapter exists in the exposed schema'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.service_append_library_contribution(uuid,uuid,text,text,text,uuid)',
    'EXECUTE'
  ),
  'service role can append an allowlisted contribution'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.service_append_library_contribution(uuid,uuid,text,text,text,uuid)',
    'EXECUTE'
  ),
  'authenticated callers cannot invoke the service contribution adapter'
);

select hasnt_column(
  'public', 'team_contribution_records', 'payload',
  'contributions have no arbitrary payload column'
);
select hasnt_column(
  'public', 'team_contribution_records', 'transcript_text',
  'contributions cannot store transcript content'
);
select hasnt_column(
  'public', 'team_contribution_records', 'combined_score',
  'contributions have no combined automation/human score'
);
select is_empty(
  $$
    select publication.tablename || '.' || forbidden.column_name
    from pg_catalog.pg_publication_tables as publication
    cross join unnest(publication.attnames) as published(column_name)
    join (values
      ('note'), ('transcript_text'), ('drive_file_id'), ('resource_key'),
      ('lease_token_hash'), ('member_snapshot'), ('agent_instance_id')
    ) as forbidden(column_name) on forbidden.column_name = published.column_name
    where publication.pubname = 'supabase_realtime'
      and publication.tablename in (
        'team_upload_batches','team_upload_batch_items','team_library_requirements',
        'team_tasks','team_task_attachments'
      )
  $$,
  'Creative Library Realtime columns exclude content, provider and lease payloads'
);
select ok(
  not has_table_privilege('authenticated', 'public.team_tasks', 'INSERT'),
  'authenticated cannot bypass task RPCs with direct inserts'
);
select ok(
  not has_table_privilege('authenticated', 'public.team_contribution_records', 'SELECT'),
  'authenticated cannot read contribution detail rows directly'
);

select set_config('request.jwt.claim.sub', '', true);
select throws_ok(
  $$select (public.create_team_task(
    '20000000-0000-4000-8000-000000000001', 'unauthorized', null, null, null
  )).id$$,
  '42501',
  'PERMISSION_DENIED',
  'a null caller cannot create a task'
);

insert into auth.users (
  id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '10000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
    'creative-owner@example.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '10000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
    'creative-foreign@example.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '10000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated',
    'creative-removed@example.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
  );

insert into public.admin_users (user_id)
values ('10000000-0000-4000-8000-000000000001');

insert into public.teams (id, name, owner_id) values
  (
    '20000000-0000-4000-8000-000000000001', 'Creative primary',
    '10000000-0000-4000-8000-000000000001'
  ),
  (
    '20000000-0000-4000-8000-000000000002', 'Creative foreign',
    '10000000-0000-4000-8000-000000000002'
  );
insert into public.team_members (team_id, user_id, base_role) values
  (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001', 'admin'
  ),
  (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000003', 'editor'
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002', 'admin'
  );

insert into private.google_drive_credentials (
  id, connected_by, google_permission_id, google_account_email, vault_secret_id, scope
) values
  (
    '30000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001', 'permission-a',
    'creative-owner@example.test', '31000000-0000-4000-8000-000000000001',
    'https://www.googleapis.com/auth/drive'
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002', 'permission-b',
    'creative-foreign@example.test', '31000000-0000-4000-8000-000000000002',
    'https://www.googleapis.com/auth/drive'
  );
insert into public.team_drive_connections (
  id, team_id, credential_id, root_folder_id, root_folder_name,
  drive_kind, state, initial_sync_state, connected_at
) values
  (
    '40000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    'root-a', 'Root A', 'my_drive', 'connected', 'ready', now()
  ),
  (
    '40000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000002',
    'root-b', 'Root B', 'my_drive', 'connected', 'ready', now()
  );
insert into public.team_materials (
  id, team_id, connection_id, drive_file_id, parent_folder_id, name,
  mime_type, file_extension, kind, category, drive_version, library_stage,
  structural_offer, structural_language, structural_type, placement_state
) values
  (
    '50000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'video-a', 'root-a', 'video-a.mp4', 'video/mp4', 'mp4', 'file', 'video',
    'version-a', 'library', 'Offer A', 'unknown', 'Video', 'ready'
  ),
  (
    '50000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    '40000000-0000-4000-8000-000000000002',
    'video-b', 'root-b', 'video-b.mp4', 'video/mp4', 'mp4', 'file', 'video',
    'version-b', 'library', 'Offer B', 'unknown', 'Video', 'ready'
  );

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);

create temporary table creative_test_task as
select created.*
from public.create_team_task(
  '20000000-0000-4000-8000-000000000001',
  'Launch creative',
  null,
  '10000000-0000-4000-8000-000000000003',
  '50000000-0000-4000-8000-000000000001'
) as created;

select is(
  (select count(*) from public.team_task_attachments
   where task_id = (select id from creative_test_task)),
  1::bigint,
  'create-from-media attaches exactly one stable reference transactionally'
);
select is(
  (select parent_folder_id from public.team_materials
   where id = '50000000-0000-4000-8000-000000000001'),
  'root-a',
  'creating a task does not move its media in Drive authority'
);

update public.team_members
set status = 'removed', removed_at = clock_timestamp()
where team_id = '20000000-0000-4000-8000-000000000001'
  and user_id = '10000000-0000-4000-8000-000000000003';
select is(
  (select assignee_id from public.team_tasks where id = (select id from creative_test_task)),
  null::uuid,
  'removing a member clears the live assignee while preserving the task'
);

create temporary table creative_attach_result as
select public.attach_team_task_materials(
  '20000000-0000-4000-8000-000000000001',
  (select id from creative_test_task),
  array[
    '50000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000002'
  ]::uuid[]
) as payload;
select is(
  (select payload -> 'rejected' -> 0 ->> 'code' from creative_attach_result),
  'NOT_FOUND',
  'a forged foreign-team attachment id is rejected without disclosure'
);
select is(
  (select count(*) from public.team_task_attachments
   where task_id = (select id from creative_test_task)),
  1::bigint,
  'duplicate and rejected attachments do not create extra references'
);

select is(
  (public.update_team_task(
    '20000000-0000-4000-8000-000000000001',
    (select id from creative_test_task),
    '{"progressValue":6}'::jsonb
  )).progress_value,
  6,
  'an explicit task progress value is stored exactly'
);
select is(
  (select progress_manually_set from public.team_tasks
   where id = (select id from creative_test_task)),
  true,
  'the first explicit progress value permanently enables manual progress'
);
select is(
  (public.update_team_task(
    '20000000-0000-4000-8000-000000000001',
    (select id from creative_test_task),
    '{"status":"done"}'::jsonb
  )).progress_value,
  6,
  'marking a manually controlled task done preserves its value'
);
select throws_ok(
  format(
    'select (public.update_team_task(%L::uuid,%L::uuid,%L::jsonb)).id',
    '20000000-0000-4000-8000-000000000001',
    (select id::text from creative_test_task),
    '{"progressMax":5}'
  ),
  '22023',
  'INVALID_INPUT',
  'lowering task max below value is rejected rather than clipped'
);
select is(
  (select count(*) from public.team_contribution_records
   where team_id = '20000000-0000-4000-8000-000000000001'
     and category = 'human_activity' and action_kind = 'task_created'),
  1::bigint,
  'task creation emits one content-free Human Activity record'
);
select is(
  (select count(*) from public.team_contribution_records
   where team_id = '20000000-0000-4000-8000-000000000001'
     and category = 'human_activity' and action_kind = 'task_completed'),
  1::bigint,
  'the first transition to Done emits one Human Activity record'
);
select is(
  (select count(*) from public.list_team_tasks(
    '20000000-0000-4000-8000-000000000001',
    clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 hour', null, 50
  )),
  1::bigint,
  'task date filtering uses a half-open UTC range containing the local-day fixture'
);
select is(
  (select count(*) from public.list_team_tasks(
    '20000000-0000-4000-8000-000000000001',
    clock_timestamp() + interval '1 day', clock_timestamp() + interval '2 days', null, 50
  )),
  0::bigint,
  'task date filtering excludes a different day'
);

select is(
  public.get_share_preference('20000000-0000-4000-8000-000000000001') ->> 'remembered',
  'false',
  'sharing approval is not remembered by default'
);
select is(
  public.set_share_preference('20000000-0000-4000-8000-000000000001', true),
  true,
  'a caller can remember only their own per-team sharing choice'
);
select is(
  public.get_share_preference('20000000-0000-4000-8000-000000000001') ->> 'allowLinkOnCopy',
  'true',
  'the remembered per-team sharing choice is returned to that caller'
);
select is(
  public.reset_share_preference('20000000-0000-4000-8000-000000000001'),
  true,
  'settings can reset the caller-owned sharing choice'
);
select is(
  public.get_share_preference('20000000-0000-4000-8000-000000000001') ->> 'remembered',
  'false',
  'reset removes the remembered sharing choice'
);

create temporary table creative_scan_result as
select public.scan_library_requirements(
  '20000000-0000-4000-8000-000000000001', 'uk'
) as payload;
select is(
  (select payload ->> 'started' from creative_scan_result),
  'false',
  'Process Library scan explicitly does not start work'
);
select is(
  (select count(*) from public.team_library_requirements
   where team_id = '20000000-0000-4000-8000-000000000001'),
  2::bigint,
  'scan creates one original and one interface-language requirement'
);
select public.scan_library_requirements(
  '20000000-0000-4000-8000-000000000001', 'uk'
);
select is(
  (select count(*) from public.team_library_requirements
   where team_id = '20000000-0000-4000-8000-000000000001'),
  2::bigint,
  'repeated unchanged scans are idempotent'
);
select is(
  (select count(*) from private.team_library_attempts),
  0::bigint,
  'scan creates no lease attempt'
);

create temporary table creative_claim as
select public.claim_library_job(
  '20000000-0000-4000-8000-000000000001',
  '60000000-0000-4000-8000-000000000001',
  array['transcription']::text[],
  'uk'
) as payload;
select is(
  (select payload ->> 'kind' from creative_claim),
  'transcription',
  'claim is operation-scoped to a supported kind'
);
select is(
  (select count(*) from private.team_library_attempts where state = 'leased'),
  1::bigint,
  'only one active lease row is created for the claimed requirement'
);
select throws_ok(
  $$select public.claim_library_job(
    '20000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000002',
    array['transcription']::text[],
    'uk'
  )$$,
  'P0002',
  'NO_WORK',
  'another agent cannot concurrently claim the leased operation'
);
select throws_ok(
  format(
    'select public.heartbeat_library_job(%L::uuid,%L::uuid,%L::uuid,%L,%s,%L)',
    '20000000-0000-4000-8000-000000000001',
    (select payload ->> 'attemptId' from creative_claim),
    '60000000-0000-4000-8000-000000000001',
    'wrong-lease-token-with-enough-entropy',
    25,
    'processing'
  ),
  '42501',
  'LEASE_MISMATCH',
  'a spoofed lease token cannot renew another attempt'
);
select is(
  (
    public.heartbeat_library_job(
      '20000000-0000-4000-8000-000000000001',
      (select (payload ->> 'attemptId')::uuid from creative_claim),
      '60000000-0000-4000-8000-000000000001',
      (select payload ->> 'leaseToken' from creative_claim),
      25,
      'processing'
    ) ->> 'progress'
  )::integer,
  25,
  'the matching operation lease renews with bounded progress'
);

create temporary table creative_translation_claim as
select public.claim_library_job(
  '20000000-0000-4000-8000-000000000001',
  '60000000-0000-4000-8000-000000000002',
  array['translation']::text[],
  'uk',
  '50000000-0000-4000-8000-000000000001'
) as payload;
select is(
  (select payload ->> 'kind' from creative_translation_claim),
  'translation',
  'a source-scoped compatible agent claims only that source requirement'
);
select is(
  public.fail_library_job(
    '20000000-0000-4000-8000-000000000001',
    (select (payload ->> 'attemptId')::uuid from creative_translation_claim),
    '60000000-0000-4000-8000-000000000002',
    (select payload ->> 'leaseToken' from creative_translation_claim),
    'PROCESS_FAILED'
  ),
  true,
  'an owned lease can end in a truthful failed requirement state'
);
select is(
  (select count(*) from public.team_contribution_records
   where team_id = '20000000-0000-4000-8000-000000000001'
     and category = 'local_processing' and action_kind = 'translation'
     and outcome = 'failure'),
  1::bigint,
  'failed local processing records the allowlisted failure outcome'
);
select is(
  public.retry_failed_library_jobs(
    '20000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001'
  ),
  1,
  'retry returns a failed source-scoped job to the shared queue'
);

select lives_ok(
  $$select public.service_append_library_contribution(
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'human_activity', 'find_selected', 'success', null
  )$$,
  'the contribution allowlist accepts a separate Finds-selection action'
);
select is(
  (select count(*) from public.team_contribution_records
   where team_id = '20000000-0000-4000-8000-000000000001'
     and category = 'human_activity' and action_kind = 'find_selected'),
  1::bigint,
  'Finds selection remains separate from Local Processing contribution'
);
select is(
  (select count(distinct category) from public.list_library_contribution_totals(
    '20000000-0000-4000-8000-000000000001', null, null
  )),
  2::bigint,
  'owner/admin aggregates preserve separate Local Processing and Human Activity categories'
);

update public.team_materials
set lifecycle = 'trashed', trashed_at = clock_timestamp()
where id = '50000000-0000-4000-8000-000000000001';
select is(
  (select count(*) from public.team_task_attachments
   where task_id = (select id from creative_test_task)),
  1::bigint,
  'an existing task reference survives source trashing for an unavailable tile'
);
create temporary table creative_trashed_attach_result as
select public.attach_team_task_materials(
  '20000000-0000-4000-8000-000000000001',
  (select id from creative_test_task),
  array['50000000-0000-4000-8000-000000000001']::uuid[]
) as payload;
select is(
  (select payload -> 'rejected' -> 0 ->> 'code' from creative_trashed_attach_result),
  'NOT_FOUND',
  'a trashed material cannot be newly attached or disclosed through the mutation'
);
select is(
  (select count(*) from public.team_task_attachments
   where task_id = (select id from creative_test_task)),
  1::bigint,
  're-attaching a trashed id creates no duplicate reference'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000002',
  true
);
select throws_ok(
  $$select * from public.list_team_tasks(
    '20000000-0000-4000-8000-000000000001', null, null, null, 50
  )$$,
  '42501',
  'PERMISSION_DENIED',
  'a foreign-team caller cannot list tasks'
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000003',
  true
);
select throws_ok(
  $$select * from public.list_team_tasks(
    '20000000-0000-4000-8000-000000000001', null, null, null, 50
  )$$,
  '42501',
  'PERMISSION_DENIED',
  'a removed team member cannot list tasks'
);

select * from finish();
rollback;
