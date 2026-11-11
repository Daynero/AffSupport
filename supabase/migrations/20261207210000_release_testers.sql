-- Feature 051: who may use the release candidate on the `next` address.
--
-- A candidate is published to https://next.soty.pp.ua against production data
-- before everyone gets it. Administrators may always use it; the owner adds a
-- second tester here from the admin page. Additive only: a new table and new
-- functions, nothing the running production reads changes.

create table if not exists public.release_testers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_by uuid references auth.users(id) on delete set null,
  added_at timestamptz not null default now()
);

alter table public.release_testers enable row level security;
revoke all on table public.release_testers from public, anon, authenticated;

create or replace function public.is_release_tester()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and (
      public.is_admin()
      or exists (select 1 from public.release_testers where user_id = auth.uid())
    );
$$;

create or replace function public.admin_list_release_testers()
returns table (user_id uuid, email text, added_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  return query
  select tester.user_id, users.email::text, tester.added_at
  from public.release_testers tester
  join auth.users users on users.id = tester.user_id
  order by tester.added_at;
end;
$$;

create or replace function public.admin_add_release_tester(p_email text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  select users.id into target
  from auth.users users
  where lower(users.email) = lower(btrim(coalesce(p_email, '')))
  limit 1;
  if target is null then
    raise exception 'RELEASE_TESTER_UNKNOWN_EMAIL' using errcode = 'P0002';
  end if;
  insert into public.release_testers (user_id, added_by)
  values (target, auth.uid())
  on conflict (user_id) do nothing;
  return target;
end;
$$;

create or replace function public.admin_remove_release_tester(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  delete from public.release_testers where user_id = p_user_id;
  return found;
end;
$$;

revoke all on function public.is_release_tester() from public, anon;
grant execute on function public.is_release_tester() to authenticated;
revoke all on function public.admin_list_release_testers() from public, anon;
grant execute on function public.admin_list_release_testers() to authenticated;
revoke all on function public.admin_add_release_tester(text) from public, anon;
grant execute on function public.admin_add_release_tester(text) to authenticated;
revoke all on function public.admin_remove_release_tester(uuid) from public, anon;
grant execute on function public.admin_remove_release_tester(uuid) to authenticated;
