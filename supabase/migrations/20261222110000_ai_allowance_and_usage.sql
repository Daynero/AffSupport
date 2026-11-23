-- 063: the shared ground for every feature that calls a Claude model.
--
-- Three things live here, deliberately not inside the translation feature:
--   * a per-feature daily allowance (units are the feature's own: characters for translation),
--   * reservations against it, so that concurrent requests can never spend past the limit and a
--     failed request gives back exactly what it took,
--   * a cost ledger with one row per model call, without any user content.
-- The next feature that calls the model adds its row to ai_feature_allowances and reuses the rest.
--
-- "Day" is the Kyiv business day of the tariff seam (private.kyiv_today), the same day people see
-- on their invoices. Nothing accumulates: yesterday's unused allowance is simply not counted.

create table private.ai_feature_allowances (
  feature text primary key check (feature ~ '^[a-z][a-z0-9_]{2,40}$'),
  daily_units integer not null check (daily_units > 0),
  updated_at timestamptz not null default now()
);

insert into private.ai_feature_allowances (feature, daily_units)
values ('transcript_translation', 9000);

create table private.ai_allowance_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  feature text not null references private.ai_feature_allowances (feature),
  day date not null,
  units integer not null check (units > 0),
  state text not null default 'held' check (state in ('held', 'spent', 'released')),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  check ((state = 'held') = (settled_at is null))
);

create index ai_allowance_reservations_user_day
  on private.ai_allowance_reservations (user_id, feature, day);

create table private.ai_usage_events (
  id bigint generated always as identity primary key,
  feature text not null check (feature ~ '^[a-z][a-z0-9_]{2,40}$'),
  user_id uuid references auth.users (id) on delete set null,
  subject_id uuid,
  model text not null check (model ~ '^claude-[a-z0-9-]{3,40}$'),
  outcome text not null check (outcome in ('completed', 'refused', 'failed')),
  stop_reason text check (char_length(stop_reason) <= 40),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cache_read_tokens integer not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens integer not null default 0 check (cache_write_tokens >= 0),
  cost_micro_usd bigint not null check (cost_micro_usd >= 0),
  duration_ms integer not null check (duration_ms >= 0),
  created_at timestamptz not null default now()
);

create index ai_usage_events_created on private.ai_usage_events (created_at);
create index ai_usage_events_feature_created on private.ai_usage_events (feature, created_at);

alter table private.ai_feature_allowances enable row level security;
alter table private.ai_feature_allowances force row level security;
alter table private.ai_allowance_reservations enable row level security;
alter table private.ai_allowance_reservations force row level security;
alter table private.ai_usage_events enable row level security;
alter table private.ai_usage_events force row level security;
revoke all on table private.ai_feature_allowances, private.ai_allowance_reservations,
  private.ai_usage_events from public, anon, authenticated, service_role;

-- A held reservation older than this no longer counts: the request that made it either finished
-- (and settled) or died. Longer than any translation may run (the function stops itself at four
-- minutes, a stale attempt is closed at five), so a live request is never under-counted.
create function private.ai_allowance_hold_window()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '6 minutes' $$;

create function private.ai_allowance_used(p_user uuid, p_feature text, p_day date)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(r.units), 0)::integer
  from private.ai_allowance_reservations r
  where r.user_id = p_user
    and r.feature = p_feature
    and r.day = p_day
    and (r.state = 'spent'
      or (r.state = 'held' and r.created_at > now() - private.ai_allowance_hold_window()));
$$;

