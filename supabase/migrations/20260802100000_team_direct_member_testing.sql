-- Temporary service-only membership creation for the explicitly enabled pilot flow.
-- The Edge function must first complete caller-scoped lookup_invitable_account authorization.

create or replace function public.service_direct_add_registered_member(
  p_actor uuid,
  p_team uuid,
  p_email text,
  p_base_role text
)
returns table (
  membership_id uuid,
  user_id uuid,
  display_name text,
  email text,
  role text,
  base_role text,
  permission_overrides jsonb,
  effective_permissions jsonb,
  joined_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  canonical_email extensions.citext := lower(btrim(p_email))::extensions.citext;
  target_user uuid;
begin
  if p_actor is null
     or p_team is null
     or canonical_email is null
     or char_length(canonical_email::text) not between 3 and 320
     or position('@' in canonical_email::text) <= 1
     or p_base_role not in ('admin', 'editor', 'viewer') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  perform 1
  from public.teams as team
  where team.id = p_team
    and team.status = 'active'
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  if not private.can(p_team, 'manage_members', p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  select users.id
    into target_user
  from auth.users as users
  join public.profiles as profile on profile.id = users.id
  where users.email_confirmed_at is not null
    and profile.account_status = 'active'
    and lower(btrim(users.email)) = canonical_email::text
  limit 1;
  if target_user is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  if exists (
    select 1
    from public.team_members as member
    where member.team_id = p_team
      and member.user_id = target_user
      and member.status = 'active'
  ) then
    raise exception 'ALREADY_MEMBER' using errcode = '23505';
  end if;

  if (
    select count(*)
    from public.team_members as member
    where member.team_id = p_team
      and member.status = 'active'
  ) >= 50 then
    raise exception 'TEAM_MEMBER_LIMIT' using errcode = '22023';
  end if;

  insert into public.team_members (team_id, user_id, base_role)
  values (p_team, target_user, p_base_role);

  update public.team_invitations as invitation
  set state = 'revoked',
      responded_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where invitation.team_id = p_team
    and invitation.state = 'pending'
    and (
      invitation.target_user_id = target_user
      or invitation.target_email = canonical_email
    );

  perform private.record_team_audit(
    p_team,
    p_actor,
    'membership.direct_added',
    jsonb_build_object('member_id', target_user, 'role', p_base_role),
    'succeeded',
    null
  );

  return query
  select member.id,
         member.user_id,
         profile.display_name,
         lower(btrim(users.email)),
         member.base_role,
         member.base_role,
         member.permission_overrides,
         private.effective_permissions(p_team, target_user),
         member.joined_at
  from public.team_members as member
  join public.profiles as profile on profile.id = member.user_id
  join auth.users as users on users.id = member.user_id
  where member.team_id = p_team
    and member.user_id = target_user
    and member.status = 'active';
end;
$$;

revoke all on function public.service_direct_add_registered_member(uuid, uuid, text, text)
from public, anon, authenticated, service_role;
grant execute on function public.service_direct_add_registered_member(uuid, uuid, text, text)
to service_role;

comment on function public.service_direct_add_registered_member(uuid, uuid, text, text) is
  'Service-only temporary pilot membership add after caller-scoped Edge authorization.';
