-- 064 pre-release: an action card is claimed before it runs, settles with its counts, a failed
-- launch goes back to open, and a command that died after its debit is swept.
begin;
select plan(9);

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data) values
  ('64700000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'claim-a@test.invalid', now(), '{}', '{}'),
  ('64700000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'claim-b@test.invalid', now(), '{}', '{}'),
  ('64700000-0000-4000-8000-000000000009', 'authenticated', 'authenticated', 'claim-staff@test.invalid', now(), '{}', '{}');
insert into public.admin_users (user_id) values ('64700000-0000-4000-8000-000000000009');
insert into public.teams (id, name, owner_id) values ('64700000-0000-4000-8000-0000000000a1', 'Synthetic claims', '64700000-0000-4000-8000-000000000001');
insert into public.team_members (team_id, user_id, base_role, permission_overrides) values
  ('64700000-0000-4000-8000-0000000000a1', '64700000-0000-4000-8000-000000000001', 'admin', '{}'),
  ('64700000-0000-4000-8000-0000000000a1', '64700000-0000-4000-8000-000000000002', 'admin', '{}'),
  ('64700000-0000-4000-8000-0000000000a1', '64700000-0000-4000-8000-000000000009', 'viewer', '{}');
insert into private.assistant_conversations (id, user_id, team_id) values
  ('64700000-0000-4000-8000-0000000000c1', '64700000-0000-4000-8000-000000000001', '64700000-0000-4000-8000-0000000000a1');
insert into private.assistant_cards (id, conversation_id, kind, state, payload) values
  ('64700000-0000-4000-8000-0000000000d1', '64700000-0000-4000-8000-0000000000c1', 'review', 'open', '{"purpose":"tool","tool":"trash_catalogs","items":[]}'),
  ('64700000-0000-4000-8000-0000000000d2', '64700000-0000-4000-8000-0000000000c1', 'review', 'stale', '{"purpose":"tool","tool":"trash_catalogs","items":[]}'),
  ('64700000-0000-4000-8000-0000000000d3', '64700000-0000-4000-8000-0000000000c1', 'result', 'launched', '{"rows":[],"batchKey":"64700000-0000-4000-8000-0000000000e1"}');
insert into private.assistant_commands (id, conversation_id, user_id, team_id, client_key, request_hash, kind, status, updated_at) values
  ('64700000-0000-4000-8000-0000000000f1', '64700000-0000-4000-8000-0000000000c1', '64700000-0000-4000-8000-000000000001',
   '64700000-0000-4000-8000-0000000000a1', 'stuck-key-0001', repeat('a', 64), 'message', 'parsing', now() - interval '1 hour'),
  ('64700000-0000-4000-8000-0000000000f2', '64700000-0000-4000-8000-0000000000c1', '64700000-0000-4000-8000-000000000001',
   '64700000-0000-4000-8000-0000000000a1', 'fresh-key-0001', repeat('b', 64), 'message', 'parsing', now());

select set_config('request.jwt.claim.sub', '64700000-0000-4000-8000-000000000002', true);
set local role authenticated;
select throws_ok($$select public.assistant_card_claim('64700000-0000-4000-8000-0000000000d1')$$,
  'PT409', 'NOT_FOUND', 'nobody claims another person''s card');
reset role;

select set_config('request.jwt.claim.sub', '64700000-0000-4000-8000-000000000001', true);
set local role authenticated;
select is(public.assistant_card_claim('64700000-0000-4000-8000-0000000000d1') ->> 'state', 'confirmed',
  'the author claims an open card');
select throws_ok($$select public.assistant_card_claim('64700000-0000-4000-8000-0000000000d1')$$,
  'PT409', 'REVIEW_CHANGED', 'a second tab cannot claim it again');
select throws_ok($$select public.assistant_card_claim('64700000-0000-4000-8000-0000000000d2')$$,
  'PT409', 'REVIEW_CHANGED', 'a cancelled card cannot be run');
select is((public.assistant_card_finish('64700000-0000-4000-8000-0000000000d1', 'confirmed',
  '{"done":7,"failed":3,"evil":"x"}'::jsonb) -> 'payload') - 'purpose' - 'tool' - 'items',
  '{"done":7,"failed":3}'::jsonb, 'it settles with its counts and nothing else');
select is(public.assistant_card_finish('64700000-0000-4000-8000-0000000000d3', 'open', null) ->> 'state', 'open',
  'a launch whose batch failed goes back to open');
reset role;
select is((select payload ->> 'batchKey' from private.assistant_cards where id = '64700000-0000-4000-8000-0000000000d3'),
  '64700000-0000-4000-8000-0000000000e1', 'with its batch key kept for the retry');

select is(public.service_assistant_sweep_stuck('64700000-0000-4000-8000-000000000001'), 1,
  'one command died long enough ago to be swept');
select is((select string_agg(status, ',' order by id) from private.assistant_commands
  where id in ('64700000-0000-4000-8000-0000000000f1', '64700000-0000-4000-8000-0000000000f2')),
  'unknown,parsing', 'the old one is unknown, the running one is left alone');

select * from finish();
rollback;
