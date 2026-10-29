-- An explicit parent retry is distinct from step history and worker refreshes.
alter function public.get_launch(uuid,uuid,uuid) rename to get_launch_without_progress_attempt;
alter function public.get_launch_without_progress_attempt(uuid,uuid,uuid) set schema private;
revoke all on function private.get_launch_without_progress_attempt(uuid,uuid,uuid) from public,anon,authenticated,service_role;
create function public.get_launch(p_team uuid,p_launch uuid,p_revision uuid default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;n integer;
begin
 result:=private.get_launch_without_progress_attempt(p_team,p_launch,p_revision);
 if result->'generation' is not null and result->'generation'<>'null'::jsonb then
  select attempt_no into n from public.team_launch_generations where team_id=p_team and id=(result->'generation'->>'id')::uuid;
  if n is not null then result:=jsonb_set(result,'{generation,attemptNo}',to_jsonb(n));end if;
 end if;
 return result;
end $$;
revoke all on function public.get_launch(uuid,uuid,uuid) from public,anon;
grant execute on function public.get_launch(uuid,uuid,uuid) to authenticated;
