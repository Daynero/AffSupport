begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(19);

insert into auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data) values
('bb370000-0000-4000-8000-000000000001','authenticated','authenticated','bulk-owner@example.test','{}','{}'),
('bb370000-0000-4000-8000-000000000002','authenticated','authenticated','bulk-outsider@example.test','{}','{}');
insert into public.admin_users(user_id) values ('bb370000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
('bb370000-0000-4000-8000-000000000010','Bulk trash','bb370000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
('bb370000-0000-4000-8000-000000000010','bb370000-0000-4000-8000-000000000001','admin');
insert into private.google_drive_credentials
  (id, connected_by, google_permission_id, google_account_email, vault_secret_id, scope) values
('bb370000-0000-4000-8000-000000000011','bb370000-0000-4000-8000-000000000001',
 'bulk-test','bulk-owner@example.test',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections
  (id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,initial_sync_state)
values ('bb370000-0000-4000-8000-000000000012','bb370000-0000-4000-8000-000000000010',
 'bb370000-0000-4000-8000-000000000011','bulk-root','Bulk root','my_drive','connected','ready');
insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind) values
('bb370000-0000-4000-8000-000000000021','bb370000-0000-4000-8000-000000000010',
 'bb370000-0000-4000-8000-000000000012','bulk-a','Secret A','file'),
('bb370000-0000-4000-8000-000000000022','bb370000-0000-4000-8000-000000000010',
 'bb370000-0000-4000-8000-000000000012','bulk-b','Secret B','file'),
('bb370000-0000-4000-8000-000000000023','bb370000-0000-4000-8000-000000000010',
 'bb370000-0000-4000-8000-000000000012','bulk-c','Secret C','file');

select set_config('request.jwt.claim.sub','bb370000-0000-4000-8000-000000000002',true);
select throws_ok($$select public.begin_team_bulk_trash(
 'bb370000-0000-4000-8000-000000000010','bb370000-0000-4000-8000-000000000031',
 array['bb370000-0000-4000-8000-000000000021']::uuid[])$$,
 '42501','PERMISSION_DENIED','outsider cannot start a group');
select throws_ok($$select public.list_team_bulk_trash('bb370000-0000-4000-8000-000000000010')$$,
 '42501','PERMISSION_DENIED','outsider cannot read group receipts');
select set_config('request.jwt.claim.sub','bb370000-0000-4000-8000-000000000001',true);
select throws_ok($$select public.begin_team_bulk_trash(
 'bb370000-0000-4000-8000-000000000010','bb370000-0000-4000-8000-000000000031',
 array['bb370000-0000-4000-8000-000000000021','bb370000-0000-4000-8000-000000000021']::uuid[])$$,
 '22023','INVALID_INPUT','duplicate item cannot make duplicate trash');
select throws_ok($$select public.begin_team_bulk_trash(
 'bb370000-0000-4000-8000-000000000010','bb370000-0000-4000-8000-000000000031',
 array['bb370000-0000-4000-8000-000000000099']::uuid[])$$,
 'P0002','NOT_FOUND','unknown material cannot enter group');
create temporary table bulk_receipt as
select public.begin_team_bulk_trash(
 'bb370000-0000-4000-8000-000000000010','bb370000-0000-4000-8000-000000000031',
 array['bb370000-0000-4000-8000-000000000021','bb370000-0000-4000-8000-000000000022',
 'bb370000-0000-4000-8000-000000000023']::uuid[]) as result;
select is((select jsonb_array_length(result->'items') from bulk_receipt),3,'all three items have stable keys');
select is((select public.begin_team_bulk_trash(
 'bb370000-0000-4000-8000-000000000010','bb370000-0000-4000-8000-000000000031',
 array['bb370000-0000-4000-8000-000000000021','bb370000-0000-4000-8000-000000000022',
 'bb370000-0000-4000-8000-000000000023']::uuid[])->>'id'),
 (select result->>'id' from bulk_receipt),'replay returns original group');
select throws_ok($$select public.begin_team_bulk_trash(
 'bb370000-0000-4000-8000-000000000010','bb370000-0000-4000-8000-000000000031',
 array['bb370000-0000-4000-8000-000000000021']::uuid[])$$,
 '22023','REQUEST_REUSE_CONFLICT','request key cannot change membership');
select is((select count(*) from public.team_catalog_events where event_kind='bulk_trash_changed'
 and team_id='bb370000-0000-4000-8000-000000000010'),1::bigint,
 'one content-free invalidation, including replay');
select is((public.list_team_bulk_trash('bb370000-0000-4000-8000-000000000010')->0->'items'->0->>'state'),
 'queued','without an operation the item is queued');
select public.mark_team_bulk_trash_attempt('bb370000-0000-4000-8000-000000000010',
 (select (result->>'id')::uuid from bulk_receipt),'bb370000-0000-4000-8000-000000000021');
select is((public.list_team_bulk_trash('bb370000-0000-4000-8000-000000000010')->0->'items'->0->>'state'),
 'unknown','a dispatched item with no operation receipt is unknown');

insert into public.team_operations
  (id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce,finished_at)
select 'bb370000-0000-4000-8000-000000000041', team_id,
 'bb370000-0000-4000-8000-000000000001','trash','succeeded',material_id,
 idempotency_key::text,'bulk-nonce-a',now()
from private.team_bulk_trash_items where material_id='bb370000-0000-4000-8000-000000000021';
select is((public.list_team_bulk_trash('bb370000-0000-4000-8000-000000000010')->0->'items'->0->>'state'),
 'unknown','operation success without trashed material is not confirmed');
update public.team_materials set lifecycle='trashed',trashed_at=now()
where id='bb370000-0000-4000-8000-000000000021';
select is((public.list_team_bulk_trash('bb370000-0000-4000-8000-000000000010')->0->'items'->0->>'state'),
 'confirmed','provider result and hosted lifecycle prove trash');
insert into public.team_operations
  (id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce,error_code,finished_at)
select 'bb370000-0000-4000-8000-000000000042', team_id,
 'bb370000-0000-4000-8000-000000000001','trash','failed',material_id,
 idempotency_key::text,'bulk-nonce-b','PROVIDER_FAILURE',now()
from private.team_bulk_trash_items where material_id='bb370000-0000-4000-8000-000000000022';
select is((public.list_team_bulk_trash('bb370000-0000-4000-8000-000000000010')->0->'items'->1->>'state'),
 'failed','one failed item does not hide confirmed siblings');
select is((select confirmed_count from public.analytics_bulk_trash_receipts
 where request_id='bb370000-0000-4000-8000-000000000031'),1,
 'read-only receipt confirms one item');
select ok(position('Secret A' in (select row_to_json(r)::text from public.analytics_bulk_trash_receipts r
 where request_id='bb370000-0000-4000-8000-000000000031'))=0,
 'analytics receipt contains no private names');
select ok(position('Secret A' in public.list_team_bulk_trash('bb370000-0000-4000-8000-000000000010')::text)=0,
 'receipt contains no names');
select is((public.prepare_team_bulk_trash_retry('bb370000-0000-4000-8000-000000000010',
 (select (result->>'id')::uuid from bulk_receipt),'bb370000-0000-4000-8000-000000000021')->>'status'),
 'confirmed','confirmed item cannot be retried');
select isnt((public.prepare_team_bulk_trash_retry('bb370000-0000-4000-8000-000000000010',
 (select (result->>'id')::uuid from bulk_receipt),'bb370000-0000-4000-8000-000000000022')->>'idempotencyKey'),
 (select idempotency_key::text from public.team_operations where id='bb370000-0000-4000-8000-000000000042'),
 'failed operation gets a new retry key');
select is((public.prepare_team_bulk_trash_retry('bb370000-0000-4000-8000-000000000010',
 (select (result->>'id')::uuid from bulk_receipt),'bb370000-0000-4000-8000-000000000023')->>'status'),
 'retryable','queued item can resume after a worker interruption');

select * from finish();
rollback;
