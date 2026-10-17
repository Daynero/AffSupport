-- Explicit retry retains the frozen inputs and every prior child checkpoint.
alter table private.launch_restitch_preparations add column process_attempt integer not null default 1 check(process_attempt between 1 and 100);
create function public.retry_launch_restitch(p_team uuid,p_generation uuid,p_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;l public.team_launches%rowtype;r public.team_launch_revisions%rowtype;
 p private.launch_restitch_preparations%rowtype;o public.team_operations%rowtype;payload jsonb:=jsonb_build_array(p_generation);replay jsonb;result jsonb;fresh jsonb;
begin
 perform private.launch_access(p_team,'edit');
 if not private.can(p_team,'download',auth.uid()) or not private.can(p_team,'upload',auth.uid()) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 replay:=private.launch_request(p_team,p_key,'restitch-retry',payload);if replay is not null then return replay;end if;
 select * into l from public.team_launches where id=(select launch_id from public.team_launch_generations where id=p_generation and team_id=p_team) and archived_at is null for update;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 if g.id is null or l.id is null or g.actor_id is distinct from auth.uid() then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if g.state<>'failed' or g.stage<>'restitch_processing' then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into p from private.launch_restitch_preparations where generation_id=g.id for update;
 select * into o from public.team_operations where id=p.operation_id and team_id=p_team for update;
 if o.id is null or o.state not in('failed','canceled') or p.process_attempt>=100 then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into r from public.team_launch_revisions where id=g.revision_id;
 fresh:=private.launch_sources_from_config(p_team,r.config,auth.uid());
 if private.launch_material_identity(fresh) is null or private.launch_material_identity(fresh) is distinct from private.launch_material_identity(r.sources) then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 update private.launch_restitch_preparations set process_attempt=process_attempt+1,
  process_key='launch-restitch:'||g.id::text||':'||(process_attempt+1)::text,operation_id=null,updated_at=clock_timestamp() where generation_id=g.id returning * into p;
 update public.team_launch_generations set state='waiting_dependency',stage='restitch_preparing',safe_error_code=null,retryable=false,
  lease_owner=null,lease_expires_at=null,next_attempt_at=null,fence=fence+1,state_version=state_version+1,updated_at=clock_timestamp() where id=g.id;
 result:=jsonb_build_object('generationId',g.id,'processKey',p.process_key);
 perform private.launch_signal(p_team,g.launch_id,l.aggregate_version);
 perform private.launch_remember(p_team,p_key,'restitch-retry',payload,result);
 return result;
end $$;
revoke all on function public.retry_launch_restitch(uuid,uuid,text) from public,anon;
grant execute on function public.retry_launch_restitch(uuid,uuid,text) to authenticated;
create or replace function public.bind_launch_restitch(p_team uuid,p_generation uuid,p_operation uuid) returns void
language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;l public.team_launches%rowtype;r public.team_launch_revisions%rowtype;
 preparation private.launch_restitch_preparations%rowtype;operation public.team_operations%rowtype;intent private.team_operation_intents%rowtype;
begin
 perform private.launch_access(p_team,'edit');
 select * into l from public.team_launches where id=(select launch_id from public.team_launch_generations where id=p_generation and team_id=p_team) for update;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 if g.id is null or l.id is null or l.archived_at is not null then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 if g.actor_id<>auth.uid() then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if g.state<>'waiting_dependency' then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into r from public.team_launch_revisions where id=g.revision_id;
 select * into preparation from private.launch_restitch_preparations where generation_id=g.id for update;
 select * into operation from public.team_operations where id=p_operation and team_id=p_team and actor_id=g.actor_id for update;
 select * into intent from private.team_operation_intents where operation_id=p_operation and team_id=p_team;
 if preparation.generation_id is null or operation.id is null or intent.operation_id is null or operation.kind<>'process' or intent.tool_id is distinct from 'restitch' or intent.tool_contract_version is distinct from preparation.contract_version
  or operation.source_material_id is distinct from (r.config->>'materialId')::uuid or operation.idempotency_key<>preparation.process_key then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if preparation.operation_id is not null and preparation.operation_id<>p_operation then raise exception 'LAUNCH_VERSION_CONFLICT' using errcode='40001';end if;
 update private.launch_restitch_preparations set operation_id=p_operation,updated_at=clock_timestamp() where generation_id=g.id;
 insert into public.team_launch_generation_steps(team_id,generation_id,stage,stable_step_key,state,team_operation_id,fence)
  values(p_team,g.id,'restitch_processing','restitch_processing:'||preparation.process_attempt::text,case when operation.state='succeeded' then 'succeeded' else 'running' end,p_operation,g.fence)
  on conflict(generation_id,stable_step_key) do update set team_operation_id=excluded.team_operation_id,state=excluded.state,updated_at=clock_timestamp();
 update public.team_launch_generations set stage='restitch_processing',state_version=state_version+1,updated_at=clock_timestamp() where id=g.id;
 perform private.launch_signal(p_team,g.launch_id,l.aggregate_version);
end $$;
