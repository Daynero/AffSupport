-- Delegate accepted cancellation before taking aggregate locks: the existing
-- cancellation seam acquires its own replay lock first.
create or replace function public.cancel_launch_request(p_team uuid,p_launch uuid,p_key text,p_cancel_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;l public.team_launches%rowtype;c private.launch_canceled_requests%rowtype;result jsonb;
begin
 perform private.launch_access(p_team,'edit');
 if p_key is null or p_key !~ '^[A-Za-z0-9_-]{8,200}$' or p_cancel_key is null or p_cancel_key !~ '^[A-Za-z0-9_-]{8,200}$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 -- Same lock and order as acceptance: request, aggregate, generation.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_team::text||p_key,0));
 select * into c from private.launch_canceled_requests where team_id=p_team and request_key=p_key;
 if found then
  if c.launch_id<>p_launch or c.actor_id<>auth.uid() then raise exception 'LAUNCH_VERSION_CONFLICT' using errcode='40001';end if;
  return jsonb_build_object('state','canceled','launchId',p_launch);
 end if;
 select * into g from public.team_launch_generations where team_id=p_team and request_key=p_key;
 if found then
  if g.launch_id<>p_launch or g.actor_id<>auth.uid() then raise exception 'LAUNCH_VERSION_CONFLICT' using errcode='40001';end if;
  -- A committed success wins. Existing parent/child cancellation owns cleanup.
  return public.cancel_launch_generation(p_team,p_launch,g.id,p_cancel_key);
 end if;
 select * into l from public.team_launches where team_id=p_team and id=p_launch and archived_at is null for update;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 insert into private.launch_canceled_requests(team_id,request_key,launch_id,actor_id) values(p_team,p_key,p_launch,auth.uid());
 return jsonb_build_object('state','canceled','launchId',p_launch);
end $$;
