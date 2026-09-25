begin;
select plan(6);

select ok(not has_table_privilege('authenticated',
  'private.catalog_sync_scheduler_state', 'select'),
  'browser roles cannot inspect scheduler state');
select ok(not has_function_privilege('authenticated',
  'private.claim_catalog_sync_jobs(text,integer,integer)', 'execute'),
  'browser roles cannot claim private jobs');

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
values ('b0310000-0000-4000-8000-000000000001','authenticated','authenticated',
  'fairness-pgtap@example.test','{}','{}');
insert into public.teams(id,name,owner_id) values
  ('b0310000-0000-4000-8000-000000000011','Fairness A','b0310000-0000-4000-8000-000000000001'),
  ('b0310000-0000-4000-8000-000000000012','Fairness B','b0310000-0000-4000-8000-000000000001');
insert into private.google_drive_credentials
  (id,google_permission_id,google_account_email,scope,vault_secret_id,connected_by)
values ('b0310000-0000-4000-8000-000000000021','fairness-pgtap',
  'fairness-pgtap@example.test','https://www.googleapis.com/auth/drive.file',
  gen_random_uuid(),'b0310000-0000-4000-8000-000000000001');
insert into public.team_drive_connections
  (id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state)
values
  ('b0310000-0000-4000-8000-000000000031',
    'b0310000-0000-4000-8000-000000000011',
    'b0310000-0000-4000-8000-000000000021','root','Root','my_drive','connected'),
  ('b0310000-0000-4000-8000-000000000032',
    'b0310000-0000-4000-8000-000000000012',
    'b0310000-0000-4000-8000-000000000021','root','Root','my_drive','connected');
insert into private.catalog_sync_jobs
  (id,connection_id,job_kind,phase,cursor,requested_folder_id,next_attempt_at)
values
  ('b0310000-0000-4000-8000-000000000041',
    'b0310000-0000-4000-8000-000000000031','user_subtree','initial_scan','{}','root',now()),
  ('b0310000-0000-4000-8000-000000000042',
    'b0310000-0000-4000-8000-000000000032','incremental','incremental','{}',null,now());

create temp table fairness_claim_1 as
select job_id, lease_epoch from public.service_claim_catalog_sync_work('fairness-pgtap',1,180);
select is((select job_id from fairness_claim_1),
  'b0310000-0000-4000-8000-000000000041'::uuid,
  'first slot prioritizes user work');
select public.service_release_catalog_sync_job(job_id,'fairness-pgtap',lease_epoch)
  from fairness_claim_1;
update private.catalog_sync_jobs set next_attempt_at = now()
where id = 'b0310000-0000-4000-8000-000000000041';
create temp table fairness_claim_2 as
select job_id, lease_epoch from public.service_claim_catalog_sync_work('fairness-pgtap',1,180);
select is((select job_id from fairness_claim_2),
  'b0310000-0000-4000-8000-000000000041'::uuid,
  'second slot still prioritizes user work');
select public.service_release_catalog_sync_job(job_id,'fairness-pgtap',lease_epoch)
  from fairness_claim_2;
update private.catalog_sync_jobs set next_attempt_at = now()
where id = 'b0310000-0000-4000-8000-000000000041';
create temp table fairness_claim_3 as
select job_id, lease_epoch from public.service_claim_catalog_sync_work('fairness-pgtap',1,180);
select is((select job_id from fairness_claim_3),
  'b0310000-0000-4000-8000-000000000041'::uuid,
  'third slot still prioritizes user work');
select public.service_release_catalog_sync_job(job_id,'fairness-pgtap',lease_epoch)
  from fairness_claim_3;
update private.catalog_sync_jobs set next_attempt_at = now()
where id = 'b0310000-0000-4000-8000-000000000041';
create temp table fairness_claim_4 as
select job_id, lease_epoch from public.service_claim_catalog_sync_work('fairness-pgtap',1,180);
select is((select job_id from fairness_claim_4),
  'b0310000-0000-4000-8000-000000000042'::uuid,
  'fourth slot reserves background work');

select * from finish();
rollback;
