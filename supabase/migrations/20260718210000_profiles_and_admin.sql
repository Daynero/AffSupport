-- Wishly identity foundation: private user profiles and database-backed admins.

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  language text not null default 'uk',
  plan text not null default 'free',
  account_status text not null default 'active',
  marketing_consent boolean not null default false,
  marketing_consent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz,
  onboarding_completed boolean not null default false,
  constraint profiles_email_length check (email is null or char_length(email) <= 320),
  constraint profiles_display_name_length check (
    display_name is null or char_length(display_name) between 1 and 120
  ),
  constraint profiles_avatar_url_length check (
    avatar_url is null or char_length(avatar_url) <= 2048
  ),
  constraint profiles_language_check check (language in ('en', 'uk')),
  constraint profiles_plan_check check (plan in ('free', 'pro', 'team')),
  constraint profiles_account_status_check check (account_status in ('active', 'blocked', 'deleted')),
  constraint profiles_marketing_consent_time_check check (
    (marketing_consent = true and marketing_consent_at is not null)
    or (marketing_consent = false and marketing_consent_at is null)
  )
);

create table public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.set_marketing_consent_time()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.marketing_consent is distinct from old.marketing_consent then
    new.marketing_consent_at = case when new.marketing_consent then now() else null end;
  end if;
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger profiles_set_marketing_consent_time
before update on public.profiles
for each row execute function public.set_marketing_consent_time();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    left(new.email, 320),
    left(
      nullif(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'), ''),
      120
    ),
    left(
      nullif(coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture'), ''),
      2048
    )
  )
  on conflict (id) do update
  set
    email = excluded.email,
    display_name = coalesce(excluded.display_name, public.profiles.display_name),
    avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url);
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- Backfill users who authenticated before this migration was applied.
insert into public.profiles (id, email, display_name, avatar_url)
select
  users.id,
  left(users.email, 320),
  left(
    nullif(coalesce(users.raw_user_meta_data ->> 'full_name', users.raw_user_meta_data ->> 'name'), ''),
    120
  ),
  left(
    nullif(coalesce(users.raw_user_meta_data ->> 'avatar_url', users.raw_user_meta_data ->> 'picture'), ''),
    2048
  )
from auth.users as users
on conflict (id) do nothing;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from public.admin_users
      where user_id = auth.uid()
    );
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

create or replace function public.touch_last_seen()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  touched_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  update public.profiles
  set last_seen_at = now()
  where id = auth.uid()
    and (last_seen_at is null or last_seen_at < now() - interval '6 hours')
  returning last_seen_at into touched_at;

  if touched_at is null then
    select last_seen_at into touched_at
    from public.profiles
    where id = auth.uid();
  end if;
  return touched_at;
end;
$$;

revoke all on function public.touch_last_seen() from public, anon;
grant execute on function public.touch_last_seen() to authenticated;

alter table public.profiles enable row level security;
alter table public.admin_users enable row level security;

create policy profiles_select_own
on public.profiles
for select
to authenticated
using ((select auth.uid()) = id);

create policy profiles_update_own
on public.profiles
for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

-- admin_users intentionally has no client policies. Only trusted SQL and the
-- is_admin() helper can inspect or change it.
revoke all on table public.profiles from anon, authenticated;
revoke all on table public.admin_users from anon, authenticated;
grant select on table public.profiles to authenticated;
grant update (display_name, language, marketing_consent, onboarding_completed)
on table public.profiles to authenticated;

revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.set_marketing_consent_time() from public, anon, authenticated;

comment on table public.profiles is 'Private Wishly user profiles; one row per auth.users record.';
comment on table public.admin_users is 'Database-backed Wishly administrators; never exposed directly to clients.';
comment on function public.is_admin() is 'Checks the current JWT subject against admin_users without exposing the list.';
