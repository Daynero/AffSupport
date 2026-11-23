-- 064: the launch assistant's private state — who may open it, replay and key reuse, cards that
-- only their author can use, the review→batch tie, masked offer defaults, and roles.
begin;
select plan(25);

-- Two spaces with different owners; a member who may edit but not manage metadata; a stranger.
insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data) values
  ('64100000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'owner-a@test.invalid', now(), '{}', '{}'),
  ('64100000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'member-a@test.invalid', now(), '{}', '{}'),
  ('64100000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'owner-b@test.invalid', now(), '{}', '{}'),
  ('64100000-0000-4000-8000-000000000009', 'authenticated', 'authenticated', 'staff@test.invalid', now(), '{}', '{}');
insert into public.admin_users (user_id) values ('64100000-0000-4000-8000-000000000009');
insert into public.teams (id, name, owner_id) values
  ('64100000-0000-4000-8000-0000000000a1', 'Synthetic A', '64100000-0000-4000-8000-000000000001'),
  ('64100000-0000-4000-8000-0000000000b1', 'Synthetic B', '64100000-0000-4000-8000-000000000003');
insert into public.team_members (team_id, user_id, base_role, permission_overrides) values
  ('64100000-0000-4000-8000-0000000000a1', '64100000-0000-4000-8000-000000000001', 'admin', '{}'),
  ('64100000-0000-4000-8000-0000000000a1', '64100000-0000-4000-8000-000000000002', 'viewer', '{"edit": true}'),
  -- the staff member keeps both spaces open under the legacy rule
  ('64100000-0000-4000-8000-0000000000a1', '64100000-0000-4000-8000-000000000009', 'viewer', '{}'),
  ('64100000-0000-4000-8000-0000000000b1', '64100000-0000-4000-8000-000000000003', 'admin', '{}'),
  ('64100000-0000-4000-8000-0000000000b1', '64100000-0000-4000-8000-000000000009', 'viewer', '{}');

select ok(private.task_cleanup_coverage_verified(), 'every new jsonb table carries the cleanup fence');

-- Disabled until the switch is on and the space is in the pilot.
update private.ai_settings set assistant_enabled = false;
select set_config('request.jwt.claim.sub', '64100000-0000-4000-8000-000000000001', true);
select is((public.assistant_open('64100000-0000-4000-8000-0000000000a1') ->> 'enabled')::boolean, false,
  'off by default');
update private.ai_settings set assistant_enabled = true;
insert into private.ai_space_pilot (team_id) values ('64100000-0000-4000-8000-0000000000a1');
select is((public.assistant_open('64100000-0000-4000-8000-0000000000a1') ->> 'enabled')::boolean, true,
  'on for a pilot space');
select is((public.assistant_open('64100000-0000-4000-8000-0000000000a1') ->> 'canSaveDefaults')::boolean, true,
  'the owner may save defaults');
select throws_ok($$select public.assistant_open('64100000-0000-4000-8000-0000000000b1')$$, 'PT409',
  'PERMISSION_DENIED', 'a stranger cannot open another space''s assistant');
select set_config('request.jwt.claim.sub', '64100000-0000-4000-8000-000000000002', true);
select is((public.assistant_open('64100000-0000-4000-8000-0000000000a1') ->> 'canSaveDefaults')::boolean, false,
  'an editor without manage_metadata may not save defaults');

-- Service side (no caller JWT, as in the edge function).
select set_config('request.jwt.claim.sub', '', true);
select is((public.service_assistant_context('64100000-0000-4000-8000-000000000001',
  '64100000-0000-4000-8000-0000000000a1') ->> 'priceVersion'), 'v1', 'context carries the price version');
select throws_ok($$select public.service_assistant_context('64100000-0000-4000-8000-000000000003',
  '64100000-0000-4000-8000-0000000000a1')$$, 'PT409', 'PERMISSION_DENIED', 'the service still checks the person');
select throws_ok($$select public.service_assistant_context('64100000-0000-4000-8000-000000000003',
  '64100000-0000-4000-8000-0000000000b1')$$, 'PT409', 'ASSISTANT_DISABLED', 'a space outside the pilot is closed');

create temporary table t_cmd as
select (public.service_assistant_begin('64100000-0000-4000-8000-000000000001', '64100000-0000-4000-8000-0000000000a1',
  'client-key-0001', repeat('a', 64), 'message', '5 запусків ProCaps на G2', 1) ->> 'commandId')::uuid as id;
select is((public.service_assistant_begin('64100000-0000-4000-8000-000000000001', '64100000-0000-4000-8000-0000000000a1',
  'client-key-0001', repeat('a', 64), 'message', '5 запусків ProCaps на G2', 1) ->> 'replayed')::boolean, true,
  'the same key and request replays');
select throws_ok($$select public.service_assistant_begin('64100000-0000-4000-8000-000000000001',
  '64100000-0000-4000-8000-0000000000a1', 'client-key-0001', repeat('b', 64), 'message', 'інше', 1)$$,
  'PT409', 'KEY_REUSED', 'the same key with another request is refused');
select is((select count(*) from private.assistant_messages m join t_cmd on m.command_id = t_cmd.id where m.role = 'user'),
  1::bigint, 'one user message for one command');

-- Cards belong to their author only.
create temporary table t_reply as
select public.service_assistant_reply((select id from t_cmd), 'Готово', jsonb_build_array(
  jsonb_build_object('kind', 'review', 'payload', jsonb_build_object('rows', jsonb_build_array())))) as message;
create temporary table t_card as select ((select message from t_reply) -> 'cards' -> 0 ->> 'id')::uuid as id;
select isnt(public.service_assistant_card('64100000-0000-4000-8000-000000000001',
  '64100000-0000-4000-8000-0000000000a1', (select id from t_card)), null, 'the author reads the card');
select is(public.service_assistant_card('64100000-0000-4000-8000-000000000002',
  '64100000-0000-4000-8000-0000000000a1', (select id from t_card)), null, 'another member does not');
select is(public.service_assistant_card('64100000-0000-4000-8000-000000000001',
  '64100000-0000-4000-8000-0000000000b1', (select id from t_card)), null, 'nor the author in another space');

-- «Запустити N» ties the card to one batch key.
select set_config('request.jwt.claim.sub', '64100000-0000-4000-8000-000000000002', true);
select throws_ok(format($$select public.assistant_review_launched(%L, '64100000-0000-4000-8000-00000000c001')$$,
  (select id from t_card)), 'PT409', 'NOT_FOUND', 'another member cannot press the author''s card');
select set_config('request.jwt.claim.sub', '64100000-0000-4000-8000-000000000001', true);
select is((public.assistant_review_launched((select id from t_card), '64100000-0000-4000-8000-00000000c001')
  ->> 'state'), 'launched', 'the author launches the reviewed rows');
select is((public.assistant_review_launched((select id from t_card), '64100000-0000-4000-8000-00000000c001')
  ->> 'state'), 'launched', 'pressing again replays');
select throws_ok(format($$select public.assistant_review_launched(%L, '64100000-0000-4000-8000-00000000c002')$$,
  (select id from t_card)), 'PT409', 'KEY_REUSED', 'another batch for the same card is refused');

-- Masked offer defaults: only the named field changes; another field edited meanwhile survives.
insert into public.team_launch_offers (id, team_id, name, normalized_key, created_by) values
  ('64100000-0000-4000-8000-0000000000f1', '64100000-0000-4000-8000-0000000000a1', 'ProCaps', 'procaps',
   '64100000-0000-4000-8000-000000000001');
insert into public.team_launch_offer_defaults (team_id, offer_id, config, updated_by) values
  ('64100000-0000-4000-8000-0000000000a1', '64100000-0000-4000-8000-0000000000f1',
   '{"maxBudget": 40, "campaignCount": 2, "catalog": {"productCount": 60, "restitchEnabled": false, "finalDurationMode": "random-30-40", "customFinalDurationSeconds": null}}',
   '64100000-0000-4000-8000-000000000001');
-- Someone raises the budget in the form after the assistant read the profile.
update public.team_launch_offer_defaults set config = jsonb_set(config, '{maxBudget}', '50'), version = version + 1
where offer_id = '64100000-0000-4000-8000-0000000000f1';
select lives_ok($$select public.save_launch_offer_defaults_masked('64100000-0000-4000-8000-0000000000a1',
  '64100000-0000-4000-8000-0000000000f1', array['catalog.productCount'], '{"catalog.productCount": 60}',
  '{"catalog.productCount": 100}', 'masked-key-0001')$$, 'saving one field by mask');
select is((select config -> 'catalog' ->> 'productCount' from public.team_launch_offer_defaults
  where offer_id = '64100000-0000-4000-8000-0000000000f1'), '100', 'the named field changed');
select is((select config ->> 'maxBudget' from public.team_launch_offer_defaults
  where offer_id = '64100000-0000-4000-8000-0000000000f1'), '50', 'the parallel edit of another field survived');
select throws_ok($$select public.save_launch_offer_defaults_masked('64100000-0000-4000-8000-0000000000a1',
  '64100000-0000-4000-8000-0000000000f1', array['maxBudget'], '{"maxBudget": 40}', '{"maxBudget": 20}',
  'masked-key-0002')$$, 'PT409', 'EDIT_CONFLICT', 'a field changed since it was read is a conflict');
select set_config('request.jwt.claim.sub', '64100000-0000-4000-8000-000000000002', true);
select throws_ok($$select public.save_launch_offer_defaults_masked('64100000-0000-4000-8000-0000000000a1',
  '64100000-0000-4000-8000-0000000000f1', array['campaignCount'], '{"campaignCount": 2}', '{"campaignCount": 5}',
  'masked-key-0003')$$, '42501', 'PERMISSION_DENIED', 'without manage_metadata the profile stays');

select ok(not has_function_privilege('authenticated',
  'public.service_assistant_begin(uuid, uuid, text, text, text, text, integer)', 'execute'),
  'the browser cannot start a command as someone else');

select * from finish();
rollback;
