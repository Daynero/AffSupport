-- New clients bind the group acceptance to the actor who initiated the request.
-- Existing group-owned prepare/mark RPCs retain their original authorization.
begin;
create function public.start_team_bulk_trash_as_actor(
  p_team uuid, p_group uuid, p_materials uuid[], p_expected_actor uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or p_expected_actor is distinct from auth.uid() then
    raise exception 'PERMISSION_DENIED' using errcode='42501';
  end if;
  return public.start_team_bulk_trash(p_team,p_group,p_materials);
end $$;
revoke all on function public.start_team_bulk_trash_as_actor(uuid,uuid,uuid[],uuid)
  from public,anon,authenticated;
grant execute on function public.start_team_bulk_trash_as_actor(uuid,uuid,uuid[],uuid)
  to authenticated;
notify pgrst,'reload schema';
commit;
