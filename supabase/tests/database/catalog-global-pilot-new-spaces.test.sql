-- A space created after the pilot list was written still draws pictures from the pool.
begin;
select plan(3);

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data) values
  ('64900000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'pool-new@test.invalid', now(), '{}', '{}');
insert into public.teams (id, name, owner_id)
values ('64900000-0000-4000-8000-0000000000a1', 'Synthetic new space', '64900000-0000-4000-8000-000000000001');

select ok(exists(select 1 from private.catalog_global_pilot_teams where team_id = '64900000-0000-4000-8000-0000000000a1'),
  'a new space joins the picture pool as it is created');
select lives_ok($$insert into private.catalog_global_pilot_teams (team_id) values ('64900000-0000-4000-8000-0000000000a1') on conflict (team_id) do nothing$$,
  'joining twice changes nothing');
select is((select count(*)::integer from public.teams t where not exists (select 1 from private.catalog_global_pilot_teams p where p.team_id = t.id)), 0,
  'no space is left outside the pool');

select * from finish();
rollback;
