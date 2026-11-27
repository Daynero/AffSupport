begin;
select plan(16);

-- 057 T019: the Drive paths never touch an R2 space (20261226140000). The file contexts of
-- drive-ops refuse it with STORAGE_BACKEND_MISMATCH, and only to a member; the backend lookup
-- answers members only; delegated background work for it is not claimed by an agent of team
-- workspace contract 2; catalog-sync never leases it. A Drive space answers as before.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05719000-0000-4000-8000-000000000001','authenticated','authenticated','iso-pilot@test.invalid','{}','{}'),
 ('05719000-0000-4000-8000-000000000002','authenticated','authenticated','iso-outsider@test.invalid','{}','{}'),
 ('05719000-0000-4000-8000-000000000003','authenticated','authenticated','iso-admin@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('05719000-0000-4000-8000-000000000003');
insert into public.storage_r2_pilots(user_id,max_space_bytes) values('05719000-0000-4000-8000-000000000001',1000000000);
insert into public.teams(id,name,owner_id,storage_backend,storage_pilot) values
 ('05719000-0000-4000-8000-000000000011','Iso R2','05719000-0000-4000-8000-000000000001','r2',true);
insert into public.teams(id,name,owner_id) values
 ('05719000-0000-4000-8000-000000000012','Iso Drive','05719000-0000-4000-8000-000000000003');
insert into public.team_members(team_id,user_id,base_role) values
 ('05719000-0000-4000-8000-000000000011','05719000-0000-4000-8000-000000000001','admin'),
 ('05719000-0000-4000-8000-000000000012','05719000-0000-4000-8000-000000000003','admin'),
 ('05719000-0000-4000-8000-000000000012','05719000-0000-4000-8000-000000000001','editor')
 on conflict do nothing;
insert into public.team_materials(id,team_id,name,kind) values
 ('05719000-0000-4000-8000-000000000101','05719000-0000-4000-8000-000000000011','Iso R2','folder');
update public.teams set storage_root_material_id='05719000-0000-4000-8000-000000000101' where id='05719000-0000-4000-8000-000000000011';
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('05719000-0000-4000-8000-000000000021','05719000-0000-4000-8000-000000000003','iso-drive','iso-admin@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('05719000-0000-4000-8000-000000000031','05719000-0000-4000-8000-000000000012','05719000-0000-4000-8000-000000000021','iso-root','Root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type) values
 ('05719000-0000-4000-8000-000000000141','05719000-0000-4000-8000-000000000012','05719000-0000-4000-8000-000000000031','iso-clip','iso-root','Clip.mp4','file','video','video/mp4');

-- 1. drive-ops contexts -----------------------------------------------------------------------
select throws_ok($$select * from public.service_get_material_operation_context('05719000-0000-4000-8000-000000000011','05719000-0000-4000-8000-000000000101','05719000-0000-4000-8000-000000000001','view')$$,
 '55000','STORAGE_BACKEND_MISMATCH','a drive-ops file route on an R2 material is refused as the wrong backend');
select throws_ok($$select * from public.service_get_root_operation_context('05719000-0000-4000-8000-000000000011','05719000-0000-4000-8000-000000000001','upload')$$,
 '55000','STORAGE_BACKEND_MISMATCH','and so is one on the root of an R2 space');
select is((select count(*)::int from public.service_get_material_operation_context('05719000-0000-4000-8000-000000000011','05719000-0000-4000-8000-000000000101','05719000-0000-4000-8000-000000000002','view')),0,
 'someone outside the space is not told which backend it has');
select is((select drive_file_id from public.service_get_material_operation_context('05719000-0000-4000-8000-000000000012','05719000-0000-4000-8000-000000000141','05719000-0000-4000-8000-000000000003','view')),
 'iso-clip','a Drive material answers as before');
select is((select root_folder_id from public.service_get_root_operation_context('05719000-0000-4000-8000-000000000012','05719000-0000-4000-8000-000000000003','upload')),
 'iso-root','and so does a Drive root');

-- 2. Backend lookup -------------------------------------------------------------------------
select is(public.service_space_storage_backend('05719000-0000-4000-8000-000000000011','05719000-0000-4000-8000-000000000001'),'r2',
 'a member learns the backend of an R2 space');
select is(public.service_space_storage_backend('05719000-0000-4000-8000-000000000012','05719000-0000-4000-8000-000000000001'),'drive',
 'and of a Drive space');
select is(public.service_space_storage_backend('05719000-0000-4000-8000-000000000011','05719000-0000-4000-8000-000000000002'),null,
 'someone outside the space learns nothing');
select ok(not has_function_privilege('authenticated','public.service_space_storage_backend(uuid,uuid)','execute'),
 'a browser cannot ask');

-- 3. Delegated background work ----------------------------------------------------------------
insert into private.team_recovery_delegations(id,team_id,actor_id,installation_id,refresh_hash) values
 ('05719000-0000-4000-8000-000000000051','05719000-0000-4000-8000-000000000011','05719000-0000-4000-8000-000000000001',
  '05719000-0000-4000-8000-000000000061',decode(repeat('a1',32),'hex')),
 ('05719000-0000-4000-8000-000000000052','05719000-0000-4000-8000-000000000012','05719000-0000-4000-8000-000000000003',
  '05719000-0000-4000-8000-000000000062',decode(repeat('a2',32),'hex'));
insert into private.team_recovery_credentials(hash,delegation_id,version,audience,expires_at) values
 (decode(repeat('b1',32),'hex'),'05719000-0000-4000-8000-000000000051',1,'claim',clock_timestamp()+interval '5 minutes'),
 (decode(repeat('b2',32),'hex'),'05719000-0000-4000-8000-000000000052',1,'claim',clock_timestamp()+interval '5 minutes');
create function pg_temp.claim_error(p_hash bytea, p_input jsonb) returns text language plpgsql as $$
begin
  perform public.service_team_recovery('claim', p_hash, p_input);
  return 'answered';
exception when others then
  return sqlerrm;
end;
$$;
select is(pg_temp.claim_error(decode(repeat('b1',32),'hex'),'{"requestId":"05719000-0000-4000-8000-000000000071","protocolVersion":2}'),
 'AGENT_UPDATE_REQUIRED','an agent that declares no workspace contract cannot claim work for an R2 space');
select is(pg_temp.claim_error(decode(repeat('b1',32),'hex'),'{"requestId":"05719000-0000-4000-8000-000000000072","protocolVersion":2,"teamWorkspaceContract":2}'),
 'AGENT_UPDATE_REQUIRED','nor one of contract 2');
select isnt(pg_temp.claim_error(decode(repeat('b1',32),'hex'),'{"requestId":"05719000-0000-4000-8000-000000000073","protocolVersion":2,"teamWorkspaceContract":3}'),
 'AGENT_UPDATE_REQUIRED','contract 3 passes the guard');
select isnt(pg_temp.claim_error(decode(repeat('b2',32),'hex'),'{"requestId":"05719000-0000-4000-8000-000000000074","protocolVersion":2}'),
 'AGENT_UPDATE_REQUIRED','a Drive space is claimed by today''s agent as before');

-- 4. catalog-sync ---------------------------------------------------------------------------
-- An R2 space cannot get a Drive connection; the trigger is lifted here only to prove that the
-- claim's own condition holds even if one appeared.
update private.catalog_sync_scheduler_state set claim_sequence = 0 where singleton;
alter table public.team_drive_connections disable trigger team_drive_connections_backend;
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('05719000-0000-4000-8000-000000000032','05719000-0000-4000-8000-000000000011','05719000-0000-4000-8000-000000000021','iso-r2-root','Root','my_drive','connected',now());
alter table public.team_drive_connections enable trigger team_drive_connections_backend;
update private.catalog_sync_jobs set state='completed', completed_at=now()
 where connection_id in ('05719000-0000-4000-8000-000000000031','05719000-0000-4000-8000-000000000032');
insert into private.catalog_sync_jobs(id,connection_id,job_kind,phase,cursor,requested_folder_id,next_attempt_at) values
 ('05719000-0000-4000-8000-000000000041','05719000-0000-4000-8000-000000000032','user_subtree','initial_scan','{}','iso-r2-root',now()),
 ('05719000-0000-4000-8000-000000000042','05719000-0000-4000-8000-000000000031','user_subtree','initial_scan','{}','iso-root',now());
create temporary table iso_claimed as select id from private.claim_catalog_sync_jobs('iso-pgtap',5,60);
select is((select count(*)::int from iso_claimed where id='05719000-0000-4000-8000-000000000041'),0,
 'catalog-sync never leases a job of an R2 space');
select is((select count(*)::int from iso_claimed where id='05719000-0000-4000-8000-000000000042'),1,
 'and still leases the Drive space''s job');
select ok(position('space_storage_drive_only' in pg_get_functiondef('private.claim_catalog_sync_jobs(text,integer,integer)'::regprocedure))>0,
 'the condition is written into the claim, not only implied by the missing connection');

select * from finish();
rollback;
