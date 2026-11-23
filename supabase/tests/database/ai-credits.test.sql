-- 064: чарунки — the daily grant, the exact debit, refunds, the shared monthly hold and the
-- admin surface. Synthetic users only.
begin;
select plan(30);

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data) values
  ('64000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'credits-a@test.invalid', now(), '{}', '{}'),
  ('64000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'credits-b@test.invalid', now(), '{}', '{}'),
  ('64000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'credits-admin@test.invalid', now(), '{}', '{}');
insert into public.admin_users (user_id) values ('64000000-0000-4000-8000-000000000003');

-- A clean month for the test: no earlier cost, a known limit.
delete from private.ai_usage_events;
delete from private.ai_month_holds;
update private.ai_settings set base_daily_grant = 100, price_version = 'v1';
insert into private.ai_budget_months (month, limit_usd)
values (private.ai_month_of(private.kyiv_today()), 100)
on conflict (month) do update set limit_usd = 100;

-- Status of a fresh person: the whole base grant.
select set_config('request.jwt.claim.sub', '64000000-0000-4000-8000-000000000001', true);
select is((public.ai_credits_status() ->> 'available')::integer, 100, 'a fresh person has the base grant');
select is((public.ai_credits_status() ->> 'paidOpen')::boolean, true, 'the month is open');

-- Debit exactly the price.
select is(
  (public.service_ai_credit_debit('64000000-0000-4000-8000-000000000001', 'launch_assistant:op-00000001',
    'launch_assistant', 2, 'v1', null, 0.0018) -> 'credits' ->> 'available')::integer,
  98, 'debit takes exactly the shown price');
select is(
  (public.service_ai_credit_debit('64000000-0000-4000-8000-000000000001', 'launch_assistant:op-00000001',
    'launch_assistant', 2, 'v1', null, 0.0018) ->> 'replayed')::boolean,
  true, 'the same key and amount replays');
select is((select count(*) from private.ai_credit_ledger where op_key = 'launch_assistant:op-00000001'), 1::bigint,
  'a replay writes nothing');
select throws_ok(
  $$select public.service_ai_credit_debit('64000000-0000-4000-8000-000000000001', 'launch_assistant:op-00000001',
    'launch_assistant', 1, 'v1', null, 0.0018)$$,
  'PT409', 'KEY_REUSED', 'another amount under the same key is refused');
select throws_ok(
  $$select public.service_ai_credit_debit('64000000-0000-4000-8000-000000000001', 'launch_assistant:op-00000002',
    'launch_assistant', 1, 'v0', null, 0.0018)$$,
  'PT409', 'PRICE_CHANGED', 'a label priced by another version is refused');

-- Not enough credits: nothing is written, the reset time is told.
update private.ai_settings set base_daily_grant = 3;
select throws_ok(
  $$select public.service_ai_credit_debit('64000000-0000-4000-8000-000000000001', 'launch_assistant:op-00000003',
    'launch_assistant', 2, 'v1', null, 0.0018)$$,
  'PT409', 'INSUFFICIENT_CREDITS', 'three left minus two spent cannot pay two');
select is((select count(*) from private.ai_credit_ledger where op_key = 'launch_assistant:op-00000003'), 0::bigint,
  'a refused debit writes nothing');
select is((select count(*) from private.ai_month_holds where op_key = 'launch_assistant:op-00000003'), 0::bigint,
  'a refused debit holds nothing');
update private.ai_settings set base_daily_grant = 100;

-- Refund: back to the day it was taken, once.
select is((public.service_ai_credit_refund('64000000-0000-4000-8000-000000000001', 'launch_assistant:op-00000001')
  ->> 'available')::integer, 100, 'a refund gives the price back');
select is((public.service_ai_credit_refund('64000000-0000-4000-8000-000000000001', 'launch_assistant:op-00000001')
  ->> 'available')::integer, 100, 'a second refund changes nothing');
select is((select state from private.ai_month_holds where op_key = 'launch_assistant:op-00000001'), 'settled',
  'a refund settles the hold');
select is(
  (select kyiv_day from private.ai_credit_ledger where op_key = 'launch_assistant:op-00000001' and kind = 'refund'),
  (select kyiv_day from private.ai_credit_ledger where op_key = 'launch_assistant:op-00000001' and kind = 'debit'),
  'a refund belongs to the debit''s day');

-- The month: two people at the edge cannot both hold the last dollars.
update private.ai_budget_months set limit_usd = 0.01 where month = private.ai_month_of(private.kyiv_today());
insert into private.ai_usage_events (feature, user_id, model, outcome, cost_micro_usd, duration_ms)
values ('launch_assistant', '64000000-0000-4000-8000-000000000002', 'claude-haiku-5-5', 'completed', 7500, 10);
-- free = 0.01 - 0.0075 = 0.0025
select lives_ok(
  $$select public.service_ai_credit_debit('64000000-0000-4000-8000-000000000001', 'launch_assistant:op-00000004',
    'launch_assistant', 1, 'v1', '64000000-0000-4000-8000-0000000000a4', 0.0018)$$,
  'the first person at the edge holds the estimate');
select throws_ok(
  $$select public.service_ai_credit_debit('64000000-0000-4000-8000-000000000002', 'launch_assistant:op-00000005',
    'launch_assistant', 1, 'v1', null, 0.0018)$$,
  'PT409', 'AI_MONTH_EXHAUSTED', 'the second person cannot hold what is already held');
select is((select count(*) from private.ai_credit_ledger where op_key = 'launch_assistant:op-00000005'), 0::bigint,
  'a month refusal debits nothing');
-- The call ends cheaper than its estimate: the rest is free again.
insert into private.ai_usage_events (feature, user_id, subject_id, model, outcome, cost_micro_usd, duration_ms)
values ('launch_assistant', '64000000-0000-4000-8000-000000000001', '64000000-0000-4000-8000-0000000000a4',
  'claude-haiku-5-5', 'completed', 700, 10);
select is(round(private.ai_month_held_usd(private.ai_month_of(private.kyiv_today())), 6), 0.0011::numeric,
  'a running call is not counted twice');
select lives_ok($$select public.service_ai_credit_settle('launch_assistant:op-00000004')$$, 'settle');
select is((select usd_actual from private.ai_month_holds where op_key = 'launch_assistant:op-00000004'),
  0.0007::numeric, 'a settled hold keeps the real cost');
select lives_ok(
  $$select public.service_ai_credit_debit('64000000-0000-4000-8000-000000000002', 'launch_assistant:op-00000006',
    'launch_assistant', 1, 'v1', null, 0.0018)$$,
  'after settling, the second person fits');
select is((public.ai_credits_status() ->> 'paidOpen')::boolean, false, 'the status says the month is closed');

-- Administration.
update private.ai_budget_months set limit_usd = 100 where month = private.ai_month_of(private.kyiv_today());
select throws_ok($$select public.admin_ai_set_base_grant(150)$$, 'PT409', 'PERMISSION_DENIED',
  'a non-admin cannot change grants');
select set_config('request.jwt.claim.sub', '64000000-0000-4000-8000-000000000003', true);
-- Person A spends 40 today, then the admin raises A's grant 100 -> 150.
insert into private.ai_credit_ledger (user_id, op_key, kind, kyiv_day, feature, amount, price_version)
values ('64000000-0000-4000-8000-000000000001', 'transcript_translation:spent-40', 'debit',
  private.kyiv_today(), 'transcript_translation', 40, 'v1');
select lives_ok($$select public.admin_ai_set_user_grant('credits-a@test.invalid', 150)$$, 'admin sets a personal grant');
select is((private.ai_credits_snapshot('64000000-0000-4000-8000-000000000001') ->> 'available')::integer,
  150 - 40 - 1, 'a raise counts at once against what was spent today');
select throws_ok($$select public.admin_ai_set_month_limit(0.001)$$, 'PT409', 'BUDGET_BELOW_SPENT',
  'the month limit cannot go below what was spent');
select is((public.admin_ai_budget_overview() ->> 'limitUsd')::numeric, 100::numeric, 'overview reads the limit');
select is((select count(*) from private.ai_admin_events where kind = 'user_grant'), 1::bigint,
  'every admin change is journaled');

-- Roles: the browser reads only its own status.
select ok(not has_function_privilege('authenticated',
  'public.service_ai_credit_debit(uuid, text, text, integer, text, uuid, numeric)', 'execute'),
  'the browser cannot debit');
select ok(not has_table_privilege('authenticated', 'private.ai_credit_ledger', 'select'),
  'the browser cannot read the ledger');

select * from finish();
rollback;
