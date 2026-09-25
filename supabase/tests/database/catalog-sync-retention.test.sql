begin;
select plan(9);

select ok(not has_function_privilege('authenticated',
  'private.cleanup_catalog_sync_retention(integer)', 'execute'),
  'browser roles cannot invoke retention cleanup');

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
values ('b0330000-0000-4000-8000-000000000001','authenticated','authenticated',
  'retention-pgtap@example.test','{}','{}');
insert into public.teams(id,name,owner_id) values
  ('b0330000-0000-4000-8000-000000000011','Retention','b0330000-0000-4000-8000-000000000001');
insert into private.google_drive_credentials
  (id,google_permission_id,google_account_email,scope,vault_secret_id,connected_by)
values ('b0330000-0000-4000-8000-000000000021','retention-pgtap',
  'retention-pgtap@example.test','https://www.googleapis.com/auth/drive.file',
  gen_random_uuid(),'b0330000-0000-4000-8000-000000000001');
insert into public.team_drive_connections
  (id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state)
values ('b0330000-0000-4000-8000-000000000031',
  'b0330000-0000-4000-8000-000000000011',
  'b0330000-0000-4000-8000-000000000021','root','Root','my_drive','connected');

insert into private.catalog_sync_jobs
  (id,connection_id,job_kind,phase,cursor,requested_folder_id,state,completed_at)
values ('b0330000-0000-4000-8000-000000000041',
  'b0330000-0000-4000-8000-000000000031','user_subtree','initial_scan',
  '{}','root','succeeded',now() - interval '8 days');
insert into private.catalog_sync_jobs
  (id,connection_id,job_kind,phase,cursor,state,next_attempt_at)
values ('b0330000-0000-4000-8000-000000000042',
  'b0330000-0000-4000-8000-000000000031','incremental','incremental',
  '{}','pending',now());
insert into private.catalog_scan_generations
  (id,job_id,parent_folder_id,state,updated_at)
values ('b0330000-0000-4000-8000-000000000051',
  'b0330000-0000-4000-8000-000000000041','root','done',now() - interval '8 days');
insert into private.catalog_scan_frontier(job_id,folder_id,generation,state)
values ('b0330000-0000-4000-8000-000000000041','root',
  'b0330000-0000-4000-8000-000000000051','done');
insert into private.catalog_scan_seen(job_id,generation,parent_folder_id,drive_file_id)
select 'b0330000-0000-4000-8000-000000000041',
  'b0330000-0000-4000-8000-000000000051','root','file-' || n
from generate_series(1,3) as n;

select is((private.cleanup_catalog_sync_retention(2)->>'seen')::integer, 2,
  'first batch deletes at most two observations');
select is((select count(*)::integer from private.catalog_scan_seen
  where job_id = 'b0330000-0000-4000-8000-000000000041'), 1,
  'one seen row remains after bounded batch');
select is((private.cleanup_catalog_sync_retention(2)->>'seen')::integer, 1,
  'next batch drains remaining observation');
select is((select count(*)::integer from private.catalog_sync_jobs
  where id = 'b0330000-0000-4000-8000-000000000041'), 1,
  'job remains while frontier and generation are still linked');
select private.cleanup_catalog_sync_retention(2);
select is((select count(*)::integer from private.catalog_sync_jobs
  where id = 'b0330000-0000-4000-8000-000000000041'), 0,
  'old terminal finite job is deleted after staging dependencies');
select ok(exists (select 1 from private.catalog_sync_jobs
  where connection_id = 'b0330000-0000-4000-8000-000000000031'
    and job_kind = 'incremental'),
  'canonical incremental job remains');

insert into private.catalog_scan_generations
  (id,job_id,parent_folder_id,state,updated_at)
values ('b0330000-0000-4000-8000-000000000052',
  'b0330000-0000-4000-8000-000000000042','old','abandoned',
  now() - interval '25 hours');
insert into private.catalog_scan_seen(job_id,generation,parent_folder_id,drive_file_id)
values ('b0330000-0000-4000-8000-000000000042',
  'b0330000-0000-4000-8000-000000000052','old','orphan');
select private.cleanup_catalog_sync_retention(2);
select is((select count(*)::integer from private.catalog_scan_generations
  where id = 'b0330000-0000-4000-8000-000000000052'), 0,
  'abandoned generation older than 24h is cleared without a live lease');

update private.catalog_sync_jobs set state = 'leased', lease_owner = 'retention-worker',
  lease_expires_at = now() + interval '1 hour'
where id = 'b0330000-0000-4000-8000-000000000042';
insert into private.catalog_scan_generations
  (id,job_id,parent_folder_id,state,updated_at)
values ('b0330000-0000-4000-8000-000000000053',
  'b0330000-0000-4000-8000-000000000042','live','abandoned',
  now() - interval '25 hours');
insert into private.catalog_scan_seen(job_id,generation,parent_folder_id,drive_file_id)
values ('b0330000-0000-4000-8000-000000000042',
  'b0330000-0000-4000-8000-000000000053','live','protected');
select private.cleanup_catalog_sync_retention(2);
select is((select count(*)::integer from private.catalog_scan_seen
  where generation = 'b0330000-0000-4000-8000-000000000053'), 1,
  'live lease protects abandoned generation evidence');

select * from finish();
rollback;
