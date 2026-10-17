-- Launch-owned receipt around the existing restitch pools/process mechanism. No transfer grants.
create table private.launch_restitch_preparations (
 generation_id uuid primary key,
 team_id uuid not null,actor_id uuid not null,defaults jsonb not null,draw jsonb not null,
 excluded uuid[] not null default '{}',draw_attempt integer not null default 1 check(draw_attempt between 1 and 2),
 process_key text not null,operation_id uuid references public.team_operations(id),
 foreign key(generation_id,team_id) references public.team_launch_generations(id,team_id) on delete cascade,
 contract_version integer not null default 2,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check(jsonb_typeof(defaults)='object' and jsonb_typeof(draw)='object' and octet_length(defaults::text)<65536 and octet_length(draw::text)<65536)
);
alter table private.launch_restitch_preparations enable row level security;
alter table private.launch_restitch_preparations force row level security;
revoke all on private.launch_restitch_preparations from public,anon,authenticated;
grant select,insert,update on private.launch_restitch_preparations to service_role;
create function public.prepare_launch_restitch(p_team uuid,p_generation uuid,p_exclude uuid[] default '{}') returns jsonb
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
  if settings is null or settings->>'configured'<>'true' then raise exception 'RESTITCH_DEFAULTS_INVALID' using errcode='22023';end if;
  settings:=settings||jsonb_build_object('operation','restitch','finalDurationMode',r.config->'catalog'->>'finalDurationMode',
   'customFinalDurationSeconds',case when r.config->'catalog'->>'finalDurationMode'='custom' then r.config->'catalog'->'customFinalDurationSeconds' else settings->'customFinalDurationSeconds' end);
  drawn:=private.draw_restitch_screens_for(p_team,g.actor_id,settings,'{}');
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
create function public.bind_launch_restitch(p_team uuid,p_generation uuid,p_operation uuid) returns void
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
  values(p_team,g.id,'restitch_processing','restitch_processing',case when operation.state='succeeded' then 'succeeded' else 'running' end,p_operation,g.fence)
  on conflict(generation_id,stable_step_key) do update set team_operation_id=excluded.team_operation_id,state=excluded.state,updated_at=clock_timestamp();
 update public.team_launch_generations set stage='restitch_processing',state_version=state_version+1,updated_at=clock_timestamp() where id=g.id;
 perform private.launch_signal(p_team,g.launch_id,l.aggregate_version);
end $$;
revoke all on function public.prepare_launch_restitch(uuid,uuid,uuid[]),public.bind_launch_restitch(uuid,uuid,uuid) from public,anon;
grant execute on function public.prepare_launch_restitch(uuid,uuid,uuid[]),public.bind_launch_restitch(uuid,uuid,uuid) to authenticated;
