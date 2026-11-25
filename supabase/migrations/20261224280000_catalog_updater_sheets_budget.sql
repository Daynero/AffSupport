-- The catalog updater keeps within a Drive owner's Google Sheets quota.
--
-- Google allows sixty Sheets reads a minute per user, and every catalog of a space is read
-- with its owner's credential. One nonvideo update spends four reads (six for an image
-- catalog). Since 20261224250000 the worker no longer waits for the minute's schedule, so a
-- run of more than a dozen catalogs could meet «slow down», and a round that met it failed a
-- try and, on the third, showed an error. The worker now takes its reads from a per-credential
-- bucket first: 28 at once, then 30 a minute — under sixty in any minute — so a run of seven
-- catalogs starts at once and a longer one is paced. A short wait is reserved and slept through
-- in place; a long one, or «slow down» from Google before anything was written, hands the
-- round back for later without a try counted or an error recorded.

create table private.google_sheets_read_budgets (
  credential_id uuid primary key,
  -- Below zero while reads are reserved ahead: the next caller waits for them too.
  tokens double precision not null check (tokens >= -28),
  refilled_at timestamptz not null
);
alter table private.google_sheets_read_budgets enable row level security;
revoke all on table private.google_sheets_read_budgets from public, anon, authenticated, service_role;

-- 0 when the reads are granted now. A wait up to p_max_wait_ms is reserved and answered: the
-- caller sleeps that long and goes on without asking again. A longer wait is answered without
-- a reservation, and the caller comes back later.
create or replace function public.service_take_google_sheets_reads(
  p_credential uuid,
  p_reads integer,
  p_max_wait_ms integer default 0
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  capacity constant double precision := 28;
  per_second constant double precision := 0.5;
  now_at timestamptz := clock_timestamp();
  held double precision;
  since timestamptz;
  available double precision;
  wait_ms integer;
begin
  if p_credential is null or p_reads is null or p_reads not between 1 and 12
     or p_max_wait_ms is null or p_max_wait_ms not between 0 and 60000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  insert into private.google_sheets_read_budgets (credential_id, tokens, refilled_at)
  values (p_credential, capacity, now_at)
  on conflict (credential_id) do nothing;
  select budget.tokens, budget.refilled_at into held, since
  from private.google_sheets_read_budgets as budget
  where budget.credential_id = p_credential
  for update;
  available := least(capacity, held + greatest(0, extract(epoch from now_at - since)) * per_second);
  wait_ms := case when available >= p_reads then 0
                  else ceil((p_reads - available) / per_second * 1000)::integer end;
  update private.google_sheets_read_budgets
     set tokens = case when wait_ms <= p_max_wait_ms and available - p_reads >= -capacity
                       then available - p_reads else available end,
         refilled_at = now_at
   where credential_id = p_credential;
  return wait_ms;
end;
$$;

-- Hands a claimed round back: the lease ends, the claim's try is returned, nothing is recorded
-- as an error. Only the worker that holds the lease may, and never for more than ten minutes.
create or replace function public.service_defer_catalog_update(
  p_item uuid,
  p_worker text,
  p_next_attempt_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_item is null or p_worker is null or p_next_attempt_at is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update public.team_catalog_updater_items as item
     set lease_owner = null,
         lease_expires_at = null,
         next_attempt_at = least(greatest(p_next_attempt_at, clock_timestamp()),
                                 clock_timestamp() + interval '10 minutes'),
         attempts = greatest(item.attempts - 1, 0)
   where item.catalog_material_id = p_item
     and item.lease_owner = p_worker
     and item.lease_expires_at > clock_timestamp();
  return found;
end;
$$;

revoke all on function public.service_take_google_sheets_reads(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.service_defer_catalog_update(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.service_take_google_sheets_reads(uuid, integer, integer) to service_role;
grant execute on function public.service_defer_catalog_update(uuid, text, timestamptz) to service_role;
