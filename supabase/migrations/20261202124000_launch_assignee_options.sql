-- Launch assignment needs active member labels for every viewer/editor, while
-- list_team_members deliberately exposes emails and permission details only
-- to member managers. Keep this projection narrow and team-scoped.
create function public.list_launch_assignees(p_team uuid)
returns table(user_id uuid, display_name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.launch_access(p_team, 'view');
  return query
  select member.user_id, profile.display_name
  from public.team_members as member
  join public.profiles as profile on profile.id = member.user_id
  where member.team_id = p_team and member.status = 'active'
  order by lower(coalesce(profile.display_name, member.user_id::text)), member.user_id;
end;
$$;

revoke all on function public.list_launch_assignees(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_launch_assignees(uuid) to authenticated;
