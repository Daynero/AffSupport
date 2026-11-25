begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(22);

-- 20261224340000: every space has a way out. A member leaves; an owner with people in the space
-- hands it over first; an owner alone deletes it, and the deletion releases what it held.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('c0710000-0000-4000-8000-000000000001','authenticated','authenticated','removal-solo@test.invalid','{}','{}'),
 ('c0710000-0000-4000-8000-000000000002','authenticated','authenticated','removal-lead@test.invalid','{}','{}'),
 ('c0710000-0000-4000-8000-000000000003','authenticated','authenticated','removal-member@test.invalid','{}','{}'),
 ('c0710000-0000-4000-8000-000000000004','authenticated','authenticated','removal-stranger@test.invalid','{}','{}');
-- The lead's space is open by its owner's admin role; the solo space by its tariff.
insert into public.admin_users(user_id) values('c0710000-0000-4000-8000-000000000002');
insert into public.teams(id,name,owner_id) values
 ('c0710000-0000-4000-8000-000000000011','Alone','c0710000-0000-4000-8000-000000000001'),
 ('c0710000-0000-4000-8000-000000000012','Shared','c0710000-0000-4000-8000-000000000002');
insert into public.team_members(team_id,user_id,base_role) values
 ('c0710000-0000-4000-8000-000000000011','c0710000-0000-4000-8000-000000000001','admin'),
 ('c0710000-0000-4000-8000-000000000012','c0710000-0000-4000-8000-000000000002','admin'),
 ('c0710000-0000-4000-8000-000000000012','c0710000-0000-4000-8000-000000000003','editor');
insert into public.space_tariffs(id,owner_email,owner_id,team_id,plan_code,ends_on) values
 ('c0710000-0000-4000-8000-000000000021','removal-solo@test.invalid','c0710000-0000-4000-8000-000000000001',
  'c0710000-0000-4000-8000-000000000011','solo',current_date + 30);
insert into public.team_invitations(id,team_id,target_email,initial_role,inviter_id,accept_token_hash,expires_at) values
 ('c0710000-0000-4000-8000-000000000031','c0710000-0000-4000-8000-000000000011','invitee@test.invalid','editor',
  'c0710000-0000-4000-8000-000000000001',decode(repeat('ab',32),'hex'),now() + interval '7 days');
insert into private.google_drive_credentials
 (id,google_permission_id,google_account_email,scope,vault_secret_id,connected_by)
values ('c0710000-0000-4000-8000-000000000041','removal-pgtap','removal-solo@test.invalid',
 'https://www.googleapis.com/auth/drive.file',gen_random_uuid(),'c0710000-0000-4000-8000-000000000001');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state)
values ('c0710000-0000-4000-8000-000000000042','c0710000-0000-4000-8000-000000000011',
 'c0710000-0000-4000-8000-000000000041','root','Матеріали','my_drive','needs_reauth');
insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind) values
 ('c0710000-0000-4000-8000-000000000051','c0710000-0000-4000-8000-000000000011',
  'c0710000-0000-4000-8000-000000000042','drive-video','video.mp4','file');
insert into private.catalog_video_r2_copies(id,team_id,source_material_id,source_version,object_key,state,size_bytes,part_bytes)
values ('c0710000-0000-4000-8000-000000000061','c0710000-0000-4000-8000-000000000011',
 'c0710000-0000-4000-8000-000000000051','v1','v/removal-pgtap.mp4','ready',1048576,5242880);

create function pg_temp.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

set local role authenticated;

-- Who may see what the deletion would take.
select pg_temp.as_user('c0710000-0000-4000-8000-000000000001');
select is(public.get_space_removal_preview('c0710000-0000-4000-8000-000000000011')->>'otherMembers', '0',
  'an owner alone sees nobody else in the space');
select is(public.get_space_removal_preview('c0710000-0000-4000-8000-000000000011')->>'files', '1',
  'the preview counts the files the space indexed');
