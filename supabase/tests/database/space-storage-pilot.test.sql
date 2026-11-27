begin;
select plan(31);

-- 057 T013: the R2 pilot permit and creating a space on R2 (20261226110000, 20261226130000).
-- The admin RPCs are for administrators only and leave an audit row. A pilot creates a space
-- with its root folder; the same key returns the same space. Removing the permit never deletes
-- the space. An invited member without the permit does not open it.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05713000-0000-4000-8000-000000000001','authenticated','authenticated','pilot@test.invalid','{}','{}'),
 ('05713000-0000-4000-8000-000000000002','authenticated','authenticated','plain@test.invalid','{}','{}'),
 ('05713000-0000-4000-8000-000000000003','authenticated','authenticated','admin@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('05713000-0000-4000-8000-000000000003');

create temporary table seen(label text, value jsonb);
grant all on seen to authenticated;
-- A service call carries no user: auth.uid() is null, as it is for the edge function.
create function pg_temp.as_service() returns void language sql as $$
  select set_config('request.jwt.claim.sub','',true), set_config('request.jwt.claims','',true);
$$;

-- 1. Admin RPCs ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub','05713000-0000-4000-8000-000000000002',true);
select throws_ok($$select public.admin_add_storage_r2_pilot('pilot@test.invalid',1000)$$,'42501',null,
 'a person who is not an administrator cannot grant the permit');
select throws_ok($$select * from public.admin_list_storage_r2_pilots()$$,'42501',null,'nor list who has it');
select throws_ok($$select public.admin_remove_storage_r2_pilot('05713000-0000-4000-8000-000000000001')$$,'42501',null,
 'nor take it away');
select is(public.is_storage_r2_pilot(),false,'and has no permit of their own');

select set_config('request.jwt.claim.sub','05713000-0000-4000-8000-000000000003',true);
select throws_ok($$select public.admin_add_storage_r2_pilot('nobody@test.invalid',1000)$$,'P0002','STORAGE_R2_PILOT_UNKNOWN_EMAIL',
 'an unknown address is named as such');
select throws_ok($$select public.admin_add_storage_r2_pilot('pilot@test.invalid',0)$$,'22023','INVALID_INPUT',
 'a zero limit is refused');
select is(public.admin_add_storage_r2_pilot(' PILOT@test.invalid ',5000000000),'05713000-0000-4000-8000-000000000001'::uuid,
 'the administrator grants it by email, whatever the case');
select is((select max_space_bytes from public.admin_list_storage_r2_pilots() where user_id='05713000-0000-4000-8000-000000000001'),
 '5000000000','the list shows the limit as decimal text');
select is(public.admin_add_storage_r2_pilot('pilot@test.invalid',7000000000),'05713000-0000-4000-8000-000000000001'::uuid,
 'granting again changes the limit');
reset role;
select pg_temp.as_service();
select is((select array_agg(action||':'||coalesce(max_space_bytes::text,'-')||':'||actor_id::text order by id)
  from private.storage_r2_pilot_events where user_id='05713000-0000-4000-8000-000000000001'),
 array['add:5000000000:05713000-0000-4000-8000-000000000003','update:7000000000:05713000-0000-4000-8000-000000000003'],
 'each grant is audited with who did it');

-- 2. Creating a space on R2 ---------------------------------------------------------------
select throws_ok($$select public.service_create_r2_space('05713000-0000-4000-8000-000000000002','Plain','plain-key-0000000001')$$,
 '42501','R2_PILOT_REQUIRED','a person without the permit cannot create an R2 space');
select throws_ok($$select public.service_create_r2_space('05713000-0000-4000-8000-000000000001','Pilot','short')$$,
 '22023','INVALID_INPUT','a malformed idempotency key is refused');
select throws_ok($$select public.service_create_r2_space('05713000-0000-4000-8000-000000000001','   ','pilot-key-0000000001')$$,
 '22023','INVALID_INPUT','a blank name is refused');
insert into seen select 'created', public.service_create_r2_space('05713000-0000-4000-8000-000000000001','  Pilot   space ','pilot-key-0000000001');
select is((select value->>'name' from seen where label='created'),'Pilot space','the name is normalized');
select is((select storage_backend||':'||storage_pilot||':'||owner_id::text from public.teams where id=(select (value->>'teamId')::uuid from seen where label='created')),
 'r2:true:05713000-0000-4000-8000-000000000001','the space is R2, marked as a pilot space and owned by its creator');
select is((select connection_id is null and drive_file_id is null and parent_folder_id is null and kind='folder' and name='Pilot space'
  from public.team_materials where id=(select (value->>'rootMaterialId')::uuid from seen where label='created')),true,
 'its root folder is an R2 folder without a parent');
select is((select storage_root_material_id::text from public.teams where id=(select (value->>'teamId')::uuid from seen where label='created')),
 (select value->>'rootMaterialId' from seen where label='created'),'and the space names it as its root');
select is((select base_role from public.team_members where team_id=(select (value->>'teamId')::uuid from seen where label='created')
  and user_id='05713000-0000-4000-8000-000000000001'),'admin','the creator is an active member');
select is((select value->>'role'||':'||(value->'permissions'->>'upload')||':'||(value->>'connectionState') from seen where label='created'),
 'owner:true:none','the snapshot says owner, with rights and no Drive connection');
insert into seen select 'again', public.service_create_r2_space('05713000-0000-4000-8000-000000000001','Another name','pilot-key-0000000001');
select is((select value->>'teamId' from seen where label='again'),(select value->>'teamId' from seen where label='created'),
 'the same key returns the same space, even with another name');
select is((select count(*)::int from public.teams where owner_id='05713000-0000-4000-8000-000000000001'),1,'and no second space');
select is((select count(*)::int from public.team_materials where team_id=(select (value->>'teamId')::uuid from seen where label='created')),1,
 'nor a second root');
select throws_ok($$select public.service_create_r2_space('05713000-0000-4000-8000-000000000001','pilot SPACE','pilot-key-0000000002')$$,
 '23505','NAME_CONFLICT','a new key with a name the person already has is a name conflict');
select is((select count(*)::int from public.team_audit_events where team_id=(select (value->>'teamId')::uuid from seen where label='created')
  and action='team.created'),1,'the creation is in the space audit once');

set local role authenticated;
select set_config('request.jwt.claim.sub','05713000-0000-4000-8000-000000000001',true);
select throws_ok($$select public.service_create_r2_space('05713000-0000-4000-8000-000000000001','Direct','pilot-key-0000000003')$$,
 '42501',null,'a browser cannot call the service function directly');
select is((select storage_backend from public.list_my_teams_v2() where id=(select (value->>'teamId')::uuid from seen where label='created')),
 'r2','the pilot sees the new space in the v2 list');
reset role;
select pg_temp.as_service();

-- 3. An invited member without the permit ---------------------------------------------------
insert into public.team_members(team_id,user_id,base_role)
 select (value->>'teamId')::uuid,'05713000-0000-4000-8000-000000000002','editor' from seen where label='created';
select is((select (ctx->>'member')||':'||(ctx->>'actorPilot')||':'||(ctx->>'storageBackend')
  from (select public.service_space_storage_context((value->>'teamId')::uuid,'05713000-0000-4000-8000-000000000002','upload') ctx
        from seen where label='created') c),
 'true:false:r2','the request context names a member who is not a pilot, so the function can refuse them');
set local role authenticated;
select set_config('request.jwt.claim.sub','05713000-0000-4000-8000-000000000002',true);
select is((select count(*)::int from public.list_my_teams_v2() where storage_backend='r2'),0,
 'an invited member without the permit does not see the space');
reset role;

-- 4. Taking the permit away -----------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub','05713000-0000-4000-8000-000000000003',true);
select is(public.admin_remove_storage_r2_pilot('05713000-0000-4000-8000-000000000001'),true,'the administrator removes the permit');
reset role;
select pg_temp.as_service();
select is((select status||':'||storage_backend from public.teams where id=(select (value->>'teamId')::uuid from seen where label='created')),
 'active:r2','removing the permit does not delete or close the space');
select is((select count(*)::int from private.storage_r2_pilot_events where user_id='05713000-0000-4000-8000-000000000001' and action='remove'),1,
 'and the removal is audited');

select * from finish();
rollback;
