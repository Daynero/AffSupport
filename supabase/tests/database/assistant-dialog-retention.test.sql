-- 064: «Діалоги зберігаються 7 днів» — an idle dialog is deleted with what it held; a dead
-- command is refunded first; money records stay.
begin;
select plan(5);

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data) values
  ('64800000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'retention-a@test.invalid', now(), '{}', '{}');
insert into public.teams (id, name, owner_id) values ('64800000-0000-4000-8000-0000000000a1', 'Synthetic retention', '64800000-0000-4000-8000-000000000001');
insert into private.assistant_conversations (id, user_id, team_id, last_active_at) values
  ('64800000-0000-4000-8000-0000000000c1', '64800000-0000-4000-8000-000000000001', '64800000-0000-4000-8000-0000000000a1', now() - interval '9 days'),
  ('64800000-0000-4000-8000-0000000000c2', '64800000-0000-4000-8000-000000000001', '64800000-0000-4000-8000-0000000000a1', now() - interval '6 days');
insert into private.assistant_commands (id, conversation_id, user_id, team_id, client_key, request_hash, kind, status, updated_at) values
  ('64800000-0000-4000-8000-0000000000f1', '64800000-0000-4000-8000-0000000000c1', '64800000-0000-4000-8000-000000000001',
   '64800000-0000-4000-8000-0000000000a1', 'retention-old-01', repeat('a', 64), 'message', 'executing', now() - interval '9 days'),
  ('64800000-0000-4000-8000-0000000000f2', '64800000-0000-4000-8000-0000000000c2', '64800000-0000-4000-8000-000000000001',
   '64800000-0000-4000-8000-0000000000a1', 'retention-new-01', repeat('b', 64), 'message', 'done', now() - interval '6 days');
insert into private.assistant_cards (id, conversation_id, command_id, kind, state, payload) values
  ('64800000-0000-4000-8000-0000000000d1', '64800000-0000-4000-8000-0000000000c1', '64800000-0000-4000-8000-0000000000f1', 'result', 'answered', '{}');

select is(private.prune_idle_assistant_dialogs(), 1, 'one dialog idle for more than a week goes');
select is((select count(*)::integer from private.assistant_conversations
  where id = '64800000-0000-4000-8000-0000000000c2'), 1, 'a six-day-old dialog stays');
select is((select count(*)::integer from private.assistant_cards
  where id = '64800000-0000-4000-8000-0000000000d1'), 0, 'its cards go with it');
select is((select count(*)::integer from private.assistant_commands
  where id = '64800000-0000-4000-8000-0000000000f1'), 0, 'its dead command was settled, then went too');
select is(private.prune_idle_assistant_dialogs(), 0, 'a second run has nothing to do');

select * from finish();
rollback;
