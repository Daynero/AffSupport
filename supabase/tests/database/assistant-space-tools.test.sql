-- 064: the space tools' cards — a table answer is stored; a tool card is remembered as done by its
-- own author with only «view» (the action it performed checked its own right); other cards still
-- need «edit», and nobody confirms someone else's card.
begin;
select plan(6);

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data) values
  ('64400000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'tools-a@test.invalid', now(), '{}', '{}'),
  ('64400000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'tools-b@test.invalid', now(), '{}', '{}'),
  ('64400000-0000-4000-8000-000000000009', 'authenticated', 'authenticated', 'tools-staff@test.invalid', now(), '{}', '{}');
insert into public.admin_users (user_id) values ('64400000-0000-4000-8000-000000000009');
insert into public.teams (id, name, owner_id) values
  ('64400000-0000-4000-8000-0000000000a1', 'Synthetic tools', '64400000-0000-4000-8000-000000000002');
insert into public.team_members (team_id, user_id, base_role, permission_overrides) values
  ('64400000-0000-4000-8000-0000000000a1', '64400000-0000-4000-8000-000000000001', 'viewer', '{}'),
  ('64400000-0000-4000-8000-0000000000a1', '64400000-0000-4000-8000-000000000002', 'admin', '{}'),
  -- a staff member keeps the space open under the legacy tariff rule
  ('64400000-0000-4000-8000-0000000000a1', '64400000-0000-4000-8000-000000000009', 'viewer', '{}');
insert into private.assistant_conversations (id, user_id, team_id) values
  ('64400000-0000-4000-8000-0000000000c1', '64400000-0000-4000-8000-000000000001', '64400000-0000-4000-8000-0000000000a1');
insert into private.assistant_cards (id, conversation_id, kind, payload) values
  ('64400000-0000-4000-8000-0000000000d1', '64400000-0000-4000-8000-0000000000c1', 'review', '{"purpose":"tool","tool":"invite_members","items":[]}'),
  ('64400000-0000-4000-8000-0000000000d2', '64400000-0000-4000-8000-0000000000c1', 'review', '{"purpose":"archive","rows":[]}');

select lives_ok($$insert into private.assistant_cards (conversation_id, kind, payload)
  values ('64400000-0000-4000-8000-0000000000c1', 'table', '{"tool":"finance_report","rows":[]}')$$,
  'a table answer is a card kind');
select throws_ok($$insert into private.assistant_cards (conversation_id, kind, payload)
  values ('64400000-0000-4000-8000-0000000000c1', 'nonsense', '{}')$$, '23514', null,
  'an unknown kind is still refused');

select set_config('request.jwt.claim.sub', '64400000-0000-4000-8000-000000000001', true);
set local role authenticated;
select is(public.assistant_card_confirmed('64400000-0000-4000-8000-0000000000d1') ->> 'state', 'confirmed',
  'the author remembers a tool card as done with view only');
select is(public.assistant_card_confirmed('64400000-0000-4000-8000-0000000000d1') ->> 'state', 'confirmed',
  'a second press answers the same');
select throws_ok($$select public.assistant_card_confirmed('64400000-0000-4000-8000-0000000000d2')$$,
  'PT409', 'NOT_FOUND', 'a removal card still needs edit');
reset role;

select set_config('request.jwt.claim.sub', '64400000-0000-4000-8000-000000000002', true);
set local role authenticated;
select throws_ok($$select public.assistant_card_confirmed('64400000-0000-4000-8000-0000000000d1')$$,
  'PT409', 'NOT_FOUND', 'nobody confirms another person''s card, not even an admin');
reset role;

select * from finish();
rollback;
