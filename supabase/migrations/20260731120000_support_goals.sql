-- Public, read-only support goals with an admin-only amount update.
--
-- Donation destinations remain configured in the web app. This table stores
-- only the public goal copy and aggregate amount; it never stores donor or
-- payment information.

create table public.support_goals (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  currency text not null default 'USD',
  target_cents bigint not null,
  raised_cents bigint not null default 0,
  title_en text not null,
  title_uk text not null,
  description_en text not null,
  description_uk text not null,
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint support_goals_slug_check check (
    slug ~ '^[a-z0-9][a-z0-9-]{0,79}$'
  ),
  constraint support_goals_currency_check check (
    currency ~ '^[A-Z]{3}$'
  ),
  constraint support_goals_amount_check check (
    target_cents between 1 and 1000000000000
    and raised_cents between 0 and 1000000000000
  ),
  constraint support_goals_title_length_check check (
    char_length(title_en) between 1 and 160
    and char_length(title_uk) between 1 and 160
  ),
  constraint support_goals_description_length_check check (
    char_length(description_en) between 1 and 2000
    and char_length(description_uk) between 1 and 2000
  ),
  constraint support_goals_status_check check (
    status in ('draft', 'active', 'archived')
  )
);

-- The persistent header and support dialog always present one concrete goal.
create unique index support_goals_one_active_idx
  on public.support_goals ((status))
  where status = 'active';

create trigger support_goals_set_updated_at
before update on public.support_goals
for each row execute function public.set_updated_at();

alter table public.support_goals enable row level security;

create policy support_goals_select_active
on public.support_goals
for select
to authenticated
using (status = 'active');

revoke all on table public.support_goals from anon, authenticated;
grant select on table public.support_goals to authenticated;

create or replace function public.admin_active_support_goal()
returns public.support_goals
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  goal public.support_goals;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;

  select *
  into goal
  from public.support_goals
  where status = 'active'
  limit 1;

  return goal;
end;
$$;

create or replace function public.admin_update_support_goal_amount(
  p_goal_id uuid,
  p_raised_cents bigint
)
returns public.support_goals
language plpgsql
security definer
set search_path = ''
as $$
declare
  goal public.support_goals;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if p_raised_cents is null
    or p_raised_cents < 0
    or p_raised_cents > 1000000000000 then
    raise exception 'Invalid raised amount' using errcode = '22023';
  end if;

  update public.support_goals
  set raised_cents = p_raised_cents
  where id = p_goal_id
    and status = 'active'
  returning * into goal;

  if goal.id is null then
    raise exception 'Active support goal not found' using errcode = 'P0002';
  end if;

  return goal;
end;
$$;

revoke all on function public.admin_active_support_goal() from public, anon;
revoke all on function public.admin_update_support_goal_amount(uuid, bigint) from public, anon;
grant execute on function public.admin_active_support_goal() to authenticated;
grant execute on function public.admin_update_support_goal_amount(uuid, bigint) to authenticated;

insert into public.support_goals (
  slug,
  currency,
  target_cents,
  raised_cents,
  title_en,
  title_uk,
  description_en,
  description_uk,
  status
) values (
  'mac-updates-apple-developer',
  'USD',
  9900,
  0,
  'Get rid of reinstalls',
  'Позбутися перевстановлень',
  'Right now, every update means downloading the DMG again and going through the same manual ritual. The $99 goal covers the first year of the Apple Developer Program. That will let me sign and notarize Soty, then add safe updates directly inside the app — without repeated downloads, manual replacement, or Terminal commands.',
  'Зараз кожне оновлення означає знову завантажити DMG, і інші танці з бубном. Щоб це прибрати, потрібні $99 на перший рік Apple Developer Program. Це дозволить підписувати й нотаризувати Soty, а далі — зробити безпечне оновлення прямо із застосунку: без повторних завантажень, ручної заміни та команд у Terminal.',
  'active'
);

-- Postgres Changes is opt-in. Keep local/test Postgres compatible when the
-- Supabase-owned publication is not present.
do $$
begin
  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'support_goals'
  ) then
    alter publication supabase_realtime add table public.support_goals;
  end if;
end;
$$;

comment on table public.support_goals is
  'Published Wishly funding goals and aggregate manually confirmed progress; no donor data.';
comment on function public.admin_active_support_goal() is
  'Returns the current support goal to a database-confirmed Wishly administrator.';
comment on function public.admin_update_support_goal_amount(uuid, bigint) is
  'Updates only the aggregate raised amount of the active goal after an admin check.';
