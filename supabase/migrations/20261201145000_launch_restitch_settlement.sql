-- Settle existing local-operation receipts without starting local work or copying media.
create function private.settle_launch_restitch(p_team uuid,p_generation uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;l public.team_launches%rowtype;
 prep private.launch_restitch_preparations%rowtype;op public.team_operations%rowtype;
 material public.team_materials%rowtype;code text;
begin
 -- Same lock order as cancellation: aggregate, generation, preparation, child.
 select * into l from public.team_launches where id=(select launch_id from public.team_launch_generations where id=p_generation and team_id=p_team) for update skip locked;
 if l.id is null or l.archived_at is not null then return false;end if;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team for update skip locked;
 if g.id is null or g.state<>'waiting_dependency' then return false;end if;
 select * into prep from private.launch_restitch_preparations where generation_id=g.id for update;
 if prep.operation_id is null then return false;end if;
 select * into op from public.team_operations where id=prep.operation_id and team_id=p_team for update skip locked;
 if op.id is null or op.state not in('succeeded','failed','canceled') then return false;end if;
 if op.state='succeeded' then
  select * into material from public.team_materials where id=op.result_material_id and team_id=p_team
   and lifecycle='active' and category='video';
  if material.id is null then code:='SOURCE_CHANGED';
  elsif op.actor_id is distinct from g.actor_id or op.source_material_id is distinct from (
   select (r.config->>'materialId')::uuid from public.team_launch_revisions r where r.id=g.revision_id
  ) or not exists(select 1 from private.team_operation_intents i where i.operation_id=op.id
   and i.team_id=p_team and i.tool_id='restitch' and i.tool_contract_version=prep.contract_version)
   then code:='WRONG_STATE';
  end if;
 else
  -- Provider messages and arbitrary error strings never enter the Launch diagnostic journal.
  code:=case when op.error_code in('SOURCE_CHANGED','PERMISSION_DENIED','DRIVE_UNAVAILABLE','AGENT_UPDATE_REQUIRED','NOT_FOUND','RESTITCH_DEFAULTS_INVALID','RESTITCH_SOURCE_FORBIDDEN') then op.error_code else 'PROCESS_FAILED' end;
 end if;
 update public.team_launch_generation_steps set state=case when code is null then 'succeeded' else 'failed' end,
  result_material_id=case when code is null then material.id else null end,safe_error_code=code,updated_at=clock_timestamp()
  where generation_id=g.id and team_operation_id=op.id and stage='restitch_processing';
 update public.team_launch_generations set state=case when code is null then 'accepted' else 'failed' end,
  stage=case when code is null then 'catalog_planning' else 'restitch_processing' end,
  safe_error_code=code,retryable=false,next_attempt_at=case when code is null then clock_timestamp() else null end,
  lease_owner=null,lease_expires_at=null,state_version=state_version+1,updated_at=clock_timestamp() where id=g.id;
 perform private.launch_signal(p_team,g.launch_id,l.aggregate_version);
 return true;
end $$;
create function public.settle_launch_restitch(p_team uuid,p_generation uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 perform private.launch_access(p_team,'edit');
 if not exists(select 1 from public.team_launch_generations where id=p_generation and team_id=p_team and actor_id=auth.uid()) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 return private.settle_launch_restitch(p_team,p_generation);
end $$;
create function public.service_settle_launch_restitch_batch(p_limit integer default 3) returns integer
language plpgsql security definer set search_path='' as $$
declare item record;settled integer:=0;
begin
 if p_limit is null or p_limit not between 1 and 10 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 for item in select g.id,g.team_id from public.team_launch_generations g
  join private.launch_restitch_preparations p on p.generation_id=g.id
  join public.team_operations o on o.id=p.operation_id and o.state in('succeeded','failed','canceled')
  where g.state='waiting_dependency' order by g.updated_at,g.id limit p_limit
 loop
  if private.settle_launch_restitch(item.team_id,item.id) then settled:=settled+1;end if;
 end loop;
 return settled;
end $$;
-- Extend the existing worker wakeup predicate; no new scheduler or browser polling.
create or replace function private.launch_settlement_due() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.team_launch_generations g
 join public.team_launch_revisions r on r.id=g.revision_id
 join public.team_launches l on l.id=g.launch_id and l.archived_at is null
 where (g.next_attempt_at is null or g.next_attempt_at<=clock_timestamp())
 and (g.lease_expires_at is null or g.lease_expires_at<=clock_timestamp())
 and ((g.state in('accepted','running','interrupted') and
   (r.config->>'method'='other' or exists(select 1 from private.catalog_generation_intents i
     where i.team_id=g.team_id and i.actor_id=g.actor_id and i.state='registered'
     and i.request_key='launch:'||g.id::text||':catalog')))
 or (g.state='waiting_dependency' and exists(select 1 from private.launch_restitch_preparations p
  join public.team_operations o on o.id=p.operation_id where p.generation_id=g.id and o.state in('succeeded','failed','canceled')))
 or (g.state='cancel_requested' and
   not exists(select 1 from private.catalog_generation_intents i where i.team_id=g.team_id
     and i.request_key='launch:'||g.id::text||':catalog') and
   not exists(select 1 from public.team_launch_generation_steps s where s.generation_id=g.id
     and (s.team_operation_id is not null or s.provider_file_id is not null or s.result_material_id is not null)))))
$$;
revoke all on function private.settle_launch_restitch(uuid,uuid),public.settle_launch_restitch(uuid,uuid),public.service_settle_launch_restitch_batch(integer) from public,anon,authenticated;
grant execute on function public.settle_launch_restitch(uuid,uuid) to authenticated;
grant execute on function public.service_settle_launch_restitch_batch(integer) to service_role;
