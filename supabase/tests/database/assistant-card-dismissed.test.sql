-- 064: «Не треба» — the author cancels an open action card; it stays cancelled, a done card
-- cannot be cancelled, and nobody cancels another person's card.
begin;
select plan(5);

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data) values
  ('64500000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'dismiss-a@test.invalid', now(), '{}', '{}'),
  ('64500000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'dismiss-b@test.invalid', now(), '{}', '{}'),
  ('64500000-0000-4000-8000-000000000009', 'authenticated', 'authenticated', 'dismiss-staff@test.invalid', now(), '{}', '{}');
insert into public.admin_users (user_id) values ('64500000-0000-4000-8000-000000000009');
insert into public.teams (id, name, owner_id) values
  ('64500000-0000-4000-8000-0000000000a1', 'Synthetic dismiss', '64500000-0000-4000-8000-000000000002');
insert into public.team_members (team_id, user_id, base_role, permission_overrides) values
  ('64500000-0000-4000-8000-0000000000a1', '64500000-0000-4000-8000-000000000001', 'viewer', '{}'),
  ('64500000-0000-4000-8000-0000000000a1', '64500000-0000-4000-8000-000000000002', 'admin', '{}'),
  -- a staff member keeps the space open under the legacy tariff rule
  ('64500000-0000-4000-8000-0000000000a1', '64500000-0000-4000-8000-000000000009', 'viewer', '{}');
insert into private.assistant_conversations (id, user_id, team_id) values
  ('64500000-0000-4000-8000-0000000000c1', '64500000-0000-4000-8000-000000000001', '64500000-0000-4000-8000-0000000000a1');
insert into private.assistant_cards (id, conversation_id, kind, state, payload) values
  ('64500000-0000-4000-8000-0000000000d1', '64500000-0000-4000-8000-0000000000c1', 'review', 'open', '{"purpose":"tool","tool":"rename_materials","items":[]}'),
  ('64500000-0000-4000-8000-0000000000d2', '64500000-0000-4000-8000-0000000000c1', 'review', 'confirmed', '{"purpose":"tool","tool":"trash_catalogs","items":[]}');

select set_config('request.jwt.claim.sub', '64500000-0000-4000-8000-000000000002', true);
set local role authenticated;
select throws_ok($$select public.assistant_card_dismissed('64500000-0000-4000-8000-0000000000d1')$$,
  'PT409', 'NOT_FOUND', 'nobody cancels another person''s card');
reset role;

select set_config('request.jwt.claim.sub', '64500000-0000-4000-8000-000000000001', true);
set local role authenticated;
select is(public.assistant_card_dismissed('64500000-0000-4000-8000-0000000000d1') ->> 'state', 'stale',
  'the author cancels an open card');
select is(public.assistant_card_dismissed('64500000-0000-4000-8000-0000000000d1') ->> 'state', 'stale',
  'a second press answers the same');
select throws_ok($$select public.assistant_card_dismissed('64500000-0000-4000-8000-0000000000d2')$$,
  'PT409', 'REVIEW_CHANGED', 'a done card is not cancelled');
select throws_ok($$select public.assistant_card_confirmed('64500000-0000-4000-8000-0000000000d1')$$,
  'PT409', 'REVIEW_CHANGED', 'a cancelled card is not confirmed afterwards');
reset role;

select * from finish();
rollback;
