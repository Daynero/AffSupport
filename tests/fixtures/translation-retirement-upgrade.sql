-- Synthetic fixture, loaded only on the owned disposable previous-schema clone.
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
values('81000000-0000-4000-8000-000000000001','authenticated','authenticated','retirement@test.invalid','{}','{}') on conflict (id) do nothing;
insert into public.admin_users(user_id) values('81000000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id)
values('81000000-0000-4000-8000-000000000002','Synthetic retirement','81000000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role)
values('81000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000001','admin');
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope)
values('81000000-0000-4000-8000-000000000003','81000000-0000-4000-8000-000000000001','synthetic','retirement@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)
values('81000000-0000-4000-8000-000000000004','81000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000003','synthetic-root','Synthetic','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,mime_type,drive_version)
values
('81000000-0000-4000-8000-000000000005','81000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000004','synthetic-source','source.mp4','file','video/mp4','v1'),
('81000000-0000-4000-8000-000000000006','81000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000004','synthetic-text','text.txt','file','text/plain','v1');
insert into public.team_library_requirements(id,team_id,source_material_id,source_version,kind,variant,state)
values('81000000-0000-4000-8000-000000000007','81000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000005','v1','translation','uk','running');
insert into private.team_library_attempts(id,requirement_id,team_id,actor_id,agent_instance_id,state,lease_token_hash,lease_expires_at)
values('81000000-0000-4000-8000-000000000008','81000000-0000-4000-8000-000000000007','81000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000011','running',extensions.digest(repeat('a',64),'sha256'),now()+interval '1 hour');
insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)
values('81000000-0000-4000-8000-000000000009','81000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000001','process','running','81000000-0000-4000-8000-000000000005','synthetic-retired-operation','synthetic-retired-nonce');
insert into private.team_operation_intents(operation_id,team_id,expected_name,mime_type,expected_size,tool_id,tool_contract_version)
values('81000000-0000-4000-8000-000000000009','81000000-0000-4000-8000-000000000002','synthetic.txt','text/plain',16,'translation',5);
insert into private.team_transfer_grants(token_hash,operation_id,team_id,actor_id,purpose,tool_id,max_range_bytes,expires_at,max_uses)
values(extensions.digest(repeat('b',64),'sha256'),'81000000-0000-4000-8000-000000000009','81000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000001','finalize','translation',2097152,now()+interval '1 hour',4);

update public.team_materials set category='transcript' where id='81000000-0000-4000-8000-000000000006';
update public.team_materials set category='video' where id='81000000-0000-4000-8000-000000000005';

-- Legacy nonterminal and inert states, plus active work in the same bulk-retry scope.
insert into public.team_library_requirements(team_id,source_material_id,source_version,kind,variant,state)
select '81000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000005','v1','translation','uk-'||state,state
from unnest(array['pending','leased','failed','stale','canceled','skipped']) state;
insert into public.team_library_requirements(team_id,source_material_id,source_version,kind,variant,state)
values('81000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000005','v1','transcription','original','failed');
insert into private.team_transfer_grants(token_hash,operation_id,team_id,actor_id,purpose,tool_id,max_range_bytes,expires_at,max_uses)
values(extensions.digest(repeat('c',64),'sha256'),'81000000-0000-4000-8000-000000000009','81000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000001','process_input',null,2097152,now()+interval '1 hour',4);
insert into private.team_library_attempts(id,requirement_id,team_id,actor_id,agent_instance_id,state,lease_token_hash,lease_expires_at)
select '81000000-0000-4000-8000-000000000012',id,team_id,'81000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000011','leased',extensions.digest(repeat('d',64),'sha256'),now()+interval '1 hour'
from public.team_library_requirements where variant='uk-leased';
insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)
values('81000000-0000-4000-8000-000000000014','81000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000001','process','pending','81000000-0000-4000-8000-000000000005','synthetic-pending','synthetic-pending-nonce');
insert into private.team_operation_intents(operation_id,team_id,expected_name,mime_type,expected_size,tool_id,tool_contract_version)
values('81000000-0000-4000-8000-000000000014','81000000-0000-4000-8000-000000000002','pending.txt','text/plain',16,'translation',5);
