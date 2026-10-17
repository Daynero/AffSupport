-- Support a user-centered random duration window for launch restitching.
create or replace function private.validate_launch_defaults_row() returns trigger language plpgsql security definer set search_path='' as $$
declare k text;v jsonb;limit_value numeric;c jsonb;begin
 if jsonb_typeof(new.config) is distinct from 'object' or jsonb_typeof(new.sub_config) is distinct from 'object' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 for k,v in select key,value from jsonb_each(new.config) loop
  if k not in('buyerId','campaignCount','maxBudget','adsCount','age','gender','method','advantagePlus','catalog') then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  if k in('campaignCount','maxBudget','adsCount','age') then
   limit_value:=case k when 'campaignCount' then 100 when 'maxBudget' then 999999 when 'adsCount' then 1000 else 9007199254740991 end;
   if jsonb_typeof(v) is distinct from 'number' or v::text !~ '^[0-9]+$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
   if (v::text)::numeric not between 1 and limit_value then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  elsif k='gender' and v#>>'{}' not in('M','W','ALL') or k='method' and v#>>'{}' not in('catalog','other') or k='advantagePlus' and jsonb_typeof(v) is distinct from 'boolean' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 end loop;
 if new.config ? 'gender' and jsonb_typeof(new.config->'gender') is distinct from 'string' or new.config ? 'method' and jsonb_typeof(new.config->'method') is distinct from 'string' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if new.config ? 'buyerId' and (jsonb_typeof(new.config->'buyerId') is distinct from 'string' or not exists(select 1 from public.team_launch_buyers where team_id=new.team_id and id::text=new.config->>'buyerId' and archived_at is null)) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 c:=new.config->'catalog';
 if c is not null then
  if jsonb_typeof(c) is distinct from 'object' or jsonb_typeof(c->'productCount') is distinct from 'number' or c->>'productCount' !~ '^[0-9]+$' or jsonb_typeof(c->'restitchEnabled') is distinct from 'boolean' or jsonb_typeof(c->'finalDurationMode') is distinct from 'string' or c->>'finalDurationMode' not in('random-30-40','random-40-50','random-50-60','random-centered','custom') then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  if (c->>'productCount')::numeric not between 1 and 400 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  if c->'customFinalDurationSeconds' is distinct from 'null'::jsonb then
   if jsonb_typeof(c->'customFinalDurationSeconds') is distinct from 'number' or c->>'customFinalDurationSeconds' !~ '^[0-9]+$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
   if (c->>'customFinalDurationSeconds')::numeric not between 60 and 3600 or mod((c->>'customFinalDurationSeconds')::numeric,60)<>0 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  elsif c->>'finalDurationMode' in('custom','random-centered') and c->>'restitchEnabled'='true' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 end if;
 if new.sub_config->'schemaVersion' is distinct from '1'::jsonb then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 for k in select unnest(array['sub1','sub2','sub3']) loop
  if jsonb_typeof(new.sub_config->k) is distinct from 'array' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  if jsonb_array_length(new.sub_config->k)>4 or exists(select 1 from jsonb_array_elements(new.sub_config->k) x where jsonb_typeof(x) is distinct from 'string' or x#>>'{}' not in('buyer','social','adAccountSuffix','creative')) or (select count(*)<>count(distinct x) from jsonb_array_elements(new.sub_config->k) x) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 end loop;
 return new;
end $$;
create or replace function public.prepare_launch_restitch(p_team uuid,p_generation uuid,p_exclude uuid[] default '{}') returns jsonb
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
  if settings is null or settings->>'configured'<>'true' then raise exception 'RESTITCH_INVALID' using errcode='22023';end if;
  settings:=settings||jsonb_build_object('operation','restitch','finalDurationMode',r.config->'catalog'->>'finalDurationMode',
   'customFinalDurationSeconds',case when r.config->'catalog'->>'finalDurationMode' in('custom','random-centered') then r.config->'catalog'->'customFinalDurationSeconds' else settings->'customFinalDurationSeconds' end);
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
