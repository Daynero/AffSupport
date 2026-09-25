begin;
select plan(7);

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
values ('b0410000-0000-4000-8000-000000000001','authenticated','authenticated',
  'folder-claim@example.test','{}','{}');
insert into public.teams(id,name,owner_id) values
  ('b0410000-0000-4000-8000-000000000011','Folder claim',
   'b0410000-0000-4000-8000-000000000001');
insert into public.admin_users(user_id) values
  ('b0410000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
  ('b0410000-0000-4000-8000-000000000011',
   'b0410000-0000-4000-8000-000000000001','admin');

select ok(not has_function_privilege('authenticated',
  'public.service_claim_upload_folder(uuid,uuid,text,uuid,text)', 'execute'),
  'browser callers cannot reserve folder creation');

select is((select claimed from public.service_claim_upload_folder(
  'b0410000-0000-4000-8000-000000000011',
  'b0410000-0000-4000-8000-000000000001', 'folder-request-0001', null, 'Assets')),
  true, 'first claimant owns the Drive creation');
select is((select claimed from public.service_claim_upload_folder(
  'b0410000-0000-4000-8000-000000000011',
  'b0410000-0000-4000-8000-000000000001', 'folder-request-0001', null, 'Assets')),
  false, 'same key reuses the reservation');
select is((select count(*)::integer from public.team_operations
  where team_id = 'b0410000-0000-4000-8000-000000000011'
    and kind = 'folder_create' and idempotency_key = 'folder-request-0001'),
  1, 'one operation row exists per request key');

select throws_ok($$
  select * from public.service_claim_upload_folder(
    'b0410000-0000-4000-8000-000000000011',
    'b0410000-0000-4000-8000-000000000001', 'folder-request-0001', null, 'Other')
$$, '22023', 'INVALID_INPUT', 'same key cannot bind a different name');
select throws_ok($$
  select * from public.service_claim_upload_folder(
    'b0410000-0000-4000-8000-000000000011',
    'b0410000-0000-4000-8000-000000000099', 'folder-request-0002', null, 'Assets')
$$, '42501', 'PERMISSION_DENIED', 'non-member cannot claim');
select throws_ok($$
  select * from public.service_claim_upload_folder(
    'b0410000-0000-4000-8000-000000000011',
    'b0410000-0000-4000-8000-000000000001', 'folder-request-0003',
    'b0410000-0000-4000-8000-000000000099', 'Assets')
$$, 'P0002', 'NOT_FOUND', 'unknown parent is rejected');

select * from finish();
rollback;
