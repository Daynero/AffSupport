begin;
select plan(8);

insert into auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
values
  ('a0260000-0000-4000-8000-000000000001','authenticated','authenticated','live-owner@example.test','{}','{}'),
  ('a0260000-0000-4000-8000-000000000002','authenticated','authenticated','live-viewer@example.test','{}','{}'),
  ('a0260000-0000-4000-8000-000000000003','authenticated','authenticated','live-removed@example.test','{}','{}'),
  ('a0260000-0000-4000-8000-000000000004','authenticated','authenticated','live-outsider@example.test','{}','{}');
insert into public.teams(id,name,owner_id) values
  ('a0260000-0000-4000-8000-000000000011','Live A','a0260000-0000-4000-8000-000000000001'),
  ('a0260000-0000-4000-8000-000000000012','Live B','a0260000-0000-4000-8000-000000000001');
insert into public.admin_users(user_id) values ('a0260000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role,status,removed_at) values
  ('a0260000-0000-4000-8000-000000000011','a0260000-0000-4000-8000-000000000001','admin','active',null),
  ('a0260000-0000-4000-8000-000000000012','a0260000-0000-4000-8000-000000000001','admin','active',null),
  ('a0260000-0000-4000-8000-000000000011','a0260000-0000-4000-8000-000000000002','viewer','active',null),
  ('a0260000-0000-4000-8000-000000000011','a0260000-0000-4000-8000-000000000003','viewer','removed',now());
insert into public.team_catalog_events(team_id,event_kind,parent_folder_id) values
  ('a0260000-0000-4000-8000-000000000011','upserted','folder-a'),
  ('a0260000-0000-4000-8000-000000000012','upserted','folder-b');
insert into public.team_operations(team_id,actor_id,kind,idempotency_key,request_nonce) values
  ('a0260000-0000-4000-8000-000000000011','a0260000-0000-4000-8000-000000000001','move','live-a-operation','live-a-request'),
  ('a0260000-0000-4000-8000-000000000012','a0260000-0000-4000-8000-000000000001','move','live-b-operation','live-b-request');

set local role authenticated;
select set_config('request.jwt.claim.sub','a0260000-0000-4000-8000-000000000002',true);
select is((select count(*)::int from public.team_catalog_events),1,'viewer sees only own team catalog event');
select is((select parent_folder_id from public.team_catalog_events limit 1),'folder-a','viewer may read own scoped parent');
select is((select count(*)::int from public.team_operations),1,'viewer sees only own team operation');
select set_config('request.jwt.claim.sub','a0260000-0000-4000-8000-000000000003',true);
select is((select count(*)::int from public.team_catalog_events),0,'removed member sees no catalog event');
select is((select count(parent_folder_id)::int from public.team_catalog_events),0,'removed member sees no scoped parent');
select is((select count(*)::int from public.team_operations),0,'removed member sees no operation');
select set_config('request.jwt.claim.sub','a0260000-0000-4000-8000-000000000004',true);
select is((select count(*)::int from public.team_catalog_events),0,'foreign user sees no catalog event');
select is((select count(*)::int from public.team_operations),0,'foreign user sees no operation');
select * from finish();
rollback;
