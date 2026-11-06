begin;
select plan(9);
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('b1500000-0000-4000-8000-000000000001','authenticated','authenticated','overlap-native@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('b1500000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
 ('b1500000-0000-4000-8000-000000000011','Synthetic retry provenance','b1500000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('b1500000-0000-4000-8000-000000000011','b1500000-0000-4000-8000-000000000001','admin');
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('b1500000-0000-4000-8000-000000000021','b1500000-0000-4000-8000-000000000001','retry-synthetic','overlap-native@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('b1500000-0000-4000-8000-000000000031','b1500000-0000-4000-8000-000000000011','b1500000-0000-4000-8000-000000000021','retry-root','Synthetic root','my_drive','connected',now());

insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,mime_type,lifecycle,trashed_at)
select ('b1500000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
 'b1500000-0000-4000-8000-000000000011',
 'b1500000-0000-4000-8000-000000000031',
 'tied-' || n, 'retry-root', 'Synthetic ' || n, 'file', 'image/png',
 'trashed', '2026-11-06T10:00:00.000001Z'::timestamptz
from generate_series(100,159) n;
select set_config('request.jwt.claim.sub','b1500000-0000-4000-8000-000000000001',true);
create temporary table page_one as select * from public.list_team_trashed_materials_v2('b1500000-0000-4000-8000-000000000011',50);
select is((select count(*)::int from page_one),50,'first page is bounded');
select is((select min(trashed_at) from page_one),'2026-11-06T10:00:00.000001Z'::timestamptz,'cursor preserves microseconds');
update public.team_materials set lifecycle='active',trashed_at=null
where id=(select id from page_one order by id limit 1);
create temporary table page_two as select * from public.list_team_trashed_materials_v2(
 'b1500000-0000-4000-8000-000000000011',50,
 '2026-11-06T10:00:00.000001Z',(select id from page_one order by id limit 1));
select is((select count(*)::int from page_two),10,'deleted boundary does not lose the remaining tied rows');
select is((select count(distinct id)::int from (select id from page_one union all select id from page_two) s),60,'all tied identities are returned once');
select throws_ok($$select public.list_team_trashed_materials_v2('b1500000-0000-4000-8000-000000000011',50,now())$$,'22023','INVALID_INPUT','timestamp without identity is refused');
select throws_ok($$select public.list_team_trashed_materials_v2('b1500000-0000-4000-8000-000000000011',50,null,'b1500000-0000-4000-8000-000000000100')$$,'22023','INVALID_INPUT','identity without timestamp is refused');
select throws_ok($$select public.list_team_trashed_materials_v2('b1500000-0000-4000-8000-000000000011',50,'infinity','b1500000-0000-4000-8000-000000000100')$$,'22023','INVALID_INPUT','infinite timestamp is refused');
select ok(not has_function_privilege('anon','public.list_team_trashed_materials_v2(uuid,integer,timestamp with time zone,uuid)','execute'),'anonymous role cannot list private trash');
select set_config('request.jwt.claim.sub','b1500000-0000-4000-8000-000000000099',true);
select throws_ok($$select public.list_team_trashed_materials_v2('b1500000-0000-4000-8000-000000000011')$$,'42501','PERMISSION_DENIED','nonmember cannot inspect trash');
select * from finish();
rollback;
