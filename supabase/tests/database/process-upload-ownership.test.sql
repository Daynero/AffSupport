begin;
select plan(21);

select has_table('private','process_upload_ownership','output ownership is durable');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='private.process_upload_ownership'::regclass),'ownership forces RLS');
select ok(not has_function_privilege('authenticated','public.service_prepare_process_upload(uuid,uuid,uuid,text,text)','execute'),'clients cannot bind provider identity');
select ok(not has_function_privilege('anon','public.service_claim_process_output_cleanup(uuid,integer)','execute'),'anonymous callers cannot claim cleanup');
select ok(not has_table_privilege('authenticated','public.analytics_process_output_cleanup','select'),'client cannot read diagnostic projection');
select ok(not has_table_privilege('service_role','private.process_upload_ownership','select'),'service must use scoped functions');

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('b1390000-0000-4000-8000-000000000001','authenticated','authenticated','output-owner@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('b1390000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
 ('b1390000-0000-4000-8000-000000000011','Synthetic output ownership','b1390000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('b1390000-0000-4000-8000-000000000011','b1390000-0000-4000-8000-000000000001','admin');
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('b1390000-0000-4000-8000-000000000021','b1390000-0000-4000-8000-000000000001','synthetic-output-owner','output-owner@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('b1390000-0000-4000-8000-000000000031','b1390000-0000-4000-8000-000000000011','b1390000-0000-4000-8000-000000000021','own-root','Synthetic root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,mime_type,category) values
 ('b1390000-0000-4000-8000-000000000041','b1390000-0000-4000-8000-000000000011','b1390000-0000-4000-8000-000000000031','source-process-original','original.mp4','file','video/mp4','video');
insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)
 select op,'b1390000-0000-4000-8000-000000000011','b1390000-0000-4000-8000-000000000001','process','running',
 'b1390000-0000-4000-8000-000000000041',op::text,op::text from unnest(array[
 'b1390000-0000-4000-8000-000000000051'::uuid,'b1390000-0000-4000-8000-000000000052'::uuid]) op;
insert into private.team_operation_intents(operation_id,team_id,expected_name,mime_type,expected_size,tool_id,tool_contract_version)
 select id,team_id,'output-'||id::text||'.mp4','video/mp4',16,'compressor',1 from public.team_operations
 where team_id='b1390000-0000-4000-8000-000000000011';
insert into private.team_transfer_grants(token_hash,operation_id,team_id,actor_id,purpose,tool_id,max_range_bytes,expires_at,max_uses)
 select decode(md5(id::text)||md5(id::text||':grant'),'hex'),id,team_id,actor_id,'finalize','compressor',2097152,now()+interval '1 hour',4
 from public.team_operations where team_id='b1390000-0000-4000-8000-000000000011';

select is(public.service_prepare_process_upload('b1390000-0000-4000-8000-000000000051','b1390000-0000-4000-8000-000000000001',
 'b1390000-0000-4000-8000-000000000031','reserved-process-no-start',repeat('a',32))->>'fileId','reserved-process-no-start','identity commits before provider request');
do $$begin
 perform set_config('request.jwt.claim.sub','b1390000-0000-4000-8000-000000000001',true);
 perform public.cancel_team_operation('b1390000-0000-4000-8000-000000000011','b1390000-0000-4000-8000-000000000051');
end$$;
select is((select cleanup_state from private.process_upload_ownership where operation_id='b1390000-0000-4000-8000-000000000051'),'not_created','cancel before start proves no create');
select throws_ok($$select public.service_start_process_upload('b1390000-0000-4000-8000-000000000051','b1390000-0000-4000-8000-000000000001')$$,'55000','WRONG_STATE','late provider start is refused');

select is(public.service_prepare_process_upload('b1390000-0000-4000-8000-000000000052','b1390000-0000-4000-8000-000000000001',
 'b1390000-0000-4000-8000-000000000031','reserved-process-inflight',repeat('a',32))->>'fileId','reserved-process-inflight','inflight upload has exact identity');
select is(public.service_start_process_upload('b1390000-0000-4000-8000-000000000052','b1390000-0000-4000-8000-000000000001'),true,'provider start is fenced');
do $$begin perform public.cancel_team_operation('b1390000-0000-4000-8000-000000000011','b1390000-0000-4000-8000-000000000052');end$$;
select is((select cleanup_state from private.process_upload_ownership where operation_id='b1390000-0000-4000-8000-000000000052'),'pending','inflight cancel remains pending');
create temporary table output_cleanup_claim(plan jsonb) on commit drop;
insert into output_cleanup_claim select public.service_claim_process_output_cleanup('b1390000-0000-4000-8000-000000000061',3);
select is((select jsonb_array_length(plan) from output_cleanup_claim),1,'only the started canceled output is claimed');
select is(public.service_authorize_process_output_cleanup('b1390000-0000-4000-8000-000000000052','b1390000-0000-4000-8000-000000000061',
 (select plan->0->>'fence' from output_cleanup_claim)),true,'current exact cleanup lease is authorized');
select is(public.service_authorize_process_output_cleanup('b1390000-0000-4000-8000-000000000052','b1390000-0000-4000-8000-000000000061','999'),false,'stale fence has no authority');
select is(public.service_settle_process_output_cleanup('b1390000-0000-4000-8000-000000000052','b1390000-0000-4000-8000-000000000061',
 (select plan->0->>'fence' from output_cleanup_claim),'pending','PROCESS_RESULT_UNCERTAIN'),'waiting','missing provider proof remains unknown');
update private.process_upload_ownership set attempts=24,next_attempt_at=clock_timestamp()-interval '1 second'
 where operation_id='b1390000-0000-4000-8000-000000000052';
select is(jsonb_array_length(public.service_claim_process_output_cleanup('b1390000-0000-4000-8000-000000000061',3)),0,'finite budget stops automatic claims');
select is((select cleanup_state||':'||last_code from private.process_upload_ownership where operation_id='b1390000-0000-4000-8000-000000000052'),
 'attention:PROCESS_RESULT_UNCERTAIN','exhaustion remains explicit attention');
select ok(exists(select 1 from public.analytics_workspace_operations where id='b1390000-0000-4000-8000-000000000052'
 and action='process_output_cleanup' and state='attention' and confirmed_count=0),'reader sees uncertainty without inventing confirmed cleanup');
select is_empty($$select column_name from information_schema.columns where table_schema='public'
 and table_name='analytics_process_output_cleanup' and column_name in('file_id','parent_id','root_id','credential_id','nonce','expected_name','checksum')$$,
 'diagnostic view excludes provider identity and content metadata');

insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,mime_type,category,size_bytes,checksum) values
 ('b1390000-0000-4000-8000-000000000011','b1390000-0000-4000-8000-000000000031','reserved-process-inflight','own-root','adopted.mp4','file','video/mp4','video',16,repeat('a',32));
-- pgTAP keeps this fixture in one transaction. Model the next RPC's snapshot
-- after the explicit publication commits; NULL means no visible revisions and
-- must not weaken the production snapshot fence merely to fit this fixture.
do $$begin perform private.upsert_catalog_snapshot('b1390000-0000-4000-8000-000000000031',null,
 jsonb_build_array(jsonb_build_object('drive_file_id','reserved-process-inflight','parent_folder_id','own-root',
 'name','adopted-renamed.mp4','kind','file','mime_type','video/mp4','category','video','size_bytes',16,'checksum',repeat('a',32))),
 format('%s:%s:',pg_current_xact_id()::text::bigint+1,pg_current_xact_id()::text::bigint+1)::pg_snapshot);end$$;
select is((select name from public.team_materials where team_id='b1390000-0000-4000-8000-000000000011' and drive_file_id='reserved-process-inflight'),
 'adopted-renamed.mp4','explicitly registered output retains catalog updates');

select * from finish();
rollback;
