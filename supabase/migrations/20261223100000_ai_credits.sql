-- 064: чарунки — one daily credit grant per person for every AI feature, and one monthly USD
-- budget for Soty.
--
-- A paid action is priced before the button is pressed (packages/shared ai-credits.ts), and
-- exactly that price is debited when it is pressed. In the same transaction the call's upper USD
-- estimate is held against the month, under one month-wide lock, so two people at the edge of the
-- budget cannot both get through. The hold is replaced by the provider's real cost when the call
-- ends. The person never pays more than the label; Soty absorbs the difference.
--
-- Lock order is always person → month. Translation (063) takes its job lock before both.
-- Business refusals use errcode PT409: PostgREST retries some other codes forever.

create table private.ai_settings (
  id boolean primary key default true check (id),
  credit_usd numeric(12, 6) not null default 0.001 check (credit_usd > 0),
  base_daily_grant integer not null default 100 check (base_daily_grant between 0 and 100000),
  price_version text not null default 'v1' check (price_version ~ '^v[0-9]{1,4}$'),
  assistant_enabled boolean not null default false,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into private.ai_settings (id) values (true);

create table private.ai_credit_grants (
  user_id uuid primary key references auth.users (id) on delete cascade,
  daily_grant integer not null check (daily_grant between 0 and 100000),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

create table private.ai_credit_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  op_key text not null check (op_key ~ '^[a-z_]{3,40}:[A-Za-z0-9:_-]{8,120}$'),
  kind text not null check (kind in ('debit', 'refund')),
  kyiv_day date not null,
  feature text not null check (feature in ('transcript_translation', 'launch_assistant')),
  amount integer not null check (amount > 0 and amount <= 100000),
  price_version text not null check (price_version ~ '^v[0-9]{1,4}$'),
  created_at timestamptz not null default now(),
  unique (user_id, op_key, kind)
);
create index ai_credit_ledger_user_day on private.ai_credit_ledger (user_id, kyiv_day);
create index ai_credit_ledger_created on private.ai_credit_ledger (created_at);

-- A row applies from its month onward until a later row; the newest row at or before a month wins.
create table private.ai_budget_months (
  month date primary key check (extract(day from month) = 1),
  limit_usd numeric(12, 2) not null check (limit_usd > 0 and limit_usd <= 100000),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into private.ai_budget_months (month, limit_usd) values ('2026-11-01', 100);

create table private.ai_month_holds (
  op_key text primary key check (op_key ~ '^[a-z_]{3,40}:[A-Za-z0-9:_-]{8,120}$'),
  month date not null check (extract(day from month) = 1),
  subject_id uuid,
  usd_upper numeric(14, 8) not null check (usd_upper >= 0),
  usd_actual numeric(14, 8) check (usd_actual >= 0),
  state text not null default 'held' check (state in ('held', 'settled')),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  check ((state = 'held') = (settled_at is null))
);
create index ai_month_holds_open on private.ai_month_holds (month) where state = 'held';

create table private.ai_admin_events (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users (id) on delete set null,
  kind text not null check (kind in (
    'month_limit', 'base_grant', 'user_grant', 'assistant_enabled', 'assistant_space'
  )),
  subject_id uuid,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);

-- jsonb puts the journal in the attachment-cleanup inventory; without the fence the coverage check
-- turns false and attachment cleanup stops for the whole base.
create trigger task_cleanup_reference_fence before insert or update on private.ai_admin_events
  for each row execute function private.guard_task_cleanup_reference();

-- The provider's cost of a call is joined to the action that paid for it by op_key; a call whose
-- usage never arrived is "unknown", not zero.
alter table private.ai_usage_events add column op_key text;
alter table private.ai_usage_events add column usage_known boolean;
create index ai_usage_events_subject on private.ai_usage_events (subject_id) where subject_id is not null;

alter table private.ai_settings enable row level security;
alter table private.ai_settings force row level security;
alter table private.ai_credit_grants enable row level security;
alter table private.ai_credit_grants force row level security;
alter table private.ai_credit_ledger enable row level security;
alter table private.ai_credit_ledger force row level security;
alter table private.ai_budget_months enable row level security;
alter table private.ai_budget_months force row level security;
alter table private.ai_month_holds enable row level security;
alter table private.ai_month_holds force row level security;
alter table private.ai_admin_events enable row level security;
alter table private.ai_admin_events force row level security;
revoke all on table private.ai_settings, private.ai_credit_grants, private.ai_credit_ledger,
  private.ai_budget_months, private.ai_month_holds, private.ai_admin_events
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Reading

-- A hold older than this no longer counts: the call that made it finished or died. Longer than
-- the slowest call (a translation stops itself at four minutes).
create function private.ai_hold_window()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '15 minutes' $$;

create function private.ai_month_of(p_day date)
returns date
language sql
immutable
set search_path = ''
as $$ select date_trunc('month', p_day)::date $$;

create function private.ai_daily_grant(p_user uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select g.daily_grant from private.ai_credit_grants g where g.user_id = p_user),
    (select s.base_daily_grant from private.ai_settings s where s.id)
  );
$$;

create function private.ai_credits_spent(p_user uuid, p_day date)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(case l.kind when 'debit' then l.amount else -l.amount end), 0)::integer
  from private.ai_credit_ledger l
  where l.user_id = p_user and l.kyiv_day = p_day;
