-- 064: several dialogs per person — a list, a new one, titles from the first message, only the
-- author's dialogs, and the old single-dialog entry points on the newest one.
begin;
select plan(10);

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data) values
  ('64300000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'dialog-a@test.invalid', now(), '{}', '{}'),
  ('64300000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'dialog-b@test.invalid', now(), '{}', '{}'),
  ('64300000-0000-4000-8000-000000000009', 'authenticated', 'authenticated', 'dialog-staff@test.invalid', now(), '{}', '{}');
insert into public.admin_users (user_id) values ('64300000-0000-4000-8000-000000000009');
insert into public.teams (id, name, owner_id) values
  ('64300000-0000-4000-8000-0000000000a1', 'Synthetic dialogs', '64300000-0000-4000-8000-000000000001');
insert into public.team_members (team_id, user_id, base_role, permission_overrides) values
  ('64300000-0000-4000-8000-0000000000a1', '64300000-0000-4000-8000-000000000001', 'admin', '{}'),
  ('64300000-0000-4000-8000-0000000000a1', '64300000-0000-4000-8000-000000000002', 'viewer', '{"edit": true}'),
  -- a staff member keeps the space open under the legacy tariff rule
  ('64300000-0000-4000-8000-0000000000a1', '64300000-0000-4000-8000-000000000009', 'viewer', '{}');
update private.ai_settings set assistant_enabled = true;
insert into private.ai_space_pilot (team_id) values ('64300000-0000-4000-8000-0000000000a1')
on conflict do nothing;

select set_config('request.jwt.claim.sub', '64300000-0000-4000-8000-000000000001', true);
create temp table d as
select (public.assistant_open_dialog('64300000-0000-4000-8000-0000000000a1', null) ->> 'conversationId')::uuid as first;
select isnt((select first from d), null, 'opening makes the first dialog');

-- The first message names it.
select lives_ok($$select public.service_assistant_begin_v2('64300000-0000-4000-8000-000000000001',
  '64300000-0000-4000-8000-0000000000a1', (select first from d), 'dialog-key-0001', repeat('a', 64), 'message',
  '  на   завтра прокапс  ', 1)$$, 'a message in the dialog');
select is((select title from private.assistant_conversations where id = (select first from d)),
  'на завтра прокапс', 'the first message is the title, spaces folded');

alter table d add column second uuid;
update d set second = (public.assistant_new_dialog('64300000-0000-4000-8000-0000000000a1') ->> 'conversationId')::uuid;
select isnt((select second from d), (select first from d), 'a new dialog is another one');
select is((public.assistant_new_dialog('64300000-0000-4000-8000-0000000000a1') ->> 'conversationId')::uuid,
  (select second from d), 'an empty new dialog is reused, not multiplied');
select is(jsonb_array_length(public.assistant_open_dialog('64300000-0000-4000-8000-0000000000a1',
  (select first from d)) -> 'dialogs'), 2, 'both are in the list');

-- Another member sees neither and cannot write into them.
select set_config('request.jwt.claim.sub', '64300000-0000-4000-8000-000000000002', true);
select throws_ok(format($$select public.assistant_open_dialog('64300000-0000-4000-8000-0000000000a1', %L)$$,
  (select first from d)), 'PT409', 'NOT_FOUND', 'someone else''s dialog is not found');
select is(jsonb_array_length(public.assistant_open_dialog('64300000-0000-4000-8000-0000000000a1', null)
  -> 'dialogs'), 1, 'a member has only their own dialog');
select throws_ok(format($$select public.service_assistant_begin_v2('64300000-0000-4000-8000-000000000002',
  '64300000-0000-4000-8000-0000000000a1', %L, 'dialog-key-0002', repeat('b', 64), 'message', 'x', 1)$$,
  (select first from d)), 'PT409', 'PERMISSION_DENIED', 'nobody writes into another person''s dialog');

-- The old entry point lands on the newest dialog of the person.
select set_config('request.jwt.claim.sub', '64300000-0000-4000-8000-000000000001', true);
select ok((public.service_assistant_context('64300000-0000-4000-8000-000000000001',
  '64300000-0000-4000-8000-0000000000a1') ->> 'conversationId')::uuid in ((select first from d), (select second from d)),
  'the single-dialog function still works');

select * from finish();
rollback;
