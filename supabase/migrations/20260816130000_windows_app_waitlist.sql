create table public.windows_app_waitlist (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now()
);

alter table public.windows_app_waitlist enable row level security;
alter table public.windows_app_waitlist force row level security;

create or replace function public.join_windows_app_waitlist()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  insert into public.windows_app_waitlist (user_id, email)
  select profile.id, profile.email
  from public.profiles profile
  where profile.id = caller and profile.email is not null
  on conflict (user_id) do nothing;

  if not exists (select 1 from public.windows_app_waitlist entry where entry.user_id = caller) then
    raise exception 'Profile email is required' using errcode = '23502';
  end if;

  return true;
end;
$$;

create or replace function public.admin_list_windows_app_waitlist()
returns table (user_id uuid, email text, created_at timestamptz)
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
  select entry.user_id, entry.email, entry.created_at
  from public.windows_app_waitlist entry
  order by entry.created_at desc;
end;
$$;

revoke all on table public.windows_app_waitlist from public, anon, authenticated;
revoke all on function public.join_windows_app_waitlist() from public, anon;
grant execute on function public.join_windows_app_waitlist() to authenticated;
revoke all on function public.admin_list_windows_app_waitlist() from public, anon;
grant execute on function public.admin_list_windows_app_waitlist() to authenticated;
