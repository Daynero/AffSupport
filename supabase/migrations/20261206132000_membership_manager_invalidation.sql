-- 036: accepting an invitation must invalidate the already-open manager view.
-- Reuse own-row revisions; never publish another member's identity or permissions.
begin;
create function private.bump_membership_access_signals(p_team uuid, p_affected_user uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.teams where id=p_team) then return; end if;
  insert into public.team_membership_access_signals(team_id,user_id)
  select p_team, recipient.user_id from (
    select team.owner_id as user_id
      from public.teams team join auth.users person on person.id=team.owner_id
      where team.id=p_team
    union
    select member.user_id from public.team_members member
      where member.team_id=p_team and member.status='active'
        and coalesce((private.effective_permissions(p_team,member.user_id)->>'manage_members')::boolean,false)
    union
    select p_affected_user where p_affected_user is not null
      and exists(select 1 from auth.users where id=p_affected_user)
  ) recipient
  -- All fan-out writers take shared recipient rows in the same order.
  order by recipient.user_id
  on conflict(team_id,user_id) do update
    set revision=public.team_membership_access_signals.revision+1,
        changed_at=clock_timestamp();
end;
$$;
revoke all on function private.bump_membership_access_signals(uuid,uuid) from public,anon,authenticated;

create or replace function private.signal_membership_access_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='UPDATE' and new.status is not distinct from old.status
    and new.base_role is not distinct from old.base_role
    and new.permission_overrides is not distinct from old.permission_overrides then return null; end if;
  if tg_op='DELETE' then
    perform private.bump_membership_access_signals(old.team_id,old.user_id);
  else
    perform private.bump_membership_access_signals(new.team_id,new.user_id);
  end if;
  return null;
end;
$$;
revoke all on function private.signal_membership_access_change() from public,anon,authenticated;

create function private.signal_membership_invitation_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='UPDATE' and new.state is not distinct from old.state
    and new.initial_role is not distinct from old.initial_role
    and new.expires_at is not distinct from old.expires_at
    and new.target_email is not distinct from old.target_email
    and new.target_user_id is not distinct from old.target_user_id then return null; end if;
  perform private.bump_membership_access_signals(
    case when tg_op='DELETE' then old.team_id else new.team_id end,null
  );
  return null;
end;
$$;
revoke all on function private.signal_membership_invitation_change() from public,anon,authenticated;
create trigger membership_invitation_changed
  after insert or update of state,initial_role,expires_at,target_email,target_user_id or delete
  on public.team_invitations for each row execute function private.signal_membership_invitation_change();
commit;
