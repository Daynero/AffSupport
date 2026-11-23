-- 064: bonus credits. Beside the daily grant that renews at Kyiv midnight, a person can hold
-- bonus credits an administrator gave them: they do not expire and are spent only after the day's
-- grant runs out. A charge records how much of it came from the bonus, so a refund returns each
-- part where it came from. The snapshot a person sees says both: daily left and bonus held; it
-- no longer lists recent charges (a growing list nobody used).

create table private.ai_credit_bonuses (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Negative: unspent bonus an administrator took back.
  amount integer not null check (amount <> 0 and abs(amount) <= 1000000),
  note text check (note is null or char_length(note) <= 200),
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index ai_credit_bonuses_user on private.ai_credit_bonuses (user_id);
alter table private.ai_credit_bonuses enable row level security;
alter table private.ai_credit_bonuses force row level security;
revoke all on table private.ai_credit_bonuses from public, anon, authenticated;

alter table private.ai_credit_ledger add column bonus_amount integer not null default 0;
alter table private.ai_credit_ledger add constraint ai_credit_ledger_bonus_part
  check (bonus_amount >= 0 and bonus_amount <= amount);

alter table private.ai_admin_events drop constraint if exists ai_admin_events_kind_check;
alter table private.ai_admin_events add constraint ai_admin_events_kind_check check (kind in (
  'month_limit', 'base_grant', 'user_grant', 'assistant_enabled', 'assistant_space', 'bonus'
));

-- Bonus credits a person still holds.
create function private.ai_bonus_balance(p_user uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(0,
    coalesce((select sum(b.amount) from private.ai_credit_bonuses b where b.user_id = p_user), 0)
    - coalesce((
        select sum(case l.kind when 'debit' then l.bonus_amount else -l.bonus_amount end)
        from private.ai_credit_ledger l where l.user_id = p_user and l.bonus_amount > 0
      ), 0)
  )::integer;
$$;

-- What the day's grant paid: the bonus part of a charge is not the day's.
create or replace function private.ai_credits_spent(p_user uuid, p_day date)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(case l.kind when 'debit' then l.amount - l.bonus_amount
                                  else -(l.amount - l.bonus_amount) end), 0)::integer
  from private.ai_credit_ledger l
  where l.user_id = p_user and l.kyiv_day = p_day;
$$;

create or replace function private.ai_credits_snapshot(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_day date := private.kyiv_today();
  v_grant integer := private.ai_daily_grant(p_user);
  v_daily integer := greatest(0, private.ai_daily_grant(p_user) - private.ai_credits_spent(p_user, private.kyiv_today()));
  v_bonus integer := private.ai_bonus_balance(p_user);
  v_smallest numeric := (select s.credit_usd from private.ai_settings s where s.id);
begin
  return jsonb_build_object(
    'grant', v_grant,
    'daily', v_daily,
    'bonus', v_bonus,
    'available', v_daily + v_bonus,
    'day', to_char(v_day, 'YYYY-MM-DD'),
    'resetsAt', to_char(private.kyiv_day_end(v_day) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'paidOpen', private.ai_month_free_usd(private.ai_month_of(v_day)) >= v_smallest * 2,
    'recent', '[]'::jsonb
  );
end;
$$;

create or replace function public.service_ai_credit_debit(
  p_user uuid,
  p_op_key text,
  p_feature text,
  p_amount integer,
  p_price_version text,
  p_subject uuid,
  p_usd_upper numeric
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_day date := private.kyiv_today();
  v_month date := private.ai_month_of(private.kyiv_today());
  v_prior private.ai_credit_ledger;
  v_available integer;
  v_bonus integer;
  v_version text := (select s.price_version from private.ai_settings s where s.id);
begin
  if p_user is null or p_op_key is null or p_amount is null or p_amount <= 0
     or p_usd_upper is null or p_usd_upper < 0 or p_usd_upper > 10
     or p_feature not in ('transcript_translation', 'launch_assistant') then
    raise exception 'INVALID_INPUT' using errcode = 'PT409';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_credits:' || p_user::text, 0));
  select * into v_prior from private.ai_credit_ledger l
  where l.user_id = p_user and l.op_key = p_op_key and l.kind = 'debit';
  if found then
    if v_prior.amount <> p_amount or v_prior.feature <> p_feature then
      raise exception 'KEY_REUSED' using errcode = 'PT409';
    end if;
    return jsonb_build_object('replayed', true, 'credits', private.ai_credits_snapshot(p_user));
  end if;
  if p_price_version is distinct from v_version then
    raise exception 'PRICE_CHANGED' using errcode = 'PT409',
      detail = jsonb_build_object('priceVersion', v_version)::text;
  end if;
  -- The day's grant first, then bonus credits for what it does not cover.
  v_available := greatest(0, private.ai_daily_grant(p_user) - private.ai_credits_spent(p_user, v_day));
  v_bonus := private.ai_bonus_balance(p_user);
  if v_available + v_bonus < p_amount then
    raise exception 'INSUFFICIENT_CREDITS' using errcode = 'PT409', detail = jsonb_build_object(
      'needed', p_amount,
      'available', v_available + v_bonus,
      'resetsAt', to_char(private.kyiv_day_end(v_day) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    )::text;
  end if;
  -- Second lock, shared by everybody: the month's free money is read and reduced in one step.
  perform pg_advisory_xact_lock(hashtextextended('ai_month:' || v_month::text, 0));
  if private.ai_month_free_usd(v_month) < p_usd_upper then
    raise exception 'AI_MONTH_EXHAUSTED' using errcode = 'PT409';
  end if;
  insert into private.ai_credit_ledger (user_id, op_key, kind, kyiv_day, feature, amount, price_version, bonus_amount)
  values (p_user, p_op_key, 'debit', v_day, p_feature, p_amount, p_price_version, greatest(0, p_amount - v_available));
  insert into private.ai_month_holds (op_key, month, subject_id, usd_upper)
  values (p_op_key, v_month, p_subject, p_usd_upper)
  on conflict (op_key) do nothing;
  return jsonb_build_object('replayed', false, 'credits', private.ai_credits_snapshot(p_user));
end;
$$;

create or replace function public.service_ai_credit_refund(p_user uuid, p_op_key text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_debit private.ai_credit_ledger;
begin
  if p_user is null or p_op_key is null then
    raise exception 'INVALID_INPUT' using errcode = 'PT409';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_credits:' || p_user::text, 0));
  select * into v_debit from private.ai_credit_ledger l
  where l.user_id = p_user and l.op_key = p_op_key and l.kind = 'debit';
  if found then
    insert into private.ai_credit_ledger (user_id, op_key, kind, kyiv_day, feature, amount, price_version, bonus_amount)
    values (p_user, p_op_key, 'refund', v_debit.kyiv_day, v_debit.feature, v_debit.amount, v_debit.price_version,
      v_debit.bonus_amount)
    on conflict (user_id, op_key, kind) do nothing;
  end if;
  perform public.service_ai_credit_settle(p_op_key);
  return private.ai_credits_snapshot(p_user);
end;
$$;

-- An administrator gives a person bonus credits (or takes back what is unspent, with a negative
-- amount no larger than the balance).
create function public.admin_ai_grant_bonus(p_email text, p_amount integer, p_note text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.require_ai_admin();
  v_user uuid;
  v_before integer;
begin
  if p_email is null or p_amount is null or p_amount = 0 or abs(p_amount) > 1000000
     or (p_note is not null and char_length(p_note) > 200) then
    raise exception 'INVALID_INPUT' using errcode = 'PT409';
  end if;
  select u.id into v_user from auth.users u
  where lower(u.email) = lower(btrim(p_email)) and u.email_confirmed_at is not null;
  if v_user is null then
    raise exception 'NOT_FOUND' using errcode = 'PT409';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_credits:' || v_user::text, 0));
  v_before := private.ai_bonus_balance(v_user);
  if p_amount < 0 and -p_amount > v_before then
    raise exception 'INVALID_INPUT' using errcode = 'PT409';
  end if;
  insert into private.ai_credit_bonuses (user_id, amount, note, granted_by)
  values (v_user, p_amount, nullif(btrim(coalesce(p_note, '')), ''), v_actor);
  insert into private.ai_admin_events (actor_id, kind, subject_id, before, after)
  values (v_actor, 'bonus', v_user, to_jsonb(v_before), to_jsonb(v_before + p_amount));
  return public.admin_ai_budget_overview();
end;
$$;

create or replace function public.admin_ai_budget_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := private.kyiv_today();
  v_month date := private.ai_month_of(private.kyiv_today());
  v_days integer := extract(day from (v_month + interval '1 month' - interval '1 day'))::integer;
  v_full_days integer := (v_today - v_month);
  v_settings private.ai_settings;
  v_spent numeric;
  v_spent_full numeric;
  v_held numeric;
  v_limit numeric;
  v_active_grants numeric;
begin
  perform private.require_ai_admin();
  select * into v_settings from private.ai_settings s where s.id;
  v_limit := private.ai_month_limit(v_month);
  v_spent := private.ai_month_spent_usd(v_month);
  v_held := private.ai_month_held_usd(v_month);
  select coalesce(sum(u.cost_micro_usd), 0) / 1000000.0 into v_spent_full
  from private.ai_usage_events u
  where u.created_at >= (v_month::timestamp at time zone 'Europe/Kyiv')
    and u.created_at < (v_today::timestamp at time zone 'Europe/Kyiv');
  -- People who used any AI feature in the last 30 days, at their own grant.
  select coalesce(sum(private.ai_daily_grant(a.user_id)), 0) into v_active_grants
  from (
    select distinct l.user_id from private.ai_credit_ledger l
    where l.created_at > private.tariff_now() - interval '30 days'
    union
    select distinct u.user_id from private.ai_usage_events u
    where u.user_id is not null and u.created_at > private.tariff_now() - interval '30 days'
  ) a;
  return jsonb_build_object(
    'month', to_char(v_month, 'YYYY-MM'),
    'day', to_char(v_today, 'YYYY-MM-DD'),
    'daysInMonth', v_days,
    'fullDays', v_full_days,
    'limitUsd', v_limit,
    'spentUsd', round(v_spent, 6),
    'heldUsd', round(v_held, 6),
    'freeUsd', round(v_limit - v_spent - v_held, 6),
    'forecastUsd', case when v_full_days > 0 then round(v_spent_full / v_full_days * v_days, 6) end,
    'fullGrantUseUsd', round(v_spent + v_active_grants * v_settings.credit_usd * (v_days - v_full_days), 6),
    'byFeature', coalesce((
      select jsonb_agg(jsonb_build_object(
        'feature', f.feature,
        'spentUsd', round(f.usd, 6),
        'chargedCredits', f.charged,
        -- Charged credits at their USD value over the real cost; below 1 means prices are too low.
        'coverage', case when f.usd > 0 then round(f.charged * v_settings.credit_usd / f.usd, 3) end,
        'unknownCalls', f.unknown
      ) order by f.feature)
      from (
        select x.feature,
          coalesce(sum(x.usd), 0) as usd,
          coalesce(sum(x.charged), 0)::integer as charged,
          coalesce(sum(x.unknown), 0)::integer as unknown
        from (
          select u.feature, u.cost_micro_usd / 1000000.0 as usd, 0 as charged,
            case when u.usage_known is false then 1 else 0 end as unknown
          from private.ai_usage_events u
          where u.created_at >= (v_month::timestamp at time zone 'Europe/Kyiv')
            and u.created_at < ((v_month + interval '1 month')::timestamp at time zone 'Europe/Kyiv')
          union all
          select l.feature, 0, case l.kind when 'debit' then l.amount else -l.amount end, 0
          from private.ai_credit_ledger l
          where l.kyiv_day >= v_month and l.kyiv_day < (v_month + interval '1 month')::date
        ) x
        group by x.feature
      ) f
    ), '[]'::jsonb),
    'creditUsd', v_settings.credit_usd,
    'baseDailyGrant', v_settings.base_daily_grant,
    'assistantEnabled', v_settings.assistant_enabled,
    'grants', coalesce((
      select jsonb_agg(jsonb_build_object('email', u.email, 'dailyGrant', g.daily_grant) order by u.email)
      from private.ai_credit_grants g join auth.users u on u.id = g.user_id
    ), '[]'::jsonb),
    -- Bonus credits people still hold, largest first: they are spent after the daily grant.
    'bonuses', coalesce((
      select jsonb_agg(jsonb_build_object('email', u.email, 'balance', b.balance) order by b.balance desc, u.email)
      from (
        select x.user_id, private.ai_bonus_balance(x.user_id) as balance
        from (select distinct g.user_id from private.ai_credit_bonuses g) x
      ) b join auth.users u on u.id = b.user_id
      where b.balance > 0
    ), '[]'::jsonb),
    'updatedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
end;
$$;

revoke all on function private.ai_bonus_balance(uuid) from public, anon, authenticated;
revoke all on function public.admin_ai_grant_bonus(text, integer, text) from public, anon;
grant execute on function public.admin_ai_grant_bonus(text, integer, text) to authenticated;
