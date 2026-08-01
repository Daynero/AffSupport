-- Caller-checked membership, ownership, audit, and account-lifecycle authority.

create or replace function public.list_team_members(p_team uuid)
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
stable
security definer
set search_path = ''
as $$
begin
  if not private.can(p_team, 'manage_members', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  return query
  select member.id,
         member.user_id,
         profile.display_name,
         case
           when users.email_confirmed_at is not null then lower(btrim(users.email))
           else null
         end,
         case when team.owner_id = member.user_id then 'owner' else member.base_role end,
         member.base_role,
         member.permission_overrides,
         private.effective_permissions(p_team, member.user_id),
         member.joined_at
  from public.team_members as member
  join public.teams as team
    on team.id = member.team_id
   and team.status = 'active'
  join public.profiles as profile on profile.id = member.user_id
  join auth.users as users on users.id = member.user_id
  where member.team_id = p_team
    and member.status = 'active'
  order by (team.owner_id = member.user_id) desc,
           lower(coalesce(profile.display_name, users.email, member.user_id::text)),
           member.id;
end;
$$;

revoke all on function public.list_team_members(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.list_team_members(uuid) to authenticated;

create or replace function public.update_membership(
  p_team uuid,
  p_member uuid,
  p_base_role text default null,
  p_overrides jsonb default null
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
  actor uuid := auth.uid();
  canonical_owner uuid;
  resolved_role text;
  resolved_overrides jsonb;
begin
  if not private.can(p_team, 'manage_members', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  select team.owner_id
    into canonical_owner
  from public.teams as team
  where team.id = p_team and team.status = 'active'
  for update;
  if canonical_owner is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_member = canonical_owner then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  select coalesce(p_base_role, member.base_role),
         coalesce(p_overrides, member.permission_overrides)
    into resolved_role, resolved_overrides
  from public.team_members as member
  where member.team_id = p_team
    and member.user_id = p_member
    and member.status = 'active'
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  if resolved_role not in ('admin', 'editor', 'viewer')
     or jsonb_typeof(resolved_overrides) <> 'object'
     or exists (
       select 1
       from jsonb_each(resolved_overrides) as override_entry(key, value)
       where jsonb_typeof(override_entry.value) <> 'boolean'
          or not exists (
            select 1
            from public.team_permissions as permission
            where permission.permission = override_entry.key
          )
     ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  update public.team_members as member
  set base_role = resolved_role,
      permission_overrides = resolved_overrides,
      updated_at = clock_timestamp()
  where member.team_id = p_team
    and member.user_id = p_member
    and member.status = 'active';

  perform private.record_team_audit(
    p_team,
    actor,
    'membership.updated',
    jsonb_build_object('member_id', p_member, 'role', resolved_role),
    'succeeded',
    null
  );

  return query
  select member.id,
         member.user_id,
         profile.display_name,
         case
           when users.email_confirmed_at is not null then lower(btrim(users.email))
           else null
         end,
         resolved_role,
         member.base_role,
         member.permission_overrides,
         private.effective_permissions(p_team, p_member),
         member.joined_at
  from public.team_members as member
  join public.profiles as profile on profile.id = member.user_id
  join auth.users as users on users.id = member.user_id
  where member.team_id = p_team
    and member.user_id = p_member
    and member.status = 'active';
end;
$$;

revoke all on function public.update_membership(uuid, uuid, text, jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.update_membership(uuid, uuid, text, jsonb) to authenticated;

create or replace function public.remove_member(p_team uuid, p_member uuid)
returns table (ok boolean, warning_code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  canonical_owner uuid;
begin
  if not private.can(p_team, 'manage_members', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  select team.owner_id
    into canonical_owner
  from public.teams as team
  where team.id = p_team and team.status = 'active'
  for update;
  if canonical_owner is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_member = canonical_owner then
    raise exception 'OWNER_TRANSFER_REQUIRED' using errcode = '42501';
  end if;

  perform 1
  from public.team_members as member
  where member.team_id = p_team
    and member.user_id = p_member
    and member.status = 'active'
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.team_members as member
  set status = 'removed',
      removed_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where member.team_id = p_team
    and member.user_id = p_member
    and member.status = 'active';

  perform private.revoke_team_transfer_grants(p_team, p_member);
  perform private.record_team_audit(
    p_team,
    actor,
    'membership.removed',
    jsonb_build_object(
      'member_id', p_member,
      'warning_code', 'EXTERNAL_DRIVE_ACCESS_REMAINS'
    ),
    'succeeded',
    null
  );

  return query select true, 'EXTERNAL_DRIVE_ACCESS_REMAINS'::text;
end;
$$;

revoke all on function public.remove_member(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.remove_member(uuid, uuid) to authenticated;

create or replace function public.transfer_ownership(
  p_team uuid,
  p_to_user uuid,
  p_demote_to text
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
  resolved_name text;
begin
  if actor is null
     or p_to_user is null
     or p_to_user = actor
     or p_demote_to not in ('admin', 'editor', 'viewer') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  select team.name
    into resolved_name
  from public.teams as team
  where team.id = p_team
    and team.owner_id = actor
    and team.status = 'active'
  for update;
  if resolved_name is null then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  perform 1
  from public.team_members as member
  where member.team_id = p_team
    and member.user_id = p_to_user
    and member.status = 'active'
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  perform 1
  from public.team_members as member
  where member.team_id = p_team
    and member.user_id = actor
    and member.status = 'active'
  for update;
  if not found then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  update public.team_members as member
  set base_role = p_demote_to,
      permission_overrides = '{}'::jsonb,
      updated_at = clock_timestamp()
  where member.team_id = p_team
    and member.user_id = actor
    and member.status = 'active';

  update public.teams as team
  set owner_id = p_to_user,
      updated_at = clock_timestamp()
  where team.id = p_team;

  perform private.revoke_team_transfer_grants(p_team, actor);
  perform private.record_team_audit(
    p_team,
    actor,
    'ownership.transferred',
    jsonb_build_object('member_id', p_to_user, 'role', p_demote_to),
    'succeeded',
    null
  );

  return query
  select p_team,
         resolved_name,
         p_demote_to,
         private.effective_permissions(p_team, actor),
         coalesce(connection.state, 'none')
  from (select 1) as singleton
  left join lateral (
    select drive.state
    from public.team_drive_connections as drive
    where drive.team_id = p_team
      and drive.state <> 'detached'
    order by drive.created_at desc
    limit 1
  ) as connection on true;
end;
$$;

revoke all on function public.transfer_ownership(uuid, uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.transfer_ownership(uuid, uuid, text) to authenticated;

create or replace function public.list_team_audit_events(
  p_team uuid,
  p_limit integer default 50,
  p_before timestamptz default null
)
returns table (
  id uuid,
  actor_label text,
  action text,
  target jsonb,
  result text,
  error_code text,
  occurred_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller_role text := private.team_role(p_team, auth.uid());
begin
  if caller_role not in ('owner', 'admin') then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  return query
  select event.id,
         event.actor_label_snapshot,
         event.action,
         event.target,
         event.result,
         event.error_code,
         event.occurred_at
  from public.team_audit_events as event
  where event.team_id = p_team
    and (p_before is null or event.occurred_at < p_before)
  order by event.occurred_at desc, event.id desc
  limit p_limit;
end;
$$;

revoke all on function public.list_team_audit_events(uuid, integer, timestamptz)
from public, anon, authenticated, service_role;
grant execute on function public.list_team_audit_events(uuid, integer, timestamptz)
to authenticated;

create or replace function public.owned_team_count(p_user uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.teams as team
  where p_user is not null
    and team.owner_id = p_user;
$$;

revoke all on function public.owned_team_count(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.owned_team_count(uuid) to service_role;

create or replace function public.service_revoke_user_team_grants(p_user uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  if p_user is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update private.team_transfer_grants as grant_row
  set revoked_at = clock_timestamp()
  where grant_row.actor_id = p_user
    and grant_row.revoked_at is null;
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.service_revoke_user_team_grants(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.service_revoke_user_team_grants(uuid) to service_role;
