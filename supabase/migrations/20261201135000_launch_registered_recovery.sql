-- A lost parent reply must not recreate a successfully registered child catalog.
-- Only the exact generation's journal can settle it; never use the latest catalog.
create function public.service_restore_registered_launch_catalog(
 p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text
) returns boolean language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;
begin
 if p_actor is null or not private.can(p_team,'edit',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team;
 if not exists(select 1 from private.catalog_generation_intents i
   where i.team_id=p_team and i.actor_id=p_actor
   and i.request_key='launch:'||g.id::text||':catalog' and i.state='registered') then
  return false;
 end if;
 perform public.service_attach_launch_catalog(p_team,p_generation,p_actor,p_owner,p_fence);
 return true;
end $$;
revoke all on function public.service_restore_registered_launch_catalog(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.service_restore_registered_launch_catalog(uuid,uuid,uuid,text,text) to service_role;
