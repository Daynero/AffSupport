begin;
select plan(14);

-- Fixture: one space, an editor, two videos and the Launch dictionaries (as launch-multi-creative).
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('c0630000-0000-4000-8000-000000000001','authenticated','authenticated','label-owner@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('c0630000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
 ('c0630000-0000-4000-8000-000000000011','Creative label fixture','c0630000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('c0630000-0000-4000-8000-000000000011','c0630000-0000-4000-8000-000000000001','admin');
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('c0630000-0000-4000-8000-000000000021','c0630000-0000-4000-8000-000000000001','label-test','label-owner@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('c0630000-0000-4000-8000-000000000031','c0630000-0000-4000-8000-000000000011','c0630000-0000-4000-8000-000000000021','label-root','Root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version,checksum) values
 ('c0630000-0000-4000-8000-000000000041','c0630000-0000-4000-8000-000000000011','c0630000-0000-4000-8000-000000000031','label-v1','Ten.mp4','file','video','video/mp4','1','0123456789abcdef0123456789abcdef'),
 ('c0630000-0000-4000-8000-000000000042','c0630000-0000-4000-8000-000000000011','c0630000-0000-4000-8000-000000000031','label-v2','Thirteen.mp4','file','video','video/mp4','1','1123456789abcdef0123456789abcdef');

create function pg_temp.cfg(p_label jsonb default null) returns jsonb language sql as $$
 select jsonb_build_object('schemaVersion',1,
   'materialId','c0630000-0000-4000-8000-000000000041','creativeAlias','c10',
   'creativeKind','video','method','catalog',
   'creatives',jsonb_build_array(
     jsonb_build_object('materialId','c0630000-0000-4000-8000-000000000041','alias','c10','copies',2,'pinned',null),
     jsonb_build_object('materialId','c0630000-0000-4000-8000-000000000042','alias','c13','copies',2,'pinned',null)),
   'catalog',jsonb_build_object('productCount',4,'restitchEnabled',false,'catalogVideoProtocolVersion',1,'videoVariationCount',1))
   || case when p_label is null then '{}'::jsonb else jsonb_build_object('creativeLabel',p_label) end;
$$;
select set_config('request.jwt.claim.sub','c0630000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"c0630000-0000-4000-8000-000000000001","role":"authenticated"}',true);

-- The rule, at the draft boundary and at admission alike.
select is(private.launch_creatives_error(pg_temp.cfg()),null,'no name: the automatic one, as before');
select is(private.launch_creatives_error(pg_temp.cfg('"pak_1"')),null,'a typed name is accepted');
select is(private.launch_creatives_error(pg_temp.cfg('"10+13-pak"')),null,'«+» and «-» belong to the alphabet');
select is(private.launch_creatives_error(pg_temp.cfg('"pak 1"')),'LAUNCH_SUB_INVALID','a space is refused (the web writes «_»)');
select is(private.launch_creatives_error(pg_temp.cfg('"пак"')),'LAUNCH_SUB_INVALID','Cyrillic is refused (the web transliterates)');
select is(private.launch_creatives_error(pg_temp.cfg('""')),'LAUNCH_SUB_INVALID','an empty name is refused (absent means automatic)');
select is(private.launch_creatives_error(pg_temp.cfg(to_jsonb(repeat('a',81)))),'LAUNCH_SUB_INVALID','more than 80 characters is refused');
select is(private.launch_creatives_error(pg_temp.cfg('7')),'LAUNCH_SUB_INVALID','a number is refused');
select is(private.launch_creatives_error(pg_temp.cfg('"pak 1"'),true),'LAUNCH_SUB_INVALID','the draft check refuses it too');

-- The draft keeps it; a broken one never reaches the table.
select throws_ok($$select public.save_launch_draft('c0630000-0000-4000-8000-000000000011',null,null,'label-bad',pg_temp.cfg('"a b"'),null)$$,
  '22023','LAUNCH_SUB_INVALID','save_launch_draft refuses a broken name');
create temp table saved as
 select public.save_launch_draft('c0630000-0000-4000-8000-000000000011',null,null,'label-good',pg_temp.cfg('"pak_1"'),null) result;
select is((select draft_config->>'creativeLabel' from public.team_launches where id=(select (result->>'id')::uuid from saved)),'pak_1','the draft stores the name as typed');

-- The card and the search.
select is((select e->>'creativeLabel' from jsonb_array_elements(public.list_launches('c0630000-0000-4000-8000-000000000011','{}'::jsonb,50)->'items') e
  where e->>'id'=(select result->>'id' from saved)),'pak_1','the list carries the name for the card');
select is((select count(*)::int from jsonb_array_elements(public.list_launches('c0630000-0000-4000-8000-000000000011','{"search":"PAK_1"}'::jsonb,50)->'items') e
  where e->>'id'=(select result->>'id' from saved)),1,'the list search finds a Launch by its creatives name');
select is((select count(*)::int from jsonb_array_elements(public.list_launches('c0630000-0000-4000-8000-000000000011','{"search":"nothing-like-it"}'::jsonb,50)->'items') e),0,'and only by what it holds');

select * from finish();
rollback;
