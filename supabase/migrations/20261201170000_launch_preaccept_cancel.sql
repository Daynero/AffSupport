-- A canceled request must remain canceled even if its acceptance reply was lost.
create table private.launch_canceled_requests (
 team_id uuid not null references public.teams(id) on delete cascade,
 request_key text not null,
 launch_id uuid not null references public.team_launches(id) on delete cascade,
 actor_id uuid not null,
 created_at timestamptz not null default clock_timestamp(),
 primary key(team_id,request_key)
);
revoke all on private.launch_canceled_requests from public,anon,authenticated;

-- Keep the existing acceptance implementation and add only the request fence.
alter function public.service_accept_launch_generation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb)
 rename to service_accept_launch_generation_unfenced;
revoke all on function public.service_accept_launch_generation_unfenced(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb) from public,anon,authenticated,service_role;
create function public.service_accept_launch_generation(p_team uuid,p_launch uuid,p_actor uuid,p_expected_version text,p_key text,p_digest text,p_config jsonb,p_sources jsonb,p_preview jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if p_actor is null or not private.can(p_team,'edit',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if p_key is null or p_key !~ '^[A-Za-z0-9_-]{8,200}$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_team::text||p_key,0));
 if exists(select 1 from private.launch_canceled_requests where team_id=p_team and request_key=p_key) then
  raise exception 'PROCESS_CANCELED' using errcode='55000';
 end if;
 return public.service_accept_launch_generation_unfenced(p_team,p_launch,p_actor,p_expected_version,p_key,p_digest,p_config,p_sources,p_preview);
end $$;
revoke all on function public.service_accept_launch_generation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.service_accept_launch_generation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb) to service_role;

create function public.cancel_launch_request(p_team uuid,p_launch uuid,p_key text,p_cancel_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;l public.team_launches%rowtype;c private.launch_canceled_requests%rowtype;result jsonb;
begin
 perform private.launch_access(p_team,'edit');
 if p_key is null or p_key !~ '^[A-Za-z0-9_-]{8,200}$' or p_cancel_key is null or p_cancel_key !~ '^[A-Za-z0-9_-]{8,200}$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 -- Same lock and order as acceptance: request, aggregate, generation.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_team::text||p_key,0));
 select * into l from public.team_launches where team_id=p_team and id=p_launch and archived_at is null for update;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 select * into c from private.launch_canceled_requests where team_id=p_team and request_key=p_key;
 if found then
  if c.launch_id<>p_launch or c.actor_id<>auth.uid() then raise exception 'LAUNCH_VERSION_CONFLICT' using errcode='40001';end if;
  return jsonb_build_object('state','canceled','launchId',p_launch);
 end if;
 select * into g from public.team_launch_generations where team_id=p_team and request_key=p_key for update;
 if found then
  if g.launch_id<>p_launch or g.actor_id<>auth.uid() then raise exception 'LAUNCH_VERSION_CONFLICT' using errcode='40001';end if;
  -- A committed success wins. Existing parent/child cancellation owns cleanup.
  return public.cancel_launch_generation(p_team,p_launch,g.id,p_cancel_key);
 end if;
 insert into private.launch_canceled_requests(team_id,request_key,launch_id,actor_id) values(p_team,p_key,p_launch,auth.uid());
 return jsonb_build_object('state','canceled','launchId',p_launch);
end $$;
revoke all on function public.cancel_launch_request(uuid,uuid,text,text) from public,anon;
grant execute on function public.cancel_launch_request(uuid,uuid,text,text) to authenticated;