$$;

create function private.ai_month_limit(p_month date)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select b.limit_usd from private.ai_budget_months b where b.month <= p_month
     order by b.month desc limit 1),
    100
  );
$$;

-- Provider cost recorded for calls made in a Kyiv month.
create function private.ai_month_spent_usd(p_month date)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(u.cost_micro_usd), 0) / 1000000.0
  from private.ai_usage_events u
  where u.created_at >= (p_month::timestamp at time zone 'Europe/Kyiv')
    and u.created_at < ((p_month + interval '1 month')::timestamp at time zone 'Europe/Kyiv');
$$;

-- What open holds still reserve: their upper estimate minus what their calls already recorded,
-- so a running call is never counted twice.
create function private.ai_month_held_usd(p_month date)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(greatest(0, h.usd_upper - coalesce((
    select sum(u.cost_micro_usd) / 1000000.0 from private.ai_usage_events u
    where h.subject_id is not null and u.subject_id = h.subject_id
  ), 0))), 0)
  from private.ai_month_holds h
  where h.month = p_month
    and h.state = 'held'
    and h.created_at > private.tariff_now() - private.ai_hold_window();
$$;

create function private.ai_month_free_usd(p_month date)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select private.ai_month_limit(p_month) - private.ai_month_spent_usd(p_month)
    - private.ai_month_held_usd(p_month);
$$;

create function private.ai_credits_snapshot(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_day date := private.kyiv_today();
  v_grant integer := private.ai_daily_grant(p_user);
  v_spent integer := private.ai_credits_spent(p_user, v_day);
  v_smallest numeric := (select s.credit_usd from private.ai_settings s where s.id);
begin
  return jsonb_build_object(
    'grant', v_grant,
    'available', greatest(0, v_grant - v_spent),
    'day', to_char(v_day, 'YYYY-MM-DD'),
    'resetsAt', to_char(private.kyiv_day_end(v_day) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    -- Only whether one more small paid call fits; the totals stay with the admin.
    'paidOpen', private.ai_month_free_usd(private.ai_month_of(v_day)) >= v_smallest * 2,
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object(
        'feature', r.feature, 'kind', r.kind, 'amount', r.amount,
        'at', to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      ) order by r.created_at desc, r.id desc)
      from (
        select l.* from private.ai_credit_ledger l
        where l.user_id = p_user
        order by l.created_at desc, l.id desc
        limit 10
      ) r
    ), '[]'::jsonb)
  );
end;
$$;

create function public.ai_credits_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = 'PT409';
  end if;
  return private.ai_credits_snapshot(auth.uid());
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Paying

