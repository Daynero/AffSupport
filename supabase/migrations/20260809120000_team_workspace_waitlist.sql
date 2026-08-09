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

-- A user may enter only an admin-designated space. This deliberately does not
-- use "has any team": older self-created teams must not unlock the pilot.
create or replace function private.team_workspace_allowed(p_team uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.team_members admin_member
    join public.admin_users workspace_admin on workspace_admin.user_id = admin_member.user_id
    join public.teams team on team.id = admin_member.team_id
    where admin_member.team_id = p_team
      and admin_member.status = 'active'
      and team.status = 'active'
  );
$$;

revoke all on function private.team_workspace_allowed(uuid) from public, anon;
revoke all on function private.team_workspace_allowed(uuid) from authenticated, service_role;

create or replace function public.can_access_team_workspace()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_admin()
    or exists (
      select 1
      from public.team_members member
      join public.teams team on team.id = member.team_id
      where member.user_id = auth.uid()
        and member.status = 'active'
        and team.status = 'active'
        and exists (
          select 1
          from public.team_members admin_member
          join public.admin_users workspace_admin on workspace_admin.user_id = admin_member.user_id
          where admin_member.team_id = team.id
            and admin_member.status = 'active'
        )
    );
$$;

revoke all on function public.can_access_team_workspace() from public, anon;
grant execute on function public.can_access_team_workspace() to authenticated;

-- Every existing team RPC and RLS policy flows through private.can(). Adding
-- the workspace owner check here closes direct API access as well as the UI.
create or replace function private.can(
  p_team uuid,
  p_flag text,
  p_user uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_user is null then false
    when auth.uid() is not null and p_user is distinct from auth.uid() then false
    when not private.team_workspace_allowed(p_team) then false
    when not exists (
      select 1
      from public.team_permissions permission
      where permission.permission = p_flag
    ) then false
    else coalesce((private.effective_permissions(p_team, p_user) ->> p_flag)::boolean, false)
  end;
$$;

create or replace function public.list_my_teams()
returns table (
  id uuid,
  name text,
  role text,
  permissions jsonb,
  connection_state text
)
language sql
stable
security definer
set search_path = ''
as $$
  select team.id,
         team.name,
         case when team.owner_id = auth.uid() then 'owner' else member.base_role end,
         private.effective_permissions(team.id, auth.uid()),
         coalesce(connection.state, 'none')
  from public.team_members member
  join public.teams team
    on team.id = member.team_id
   and team.status = 'active'
  left join lateral (
    select drive.state
    from public.team_drive_connections drive
    where drive.team_id = team.id
      and drive.state <> 'detached'
    order by drive.created_at desc
    limit 1
  ) connection on true
  where auth.uid() is not null
    and private.team_profile_active(auth.uid())
    and member.user_id = auth.uid()
    and member.status = 'active'
    and exists (
      select 1
      from public.team_members admin_member
      join public.admin_users workspace_admin on workspace_admin.user_id = admin_member.user_id
      where admin_member.team_id = team.id
        and admin_member.status = 'active'
    )
  order by team.created_at, team.id;
$$;

create or replace function public.accept_invitation(
  p_invitation uuid,
  p_plain_token text default null
)
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
  invitation_row public.team_invitations%rowtype;
  resolved_name text;
  resolved_connection_state text;
begin
  select invitation.* into invitation_row
  from public.team_invitations invitation
  where invitation.id = p_invitation
  for update;
  if invitation_row.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.team_invitation_identity_matches(invitation_row, actor, p_plain_token) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if invitation_row.state <> 'pending' or invitation_row.expires_at <= clock_timestamp() then
    if invitation_row.state = 'pending' then
      update public.team_invitations set state = 'expired', responded_at = clock_timestamp()
      where team_invitations.id = invitation_row.id;
    end if;
    raise exception 'EXPIRED' using errcode = '22023';
  end if;

  perform 1 from public.teams team
  where team.id = invitation_row.team_id and team.status = 'active'
  for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.team_workspace_allowed(invitation_row.team_id) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.team_members member
    where member.team_id = invitation_row.team_id
      and member.user_id = actor
      and member.status = 'active'
  ) then
    raise exception 'ALREADY_MEMBER' using errcode = '23505';
  end if;
  if (
    select count(*) from public.team_members member
    where member.team_id = invitation_row.team_id and member.status = 'active'
  ) >= 50 then
    raise exception 'TEAM_MEMBER_LIMIT' using errcode = '22023';
  end if;

  insert into public.team_members (team_id, user_id, base_role)
  values (invitation_row.team_id, actor, invitation_row.initial_role);
  update public.team_invitations
  set state = 'accepted', responded_at = clock_timestamp()
  where team_invitations.id = invitation_row.id;
  perform private.record_team_audit(
    invitation_row.team_id,
    actor,
    'invitation.accepted',
    jsonb_build_object('invitation_id', invitation_row.id, 'role', invitation_row.initial_role),
    'succeeded',
    null
  );

  select team.name into resolved_name
  from public.teams team where team.id = invitation_row.team_id;
  select coalesce(connection.state, 'none') into resolved_connection_state
  from (select 1) singleton
  left join lateral (
    select drive.state
    from public.team_drive_connections drive
    where drive.team_id = invitation_row.team_id and drive.state <> 'detached'
    order by drive.created_at desc limit 1
  ) connection on true;
  return query
  select invitation_row.team_id,
         resolved_name,
         invitation_row.initial_role,
         private.effective_permissions(invitation_row.team_id, actor),
         resolved_connection_state;
end;
$$;

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
