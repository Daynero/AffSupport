begin;
select plan(6);

select ok(
  has_function_privilege('service_role',
    'public.service_enqueue_discovered_catalog_subtree(uuid,text,bigint,text,text)', 'execute'),
  'only the catalog service can request discovered subtree work'
);
select ok(
  not has_function_privilege('authenticated',
    'public.service_enqueue_discovered_catalog_subtree(uuid,text,bigint,text,text)', 'execute'),
  'browser roles cannot enqueue provider-discovered work'
);

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
values ('b0260000-0000-4000-8000-000000000001','authenticated','authenticated',
  'discovered-pgtap@example.test','{}','{}');
insert into public.teams(id,name,owner_id)
values ('b0260000-0000-4000-8000-000000000011','Discovered scope',
  'b0260000-0000-4000-8000-000000000001');
insert into private.google_drive_credentials
  (id,google_permission_id,google_account_email,scope,vault_secret_id,connected_by)
values ('b0260000-0000-4000-8000-000000000021','discovered-pgtap',
  'discovered-pgtap@example.test','https://www.googleapis.com/auth/drive.file',
  gen_random_uuid(),'b0260000-0000-4000-8000-000000000001');
insert into public.team_drive_connections
  (id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state)
values ('b0260000-0000-4000-8000-000000000031',
  'b0260000-0000-4000-8000-000000000011',
  'b0260000-0000-4000-8000-000000000021','root','Root','my_drive','connected');
insert into private.catalog_sync_jobs
  (id,connection_id,job_kind,phase,cursor)
values ('b0260000-0000-4000-8000-000000000041',
  'b0260000-0000-4000-8000-000000000031','incremental','incremental',
  '{"pageToken":"change-1","changePageToken":"change-1"}');
create temporary table discovered_claim as
select job_id, lease_epoch from public.service_claim_catalog_sync_work('discovered-pgtap',1,180);

select is((select job_id from discovered_claim),
  'b0260000-0000-4000-8000-000000000041'::uuid,
  'canonical worker holds the connection lease');
select ok((select public.service_enqueue_discovered_catalog_subtree(
  job_id,'discovered-pgtap',lease_epoch,'new-folder','root') from discovered_claim),
  'new folder receives finite work');
select is((select count(*)::int from private.catalog_sync_jobs
  where connection_id = 'b0260000-0000-4000-8000-000000000031'
    and job_kind = 'discovered_subtree' and requested_folder_id = 'new-folder'), 1,
  'one discovered finite job is present');
select is((select public.service_enqueue_discovered_catalog_subtree(
  job_id,'wrong-worker',lease_epoch,'other-folder','root') from discovered_claim), false,
  'lost lease cannot enqueue additional work');

select * from finish();
rollback;