create function private.ai_allowance_snapshot(p_user uuid, p_feature text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_day date := private.kyiv_today();
begin
  select a.daily_units into v_limit from private.ai_feature_allowances a where a.feature = p_feature;
  if v_limit is null then
    raise exception 'INVALID_INPUT' using errcode = 'PT409';
  end if;
  return jsonb_build_object(
    'feature', p_feature,
    'limitUnits', v_limit,
    'usedUnits', least(v_limit, private.ai_allowance_used(p_user, p_feature, v_day)),
    'day', to_char(v_day, 'YYYY-MM-DD'),
    -- The next Kyiv midnight as a UTC instant; the browser shows it in Kyiv time.
    'resetsAt', to_char(
      ((v_day + 1)::timestamp at time zone 'Europe/Kyiv') at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS"Z"'
    )
  );
end;
$$;

create function public.ai_allowance_status(p_feature text)
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
  return private.ai_allowance_snapshot(auth.uid(), p_feature);
end;
$$;

-- Reserves p_units for today or raises ALLOWANCE_EXCEEDED with the numbers a person needs to see.
-- The advisory lock serialises one person's concurrent requests for one feature, so two tabs
-- confirming at once cannot both fit into what only one of them fits into.
create function public.service_ai_allowance_reserve(p_user uuid, p_feature text, p_units integer)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_used integer;
  v_day date := private.kyiv_today();
  v_id uuid;
begin
  if p_user is null or p_units is null or p_units <= 0 then
    raise exception 'INVALID_INPUT' using errcode = 'PT409';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_allowance:' || p_user::text || ':' || p_feature, 0));
  select a.daily_units into v_limit from private.ai_feature_allowances a where a.feature = p_feature;
  if v_limit is null then
    raise exception 'INVALID_INPUT' using errcode = 'PT409';
  end if;
  v_used := private.ai_allowance_used(p_user, p_feature, v_day);
  if v_used + p_units > v_limit then
    raise exception 'ALLOWANCE_EXCEEDED' using errcode = 'PT409', detail = jsonb_build_object(
      'neededUnits', p_units,
      'usedUnits', least(v_limit, v_used),
      'limitUnits', v_limit
    )::text;
  end if;
  insert into private.ai_allowance_reservations (user_id, feature, day, units)
  values (p_user, p_feature, v_day, p_units)
  returning id into v_id;
  return v_id;
end;
$$;

-- Idempotent: settling twice, or settling a reservation that already settled the other way,
-- changes nothing.
create function public.service_ai_allowance_settle(p_reservation uuid, p_spent boolean)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update private.ai_allowance_reservations
  set state = case when p_spent then 'spent' else 'released' end,
      settled_at = now()
  where id = p_reservation and state = 'held';
$$;

create function public.service_ai_usage_record(
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
    feature, user_id, subject_id, model, outcome, stop_reason, input_tokens, output_tokens,
    cache_read_tokens, cache_write_tokens, cost_micro_usd, duration_ms
  ) values (
    p_feature, p_user, p_subject, p_model, p_outcome, left(p_stop_reason, 40),
    greatest(coalesce(p_input, 0), 0), greatest(coalesce(p_output, 0), 0),
    greatest(coalesce(p_cache_read, 0), 0), greatest(coalesce(p_cache_write, 0), 0),
    greatest(coalesce(p_cost_micro_usd, 0), 0), greatest(coalesce(p_duration_ms, 0), 0)
  );
$$;

revoke all on function private.ai_allowance_hold_window() from public, anon, authenticated;
revoke all on function private.ai_allowance_used(uuid, text, date) from public, anon, authenticated;
revoke all on function private.ai_allowance_snapshot(uuid, text) from public, anon, authenticated;
revoke all on function public.service_ai_allowance_reserve(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.service_ai_allowance_settle(uuid, boolean) from public, anon, authenticated;
revoke all on function public.service_ai_usage_record(text, uuid, uuid, text, text, text, integer, integer,
  integer, integer, bigint, integer) from public, anon, authenticated;
revoke all on function public.ai_allowance_status(text) from public, anon;

grant execute on function public.ai_allowance_status(text) to authenticated;
grant execute on function private.ai_allowance_snapshot(uuid, text) to service_role;
grant execute on function public.service_ai_allowance_reserve(uuid, text, integer) to service_role;
grant execute on function public.service_ai_allowance_settle(uuid, boolean) to service_role;
grant execute on function public.service_ai_usage_record(text, uuid, uuid, text, text, text, integer, integer,
  integer, integer, bigint, integer) to service_role;
