begin;
select plan(9);

-- A launch is a draft from its first edit (25.11): whatever one field the editor holds
-- when the person clicks beside the dialog is saved; completeness is asked only by Generate.
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('d0250000-0000-4000-8000-000000000001','authenticated','authenticated','draft-owner@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('d0250000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
 ('d0250000-0000-4000-8000-000000000011','Partial draft fixture','d0250000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('d0250000-0000-4000-8000-000000000011','d0250000-0000-4000-8000-000000000001','admin');
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('d0250000-0000-4000-8000-000000000021','d0250000-0000-4000-8000-000000000001','draft-test','draft-owner@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('d0250000-0000-4000-8000-000000000031','d0250000-0000-4000-8000-000000000011','d0250000-0000-4000-8000-000000000021','draft-root','Root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version,checksum) values
 ('d0250000-0000-4000-8000-000000000041','d0250000-0000-4000-8000-000000000011','d0250000-0000-4000-8000-000000000031','draft-v1','Started.mp4','file','video','video/mp4','1','0123456789abcdef0123456789abcdef');
select set_config('request.jwt.claim.sub','d0250000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"d0250000-0000-4000-8000-000000000001","role":"authenticated"}',true);

-- Explorer's «Launch»: the creative and the blank form, nothing else chosen.
create temp table started as
 select public.save_launch_draft('d0250000-0000-4000-8000-000000000011',null,null,'draft-creative',
   jsonb_build_object('schemaVersion',1,'method','catalog','campaignCount',3,'adsCount',3,
     'materialId','d0250000-0000-4000-8000-000000000041'),null) result;
select is((select draft_config->>'materialId' from public.team_launches where id=(select (result->>'id')::uuid from started)),
  'd0250000-0000-4000-8000-000000000041','a draft with only its creative is saved');
select is((select draft_config ? 'creativeAlias' from public.team_launches where id=(select (result->>'id')::uuid from started)),
  false,'without the creative alias the generator needs');

-- One field changed on the blank form: no account, offer, buyer, creative or link.
create temp table touched as
 select public.save_launch_draft('d0250000-0000-4000-8000-000000000011',null,null,'draft-one-field',
   jsonb_build_object('schemaVersion',1,'gender','W'),null) result;
select is((select draft_config->>'gender' from public.team_launches where id=(select (result->>'id')::uuid from touched)),
  'W','a draft with one field is saved');
select is((select active_revision_id from public.team_launches where id=(select (result->>'id')::uuid from touched)),
  null,'and stays a draft: nothing was generated');
select is((select count(*)::int from jsonb_array_elements(public.list_launches('d0250000-0000-4000-8000-000000000011','{}'::jsonb,50)->'items') e
  where e->>'id' in ((select result->>'id' from started),(select result->>'id' from touched))),2,
  'both drafts are in the list to reopen');

-- The next edit of the same draft, and an edit from a stale tab.
create temp table edited as
 select public.save_launch_draft('d0250000-0000-4000-8000-000000000011',(select (result->>'id')::uuid from touched),
   (select result->>'version' from touched),'draft-edit',jsonb_build_object('schemaVersion',1,'gender','W','age',25),null) result;
select is((select result->>'id' from edited),(select result->>'id' from touched),'the next autosave edits the same draft');
select is((select draft_config->>'age' from public.team_launches where id=(select (result->>'id')::uuid from edited)),
  '25','with the new field');
select throws_ok(format($$select public.save_launch_draft('d0250000-0000-4000-8000-000000000011',%L::uuid,%L,'draft-stale',
   jsonb_build_object('schemaVersion',1,'gender','M'),null)$$,(select result->>'id' from touched),(select result->>'version' from touched)),
  'PT409','LAUNCH_VERSION_CONFLICT','a save against a version that moved is a conflict, not an overwrite');

-- A repeated autosave request (an unknown reply retried) is the same draft, not a second one.
select is((public.save_launch_draft('d0250000-0000-4000-8000-000000000011',null,null,'draft-one-field',
   jsonb_build_object('schemaVersion',1,'gender','W'),null))->>'id',(select result->>'id' from touched),
  'a retried first save replays its receipt instead of creating another draft');

select * from finish();
rollback;
