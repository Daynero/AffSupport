create table public.team_workspace_waitlist (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now()
);

alter table public.team_workspace_waitlist enable row level security;

create or replace function public.join_team_workspace_waitlist()
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

  insert into public.team_workspace_waitlist (user_id, email)
  select profile.id, profile.email
  from public.profiles profile
  where profile.id = caller and profile.email is not null
  on conflict (user_id) do nothing;

  if not exists (select 1 from public.team_workspace_waitlist entry where entry.user_id = caller) then
    raise exception 'Profile email is required' using errcode = '23502';
  end if;

  return true;
end;
$$;

create or replace function public.admin_list_team_workspace_waitlist()
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
  from public.team_workspace_waitlist entry
  order by entry.created_at desc;
end;
$$;

revoke all on table public.team_workspace_waitlist from public, anon, authenticated;
revoke all on function public.join_team_workspace_waitlist() from public, anon;
grant execute on function public.join_team_workspace_waitlist() to authenticated;
revoke all on function public.admin_list_team_workspace_waitlist() from public, anon;
grant execute on function public.admin_list_team_workspace_waitlist() to authenticated;

-- The UI gate is backed by the database: only a confirmed product admin may
-- create the pilot team. Invited members retain access through team membership.
create or replace function public.create_team(p_name text)
returns table (
  id uuid,
  name text,
  role text,
  permissions jsonb,
  connection_state text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  normalized_name text := btrim(p_name);
  created_id uuid;
begin
  if not private.team_profile_active(actor) then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if not public.is_admin() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if normalized_name is null or char_length(normalized_name) not between 1 and 120 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(actor::text, 0));
  if exists (
    select 1
    from public.team_members member
    join public.teams team on team.id = member.team_id
    where member.user_id = actor
      and member.status = 'active'
      and team.status = 'active'
      and lower(btrim(team.name)) = lower(normalized_name)
  ) then
    raise exception 'NAME_CONFLICT' using errcode = '23505';
  end if;

  insert into public.teams (name, owner_id)
  values (normalized_name, actor)
  returning teams.id into created_id;

  insert into public.team_members (team_id, user_id, base_role)
  values (created_id, actor, 'admin');

  perform private.record_team_audit(
    created_id, actor, 'team.created', '{}'::jsonb, 'succeeded', null
  );

  return query
  select created_id,
         normalized_name,
         'owner'::text,
         private.effective_permissions(created_id, actor),
         'none'::text;
end;
$$;