-- Debits exactly the shown price and holds the call's upper USD estimate against the month.
-- Idempotent on (person, op_key): the same key and amount returns the same result; a different
-- amount or feature under the same key is KEY_REUSED.
create function public.service_ai_credit_debit(
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
  v_available := private.ai_daily_grant(p_user) - private.ai_credits_spent(p_user, v_day);
  if v_available < p_amount then
    raise exception 'INSUFFICIENT_CREDITS' using errcode = 'PT409', detail = jsonb_build_object(
      'needed', p_amount,
      'available', greatest(0, v_available),
      'resetsAt', to_char(private.kyiv_day_end(v_day) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    )::text;
  end if;
  -- Second lock, shared by everybody: the month's free money is read and reduced in one step.
  perform pg_advisory_xact_lock(hashtextextended('ai_month:' || v_month::text, 0));
  if private.ai_month_free_usd(v_month) < p_usd_upper then
    raise exception 'AI_MONTH_EXHAUSTED' using errcode = 'PT409';
  end if;
  insert into private.ai_credit_ledger (user_id, op_key, kind, kyiv_day, feature, amount, price_version)
  values (p_user, p_op_key, 'debit', v_day, p_feature, p_amount, p_price_version);
  insert into private.ai_month_holds (op_key, month, subject_id, usd_upper)
  values (p_op_key, v_month, p_subject, p_usd_upper)
  on conflict (op_key) do nothing;
  return jsonb_build_object('replayed', false, 'credits', private.ai_credits_snapshot(p_user));
end;
$$;

-- Replaces a hold by what its calls really cost. Idempotent.
create function public.service_ai_credit_settle(p_op_key text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update private.ai_month_holds h
  set state = 'settled',
      settled_at = now(),
      usd_actual = coalesce((
        select sum(u.cost_micro_usd) / 1000000.0 from private.ai_usage_events u
        where h.subject_id is not null and u.subject_id = h.subject_id
      ), 0)
  where h.op_key = p_op_key and h.state = 'held';
$$;

-- Gives a debit back to the day it was taken from (a refund after midnight does not add to the
-- new day: that day's grant is whole anyway) and settles its hold. Idempotent.
create function public.service_ai_credit_refund(p_user uuid, p_op_key text)
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
    insert into private.ai_credit_ledger (user_id, op_key, kind, kyiv_day, feature, amount, price_version)
    values (p_user, p_op_key, 'refund', v_debit.kyiv_day, v_debit.feature, v_debit.amount, v_debit.price_version)
    on conflict (user_id, op_key, kind) do nothing;
  end if;
  perform public.service_ai_credit_settle(p_op_key);
  return private.ai_credits_snapshot(p_user);
end;
$$;

-- The 063 ledger writer with the paying operation and whether usage figures arrived at all.
create function public.service_ai_usage_record_v2(
  p_op_key text,
  p_usage_known boolean,
  p_feature text,
  p_user uuid,
  p_subject uuid,
  p_model text,
  p_outcome text,
  p_stop_reason text,
  p_input integer,
  p_output integer,
  p_cache_read integer,
  p_cache_write integer,
  p_cost_micro_usd bigint,
  p_duration_ms integer
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into private.ai_usage_events (
    op_key, usage_known, feature, user_id, subject_id, model, outcome, stop_reason, input_tokens,
    output_tokens, cache_read_tokens, cache_write_tokens, cost_micro_usd, duration_ms
  ) values (
    left(p_op_key, 160), coalesce(p_usage_known, true), p_feature, p_user, p_subject, p_model, p_outcome,
    left(p_stop_reason, 40), greatest(coalesce(p_input, 0), 0), greatest(coalesce(p_output, 0), 0),
    greatest(coalesce(p_cache_read, 0), 0), greatest(coalesce(p_cache_write, 0), 0),
    greatest(coalesce(p_cost_micro_usd, 0), 0), greatest(coalesce(p_duration_ms, 0), 0)
  );
$$;

-- ---------------------------------------------------------------------------------------------
-- Administration (public.is_admin() on the server, never only in the UI)

create function private.require_ai_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'PERMISSION_DENIED' using errcode = 'PT409';
  end if;
  return auth.uid();
end;
$$;

create function public.admin_ai_budget_overview()
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
    'updatedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
end;
$$;

create function public.admin_ai_set_month_limit(p_limit numeric)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.require_ai_admin();
  v_month date := private.ai_month_of(private.kyiv_today());
  v_before numeric := private.ai_month_limit(private.ai_month_of(private.kyiv_today()));
begin
  if p_limit is null or p_limit <= 0 or p_limit > 100000 then
    raise exception 'INVALID_INPUT' using errcode = 'PT409';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_month:' || v_month::text, 0));
  if p_limit < private.ai_month_spent_usd(v_month) then
    raise exception 'BUDGET_BELOW_SPENT' using errcode = 'PT409';
  end if;
  insert into private.ai_budget_months (month, limit_usd, updated_by)
  values (v_month, round(p_limit, 2), v_actor)
  on conflict (month) do update set limit_usd = excluded.limit_usd, updated_by = excluded.updated_by,
    updated_at = now();
  insert into private.ai_admin_events (actor_id, kind, before, after)
  values (v_actor, 'month_limit', to_jsonb(v_before), to_jsonb(round(p_limit, 2)));
  return public.admin_ai_budget_overview();
end;
$$;

create function public.admin_ai_set_base_grant(p_grant integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.require_ai_admin();
  v_before integer;
begin
  if p_grant is null or p_grant < 0 or p_grant > 100000 then
    raise exception 'INVALID_INPUT' using errcode = 'PT409';
  end if;
  select s.base_daily_grant into v_before from private.ai_settings s where s.id for update;
  update private.ai_settings set base_daily_grant = p_grant, updated_by = v_actor, updated_at = now()
  where id;
  insert into private.ai_admin_events (actor_id, kind, before, after)
  values (v_actor, 'base_grant', to_jsonb(v_before), to_jsonb(p_grant));
  return public.admin_ai_budget_overview();
end;
$$;

-- p_grant null removes the personal grant (back to the base grant).
create function public.admin_ai_set_user_grant(p_email text, p_grant integer)
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
  if p_email is null or (p_grant is not null and (p_grant < 0 or p_grant > 100000)) then
    raise exception 'INVALID_INPUT' using errcode = 'PT409';
  end if;
  select u.id into v_user from auth.users u
  where lower(u.email) = lower(btrim(p_email)) and u.email_confirmed_at is not null;
  if v_user is null then
    raise exception 'NOT_FOUND' using errcode = 'PT409';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_credits:' || v_user::text, 0));
  select g.daily_grant into v_before from private.ai_credit_grants g where g.user_id = v_user;
  if p_grant is null then
    delete from private.ai_credit_grants where user_id = v_user;
  else
    insert into private.ai_credit_grants (user_id, daily_grant, updated_by)
    values (v_user, p_grant, v_actor)
    on conflict (user_id) do update set daily_grant = excluded.daily_grant,
      updated_by = excluded.updated_by, updated_at = now();
  end if;
  insert into private.ai_admin_events (actor_id, kind, subject_id, before, after)
  values (v_actor, 'user_grant', v_user, to_jsonb(v_before), to_jsonb(p_grant));
  return public.admin_ai_budget_overview();
end;
$$;

create function public.admin_ai_set_assistant_enabled(p_enabled boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.require_ai_admin();
  v_before boolean;
begin
  if p_enabled is null then
    raise exception 'INVALID_INPUT' using errcode = 'PT409';
  end if;
  select s.assistant_enabled into v_before from private.ai_settings s where s.id for update;
  update private.ai_settings set assistant_enabled = p_enabled, updated_by = v_actor, updated_at = now()
  where id;
  insert into private.ai_admin_events (actor_id, kind, before, after)
  values (v_actor, 'assistant_enabled', to_jsonb(v_before), to_jsonb(p_enabled));
  return public.admin_ai_budget_overview();
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Grants

revoke all on function private.ai_hold_window() from public, anon, authenticated;
revoke all on function private.ai_month_of(date) from public, anon, authenticated;
revoke all on function private.ai_daily_grant(uuid) from public, anon, authenticated;
revoke all on function private.ai_credits_spent(uuid, date) from public, anon, authenticated;
revoke all on function private.ai_month_limit(date) from public, anon, authenticated;
revoke all on function private.ai_month_spent_usd(date) from public, anon, authenticated;
revoke all on function private.ai_month_held_usd(date) from public, anon, authenticated;
revoke all on function private.ai_month_free_usd(date) from public, anon, authenticated;
revoke all on function private.ai_credits_snapshot(uuid) from public, anon, authenticated;
revoke all on function private.require_ai_admin() from public, anon, authenticated;
revoke all on function public.ai_credits_status() from public, anon;
revoke all on function public.service_ai_credit_debit(uuid, text, text, integer, text, uuid, numeric)
  from public, anon, authenticated;
revoke all on function public.service_ai_credit_settle(text) from public, anon, authenticated;
revoke all on function public.service_ai_credit_refund(uuid, text) from public, anon, authenticated;
revoke all on function public.service_ai_usage_record_v2(text, boolean, text, uuid, uuid, text, text, text,
  integer, integer, integer, integer, bigint, integer) from public, anon, authenticated;
revoke all on function public.admin_ai_budget_overview() from public, anon;
revoke all on function public.admin_ai_set_month_limit(numeric) from public, anon;
revoke all on function public.admin_ai_set_base_grant(integer) from public, anon;
revoke all on function public.admin_ai_set_user_grant(text, integer) from public, anon;
revoke all on function public.admin_ai_set_assistant_enabled(boolean) from public, anon;

grant execute on function public.ai_credits_status() to authenticated;
grant execute on function private.ai_credits_snapshot(uuid) to service_role;
grant execute on function public.service_ai_credit_debit(uuid, text, text, integer, text, uuid, numeric)
  to service_role;
grant execute on function public.service_ai_credit_settle(text) to service_role;
grant execute on function public.service_ai_credit_refund(uuid, text) to service_role;
grant execute on function public.service_ai_usage_record_v2(text, boolean, text, uuid, uuid, text, text, text,
  integer, integer, integer, integer, bigint, integer) to service_role;
grant execute on function public.admin_ai_budget_overview() to authenticated;
grant execute on function public.admin_ai_set_month_limit(numeric) to authenticated;
grant execute on function public.admin_ai_set_base_grant(integer) to authenticated;
grant execute on function public.admin_ai_set_user_grant(text, integer) to authenticated;
grant execute on function public.admin_ai_set_assistant_enabled(boolean) to authenticated;