select is(public.get_space_removal_preview('c0710000-0000-4000-8000-000000000011')->>'storedVideos', '1',
  'the preview counts catalog videos stored in R2');
select is(public.get_space_removal_preview('c0710000-0000-4000-8000-000000000011')->>'tariff', 'true',
  'the preview says a paid tariff is bound');
select is(public.get_space_removal_preview('c0710000-0000-4000-8000-000000000011')->>'driveFolder', 'Матеріали',
  'the preview names the Drive folder that stays');
select pg_temp.as_user('c0710000-0000-4000-8000-000000000003');
select is(public.get_space_removal_preview('c0710000-0000-4000-8000-000000000012'), '{"role":"editor"}'::jsonb,
  'a member learns only their role');
select pg_temp.as_user('c0710000-0000-4000-8000-000000000004');
select throws_ok($$select public.get_space_removal_preview('c0710000-0000-4000-8000-000000000011')$$,
  'P0002', 'NOT_FOUND', 'a stranger cannot tell the space exists');

-- Who may delete.
select throws_ok($$select * from public.delete_space('c0710000-0000-4000-8000-000000000011')$$,
  'P0002', 'NOT_FOUND', 'a stranger cannot delete a space');
select pg_temp.as_user('c0710000-0000-4000-8000-000000000003');
select throws_ok($$select * from public.delete_space('c0710000-0000-4000-8000-000000000012')$$,
  '42501', 'PERMISSION_DENIED', 'a member cannot delete the space they are in');
select pg_temp.as_user('c0710000-0000-4000-8000-000000000002');
select is(public.get_space_removal_preview('c0710000-0000-4000-8000-000000000012')->>'otherMembers', '1',
  'an owner with a member sees them');
select throws_ok($$select * from public.delete_space('c0710000-0000-4000-8000-000000000012')$$,
  '42501', 'OWNER_TRANSFER_REQUIRED', 'an owner with people in the space hands it over first');

-- The owner alone deletes.
select pg_temp.as_user('c0710000-0000-4000-8000-000000000001');
select ok((select ok from public.delete_space('c0710000-0000-4000-8000-000000000011')), 'an owner alone deletes the space');
select ok(not exists(select 1 from public.list_my_teams() where id = 'c0710000-0000-4000-8000-000000000011'),
  'the deleted space leaves the owner''s list');
select throws_ok($$select * from public.delete_space('c0710000-0000-4000-8000-000000000011')$$,
  'P0002', 'NOT_FOUND', 'a deleted space cannot be deleted again');

reset role;
select is((select status from public.teams where id = 'c0710000-0000-4000-8000-000000000011'), 'archived',
  'the space is archived, not torn out from under its retained history');
select is((select state from public.team_invitations where id = 'c0710000-0000-4000-8000-000000000031'), 'revoked',
  'a pending invitation to it is revoked');
select is((select team_id from public.space_tariffs where id = 'c0710000-0000-4000-8000-000000000021'), null::uuid,
  'the paid tariff is unbound, for the owner''s next space');
select is((select revoked_at from public.space_tariffs where id = 'c0710000-0000-4000-8000-000000000021'), null::timestamptz,
  'and it is not spent');
select is((select state from private.catalog_video_r2_copies where id = 'c0710000-0000-4000-8000-000000000061'), 'deleted',
  'the R2 video copy stops being live');
select is((select reason from private.catalog_video_r2_purges where object_key = 'v/removal-pgtap.mp4'), 'team_deleted',
  'and its object is queued for purging');
select is((select action from public.team_audit_events where team_id = 'c0710000-0000-4000-8000-000000000011'
  and action = 'team.deleted'), 'team.deleted', 'the deletion is in the space''s history');
select is((select count(*)::int from public.team_drive_connections where team_id = 'c0710000-0000-4000-8000-000000000011'), 1,
  'nothing about the Drive folder is touched');

select * from finish();
rollback;
