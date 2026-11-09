begin;
select plan(8);
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
values ('b1630000-0000-4000-8000-000000000001','authenticated','authenticated','selection-ancestry@test.invalid','{}','{}');
insert into public.teams(id,name,owner_id)
values ('b1630000-0000-4000-8000-000000000011','Selection ancestry','b1630000-0000-4000-8000-000000000001');
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope)
values ('b1630000-0000-4000-8000-000000000021','b1630000-0000-4000-8000-000000000001','selection-ancestry','selection-ancestry@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)
values ('b1630000-0000-4000-8000-000000000031','b1630000-0000-4000-8000-000000000011','b1630000-0000-4000-8000-000000000021','ancestry-root','Root','my_drive','connected',now());
insert into public.team_drive_selections(id,team_id,connection_id,drive_folder_id,name)
values ('b1630000-0000-4000-8000-000000000051','b1630000-0000-4000-8000-000000000011','b1630000-0000-4000-8000-000000000031','ancestry-picked','Picked');
insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type)
values
('b1630000-0000-4000-8000-000000000011','b1630000-0000-4000-8000-000000000031','ancestry-picked','ancestry-root','Picked','folder',null,'application/vnd.google-apps.folder'),
('b1630000-0000-4000-8000-000000000011','b1630000-0000-4000-8000-000000000031','ancestry-child','ancestry-picked','Child','folder',null,'application/vnd.google-apps.folder');

select is(private.team_material_selection_for('b1630000-0000-4000-8000-000000000011','b1630000-0000-4000-8000-000000000031','ancestry-root'),
 (select id from public.team_drive_selections where connection_id='b1630000-0000-4000-8000-000000000031' and is_root),
 'a root child receives the direct root selection');
select is(private.team_material_selection_for('b1630000-0000-4000-8000-000000000011','b1630000-0000-4000-8000-000000000031','ancestry-picked'),
 'b1630000-0000-4000-8000-000000000051'::uuid,'the immediate picked folder beats its selected ancestor');
select is(private.team_material_selection_for('b1630000-0000-4000-8000-000000000011','b1630000-0000-4000-8000-000000000031','ancestry-child'),
 'b1630000-0000-4000-8000-000000000051'::uuid,'an unselected descendant resolves its nearest selected ancestor');
update public.team_drive_selections set state='removed',removed_at=now() where id='b1630000-0000-4000-8000-000000000051';
select is(private.team_material_selection_for('b1630000-0000-4000-8000-000000000011','b1630000-0000-4000-8000-000000000031','ancestry-picked'),
 (select id from public.team_drive_selections where connection_id='b1630000-0000-4000-8000-000000000031' and is_root),
 'a removed direct selection falls back to its selected ancestor');
update public.team_drive_selections set state='missing',removed_at=null where id='b1630000-0000-4000-8000-000000000051';
select is(private.team_material_selection_for('b1630000-0000-4000-8000-000000000011','b1630000-0000-4000-8000-000000000031','ancestry-picked'),
 'b1630000-0000-4000-8000-000000000051'::uuid,'a missing selection retains the existing eligibility semantics');
select is(private.team_material_selection_for('b1630000-0000-4000-8000-000000000011','b1630000-0000-4000-8000-000000000099','ancestry-picked'),
 null::uuid,'another connection cannot borrow a selection');
select is(private.team_material_selection_for('b1630000-0000-4000-8000-000000000011','b1630000-0000-4000-8000-000000000031',null),
 null::uuid,'an unknown parent does not invent a selection');
select ok(not has_function_privilege('anon','private.team_material_selection_for(uuid,uuid,text)','EXECUTE')
 and not has_function_privilege('authenticated','private.team_material_selection_for(uuid,uuid,text)','EXECUTE')
 and not has_function_privilege('service_role','private.team_material_selection_for(uuid,uuid,text)','EXECUTE'),
 'the internal lookup remains closed to application roles');
select * from finish();
rollback;
