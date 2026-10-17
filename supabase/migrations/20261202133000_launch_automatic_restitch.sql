-- Launch restitch needs only its video and duration. Saved space defaults remain optional.
-- Update the implementation behind the failure-receipt boundary, preserving durable diagnosis.
create or replace function public.prepare_launch_restitch_unchecked(p_team uuid,p_generation uuid,p_exclude uuid[] default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;l public.team_launches%rowtype;r public.team_launch_revisions%rowtype;
 preparation private.launch_restitch_preparations%rowtype;settings jsonb;drawn jsonb;
begin
 perform private.launch_access(p_team,'edit');
 if not private.can(p_team,'download',auth.uid()) or not private.can(p_team,'upload',auth.uid()) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if p_exclude is null or cardinality(p_exclude)>2 or array_position(p_exclude,null) is not null then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select * into l from public.team_launches where id=(select launch_id from public.team_launch_generations where id=p_generation and team_id=p_team) and archived_at is null for update;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 if g.id is null or l.id is null then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 if g.actor_id<>auth.uid() then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if g.state not in('accepted','waiting_dependency','interrupted') or g.lease_expires_at>clock_timestamp() then raise exception 'LAUNCH_BUSY' using errcode='55000';end if;
 select * into r from public.team_launch_revisions where id=g.revision_id;
 if r.config->>'method'<>'catalog' or r.config->'catalog'->>'restitchEnabled'<>'true' then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into preparation from private.launch_restitch_preparations where generation_id=g.id for update;
 if not found then
  if cardinality(p_exclude)>0 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  if private.launch_restitch_settings_version(p_team,g.actor_id) is distinct from r.sources->>'restitchSettingsVersion' then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
  settings:=private.effective_restitch_defaults_json(p_team,g.actor_id);
  if settings is null or settings->>'configured' is distinct from 'true' then
   settings:=jsonb_build_object('operation','restitch','startImageIds','[]'::jsonb,'endImageIds','[]'::jsonb,
    'fitMode','cover','startEnabled',false,'endEnabled',true,'startDurationMode','one-frame',
    'customStartDurationMs',100,'sourceMode','drive','configured',true,'automaticEndFrame',true,
    'finalDurationMode','custom','customFinalDurationSeconds',2700,'updatedAt','', 'updatedBy',null);
  end if;
  settings:=settings||jsonb_build_object('operation','restitch','finalDurationMode',r.config->'catalog'->>'finalDurationMode',
   'customFinalDurationSeconds',case when r.config->'catalog'->>'finalDurationMode' in('custom','random-centered') then r.config->'catalog'->'customFinalDurationSeconds' else settings->'customFinalDurationSeconds' end);
  if r.config->'catalog'->>'finalDurationMode'='random-centered' and jsonb_typeof(r.config->'catalog'->'finalDurationRangeSeconds')='array' then
   settings:=settings||jsonb_build_object('finalDurationMode','custom','customFinalDurationSeconds',
    (r.config->'catalog'->'finalDurationRangeSeconds'->>0)::integer + floor(random()*((r.config->'catalog'->'finalDurationRangeSeconds'->>1)::integer-(r.config->'catalog'->'finalDurationRangeSeconds'->>0)::integer+1))::integer);
  end if;
  if settings->>'automaticEndFrame'='true' then
   drawn:=jsonb_build_object('sourceMode','drive','pool',jsonb_build_object('start','empty','end','empty'),'screens','[]'::jsonb);
  else
   drawn:=private.draw_restitch_screens_for(p_team,g.actor_id,settings,'{}');
  end if;
  insert into private.launch_restitch_preparations(generation_id,team_id,actor_id,defaults,draw,process_key)
   values(g.id,p_team,g.actor_id,settings,drawn,'launch-restitch:'||g.id::text||':1') returning * into preparation;
 elsif cardinality(p_exclude)>0 and preparation.excluded is distinct from p_exclude then
  if preparation.operation_id is not null or preparation.draw_attempt>=2 then raise exception 'WRONG_STATE' using errcode='55000';end if;
  drawn:=private.draw_restitch_screens_for(p_team,g.actor_id,preparation.defaults,p_exclude);
  update private.launch_restitch_preparations set draw=drawn,excluded=p_exclude,draw_attempt=draw_attempt+1,updated_at=clock_timestamp()
   where generation_id=g.id returning * into preparation;
 end if;
 update public.team_launch_generations set state='waiting_dependency',stage='restitch_preparing',lease_owner=null,lease_expires_at=null,
  next_attempt_at=null,state_version=state_version+1,updated_at=clock_timestamp() where id=g.id;
 insert into public.team_launch_generation_steps(team_id,generation_id,stage,stable_step_key,state,fence)
  values(p_team,g.id,'restitch_preparing','restitch_preparing','succeeded',g.fence) on conflict(generation_id,stable_step_key) do nothing;
 perform private.launch_signal(p_team,g.launch_id,l.aggregate_version);
 return jsonb_build_object('defaults',preparation.defaults,'draw',preparation.draw,'processKey',preparation.process_key,'operationId',preparation.operation_id);
end $$;

revoke all on function public.prepare_launch_restitch_unchecked(uuid,uuid,uuid[]) from public,anon,authenticated,service_role;
create or replace function public.prepare_launch_restitch(p_team uuid,p_generation uuid,p_exclude uuid[] default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare l public.team_launches%rowtype;g public.team_launch_generations%rowtype;code text;
begin
 perform private.launch_access(p_team,'edit');
 select * into l from public.team_launches where id=(select launch_id from public.team_launch_generations where id=p_generation and team_id=p_team) and archived_at is null for update;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 if l.id is null or g.id is null then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 if g.actor_id<>auth.uid() then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if g.state='failed' and g.stage='restitch_preparing' and g.safe_error_code in('SOURCE_CHANGED','RESTITCH_INVALID','RESTITCH_NO_SCREENS','RESTITCH_POOL_EMPTY','RESTITCH_SOURCE_FORBIDDEN','RESTITCH_SOURCES_INVALID') then
  return jsonb_build_object('errorCode',g.safe_error_code);
 end if;
 begin
  return public.prepare_launch_restitch_unchecked(p_team,p_generation,p_exclude);
 exception when others then
  code:=sqlerrm;
  if code not in('SOURCE_CHANGED','RESTITCH_INVALID','RESTITCH_NO_SCREENS','RESTITCH_POOL_EMPTY','RESTITCH_SOURCE_FORBIDDEN','RESTITCH_SOURCES_INVALID') then raise;end if;
 end;
 -- Never stop another tab's child on the basis of a preparation read failure.
 if g.state in('accepted','waiting_dependency','interrupted')
 and not exists(select 1 from private.launch_restitch_preparations p
   join public.team_operations o on o.team_id=p.team_id and (o.id=p.operation_id or o.idempotency_key=p.process_key)
   where p.generation_id=g.id)
 and not exists(select 1 from private.catalog_generation_intents i where i.team_id=p_team and i.request_key='launch:'||g.id::text||':catalog') then
  update public.team_launch_generations set state='failed',stage='restitch_preparing',safe_error_code=code,retryable=false,
   state_version=state_version+1,next_attempt_at=null,lease_owner=null,lease_expires_at=null,updated_at=clock_timestamp() where id=g.id;
  insert into public.team_launch_generation_steps(team_id,generation_id,stage,stable_step_key,state,fence,safe_error_code)
   values(p_team,g.id,'restitch_preparing','restitch_preparing','failed',g.fence,code)
   on conflict(generation_id,stable_step_key) do update set state='failed',safe_error_code=excluded.safe_error_code,updated_at=clock_timestamp();
  perform private.launch_signal(p_team,l.id,l.aggregate_version);
 end if;
 return jsonb_build_object('errorCode',code);
end $$;
revoke all on function public.prepare_launch_restitch(uuid,uuid,uuid[]) from public,anon;
grant execute on function public.prepare_launch_restitch(uuid,uuid,uuid[]) to authenticated;
