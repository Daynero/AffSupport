begin;
select plan(15);

-- 2026-11-25: a catalog generation whose image step stopped within its invocation's CPU hands
-- itself on at once instead of waiting out its 180 s lease.
select ok(has_function_privilege('service_role','public.service_yield_launch_generation(uuid,uuid,uuid,text,text)','EXECUTE'),'the worker may hand a generation on');
select ok(not has_function_privilege('authenticated','public.service_yield_launch_generation(uuid,uuid,uuid,text,text)','EXECUTE'),'a browser may not');
select ok(not has_function_privilege('anon','public.service_yield_launch_generation(uuid,uuid,uuid,text,text)','EXECUTE'),'nor a signed-out caller');
select ok((select 'search_path=""'=any(p.proconfig) from pg_proc p where p.oid='public.service_yield_launch_generation(uuid,uuid,uuid,text,text)'::regprocedure),'closed over its search_path');

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('c0790000-0000-4000-8000-000000000001','authenticated','authenticated','yield-owner@test.invalid','{}','{}'),
 ('c0790000-0000-4000-8000-000000000002','authenticated','authenticated','yield-stranger@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('c0790000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
 ('c0790000-0000-4000-8000-000000000011','Yield fixture','c0790000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('c0790000-0000-4000-8000-000000000011','c0790000-0000-4000-8000-000000000001','admin');
insert into public.team_launches(id,team_id,created_by,draft_config) values
 ('c0790000-0000-4000-8000-000000000101','c0790000-0000-4000-8000-000000000011','c0790000-0000-4000-8000-000000000001','{}');
insert into public.team_launch_revisions(id,team_id,launch_id,revision_no,result_kind,config,sources,original_url,generated_url,sub_values,created_by)
 values('c0790000-0000-4000-8000-000000000201','c0790000-0000-4000-8000-000000000011','c0790000-0000-4000-8000-000000000101',1,'generated',
  '{"method":"catalog","catalog":{"catalogVideoProtocolVersion":1}}','{"materialType":"image"}','https://offer.example.invalid/','https://offer.example.invalid/?s=1','{}','c0790000-0000-4000-8000-000000000001');
insert into public.team_launch_generations(id,team_id,launch_id,revision_id,actor_id,request_key,request_digest,input_version,state,stage,lease_owner,lease_expires_at,next_attempt_at)
 values('c0790000-0000-4000-8000-000000000301','c0790000-0000-4000-8000-000000000011','c0790000-0000-4000-8000-000000000101','c0790000-0000-4000-8000-000000000201',
  'c0790000-0000-4000-8000-000000000001','yield-generation-1','digest','v1','running','catalog_planning','owner-a',clock_timestamp()+interval '3 minutes',clock_timestamp()+interval '3 minutes');
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('c0790000-0000-4000-8000-000000000021','c0790000-0000-4000-8000-000000000001','yield-test','yield-owner@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('c0790000-0000-4000-8000-000000000031','c0790000-0000-4000-8000-000000000011','c0790000-0000-4000-8000-000000000021','yield-root','Root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version,checksum) values
 ('c0790000-0000-4000-8000-000000000041','c0790000-0000-4000-8000-000000000011','c0790000-0000-4000-8000-000000000031','yield-i1','Picture.png','file','image','image/png','1','4123456789abcdef0123456789abcdef');
insert into private.catalog_generation_intents(id,team_id,video_material_id,actor_id,request_key,request_digest,request_payload,variant,state,checkpoint,lease_owner,lease_expires_at)
 values('c0790000-0000-4000-8000-000000000401','c0790000-0000-4000-8000-000000000011','c0790000-0000-4000-8000-000000000041','c0790000-0000-4000-8000-000000000001',
  'launch:c0790000-0000-4000-8000-000000000301:catalog','digest','{}',1,'planned','{"creativeImage_0":{"id":null,"url":"https://x.invalid/c1/a","linkKind":"r2"}}',
  'c0790000-0000-4000-8000-000000000901',clock_timestamp()+interval '3 minutes');
create function pg_temp.fence() returns text language sql as $$ select fence::text from public.team_launch_generations where id='c0790000-0000-4000-8000-000000000301' $$;

select throws_ok($$select public.service_yield_launch_generation('c0790000-0000-4000-8000-000000000011','c0790000-0000-4000-8000-000000000301','c0790000-0000-4000-8000-000000000001','owner-b',pg_temp.fence())$$,
 '55000','LEASE_MISMATCH','another executor cannot hand it on');
select throws_ok($$select public.service_yield_launch_generation('c0790000-0000-4000-8000-000000000011','c0790000-0000-4000-8000-000000000301','c0790000-0000-4000-8000-000000000001','owner-a','999')$$,
 '55000','LEASE_MISMATCH','a stale fence cannot');
select throws_ok($$select public.service_yield_launch_generation('c0790000-0000-4000-8000-000000000011','c0790000-0000-4000-8000-000000000301','c0790000-0000-4000-8000-000000000002','owner-a',pg_temp.fence())$$,
 '42501','PERMISSION_DENIED','a stranger cannot');

select lives_ok($$select public.service_yield_launch_generation('c0790000-0000-4000-8000-000000000011','c0790000-0000-4000-8000-000000000301','c0790000-0000-4000-8000-000000000001','owner-a',pg_temp.fence())$$,
 'the lease holder hands it on');
select is((select state from public.team_launch_generations where id='c0790000-0000-4000-8000-000000000301'),'running','it is still running');
select is((select stage from public.team_launch_generations where id='c0790000-0000-4000-8000-000000000301'),'catalog_planning','at the same stage');
select ok((select lease_expires_at<=clock_timestamp() and next_attempt_at<=clock_timestamp() from public.team_launch_generations where id='c0790000-0000-4000-8000-000000000301'),
 'its lease is released and it is due now');
select ok((select lease_expires_at<=clock_timestamp() and state='planned' and checkpoint ? 'creativeImage_0' from private.catalog_generation_intents where id='c0790000-0000-4000-8000-000000000401'),
 'its catalog intent lets go of its lease and keeps its state and checkpoints');
select ok((select x->>'generationId' from jsonb_array_elements(public.service_list_launch_catalog_recovery(10)) x where x->>'generationId'='c0790000-0000-4000-8000-000000000301') is not null,
 'the recovery pass lists it at once');
select throws_ok($$select public.service_yield_launch_generation('c0790000-0000-4000-8000-000000000011','c0790000-0000-4000-8000-000000000301','c0790000-0000-4000-8000-000000000001','owner-a',pg_temp.fence())$$,
 '55000','LEASE_MISMATCH','a released lease cannot be handed on twice');
update public.team_launch_generations set state='succeeded',lease_owner='owner-c',lease_expires_at=clock_timestamp()+interval '3 minutes' where id='c0790000-0000-4000-8000-000000000301';
select throws_ok($$select public.service_yield_launch_generation('c0790000-0000-4000-8000-000000000011','c0790000-0000-4000-8000-000000000301','c0790000-0000-4000-8000-000000000001','owner-c',pg_temp.fence())$$,
 '55000','LEASE_MISMATCH','a finished generation is never reopened');

select * from finish();
rollback;
