-- Retry checkpoints must not fabricate completion of later stages.
create or replace function public.service_touch_launch_generation(p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text,p_stage text) returns void language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;l public.team_launches%rowtype;begin
 if p_actor is null or not private.can(p_team,'edit',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into l from public.team_launches where id=(select launch_id from public.team_launch_generations where id=p_generation and team_id=p_team) and archived_at is null for update;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 if g.id is null or l.id is null or g.actor_id<>p_actor or g.state<>'running' or g.lease_owner<>p_owner or g.fence::text<>p_fence or g.lease_expires_at<=clock_timestamp() then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 if p_stage not in('preparing','catalog_planning','catalog_creating','catalog_sharing','catalog_registering','result_committing') then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 insert into public.team_launch_generation_steps(team_id,generation_id,stage,stable_step_key,state,fence) values(p_team,g.id,p_stage,p_stage,'running',g.fence) on conflict(generation_id,stable_step_key) do update set state=case when team_launch_generation_steps.state='succeeded' then 'succeeded' else 'running' end,fence=g.fence,updated_at=clock_timestamp();
 -- A later checkpoint can complete earlier running stages. Re-entry during
 -- recovery is not evidence that a later stage finished, and auxiliary steps
 -- (resource snapshots, native work) own their settlement independently.
 update public.team_launch_generation_steps set state='succeeded',updated_at=clock_timestamp()
 where generation_id=g.id and state='running'
 and array_position(array['preparing','catalog_planning','catalog_creating','catalog_sharing','catalog_registering','result_committing'],stage)
   < array_position(array['preparing','catalog_planning','catalog_creating','catalog_sharing','catalog_registering','result_committing'],p_stage);
 update public.team_launch_generations set stage=p_stage,state_version=state_version+1,lease_expires_at=clock_timestamp()+interval '180 seconds',next_attempt_at=clock_timestamp()+interval '180 seconds',updated_at=clock_timestamp() where id=g.id;
 perform private.launch_signal(p_team,l.id,l.aggregate_version);
end $$;
