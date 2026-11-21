-- 064: bonus credits — given by an administrator, spent after the day's grant, returned to the
-- part they came from on a refund, taken back only up to what is unspent. Synthetic users only.
begin;
select plan(12);

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data) values
  ('64200000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'bonus-a@test.invalid', now(), '{}', '{}'),
  ('64200000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'bonus-admin@test.invalid', now(), '{}', '{}');
insert into public.admin_users (user_id) values ('64200000-0000-4000-8000-000000000003');
delete from private.ai_usage_events;
delete from private.ai_month_holds;
update private.ai_settings set base_daily_grant = 100, price_version = 'v1';
insert into private.ai_budget_months (month, limit_usd)
values (private.ai_month_of(private.kyiv_today()), 100)
on conflict (month) do update set limit_usd = 100;

-- A spends 99 of today's 100.
insert into private.ai_credit_ledger (user_id, op_key, kind, kyiv_day, feature, amount, price_version)
values ('64200000-0000-4000-8000-000000000001', 'transcript_translation:spent-99', 'debit',
  private.kyiv_today(), 'transcript_translation', 99, 'v1');

select set_config('request.jwt.claim.sub', '64200000-0000-4000-8000-000000000001', true);
select throws_ok($$select public.admin_ai_grant_bonus('bonus-a@test.invalid', 10, null)$$, 'PT409',
  'PERMISSION_DENIED', 'only an administrator gives bonus credits');

select set_config('request.jwt.claim.sub', '64200000-0000-4000-8000-000000000003', true);
select lives_ok($$select public.admin_ai_grant_bonus('bonus-a@test.invalid', 10, 'тест')$$, 'admin gives 10');
select is(private.ai_credits_snapshot('64200000-0000-4000-8000-000000000001') - 'day' - 'resetsAt' - 'paidOpen',
  '{"grant": 100, "daily": 1, "bonus": 10, "available": 11, "recent": []}'::jsonb,
  'the status shows daily and bonus apart, and no list of charges');

-- A charge of 3: 1 from today, 2 from the bonus.
select lives_ok($$select public.service_ai_credit_debit('64200000-0000-4000-8000-000000000001',
  'launch_assistant:bonus-op-1', 'launch_assistant', 3, 'v1', null, 0.002)$$, 'a charge larger than the day');
select is((select bonus_amount from private.ai_credit_ledger where op_key = 'launch_assistant:bonus-op-1'), 2,
  'the charge records the bonus part');
select is((private.ai_credits_snapshot('64200000-0000-4000-8000-000000000001') ->> 'bonus')::integer, 8,
  'bonus credits go after the day''s');
select throws_ok($$select public.service_ai_credit_debit('64200000-0000-4000-8000-000000000001',
  'launch_assistant:bonus-op-2', 'launch_assistant', 9, 'v1', null, 0.002)$$, 'PT409', 'INSUFFICIENT_CREDITS',
  'nothing beyond daily plus bonus');

select lives_ok($$select public.service_ai_credit_refund('64200000-0000-4000-8000-000000000001',
  'launch_assistant:bonus-op-1')$$, 'refund');
select is(private.ai_credits_snapshot('64200000-0000-4000-8000-000000000001') ->> 'available', '11',
  'a refund returns each part where it came from');

select throws_ok($$select public.admin_ai_grant_bonus('bonus-a@test.invalid', -11, null)$$, 'PT409',
  'INVALID_INPUT', 'no taking back more than is unspent');
select lives_ok($$select public.admin_ai_grant_bonus('bonus-a@test.invalid', -4, null)$$, 'taking back 4');
select is(public.admin_ai_budget_overview() -> 'bonuses',
  '[{"email": "bonus-a@test.invalid", "balance": 6}]'::jsonb, 'the overview lists what people hold');

select * from finish();
rollback;
