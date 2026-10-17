-- A preparation transaction can fail after acceptance. Return a closed receipt
-- after recording that failure; raising again would roll back the diagnosis.
alter function public.prepare_launch_restitch(uuid,uuid,uuid[]) rename to prepare_launch_restitch_unchecked;
revoke all on function public.prepare_launch_restitch_unchecked(uuid,uuid,uuid[]) from public,anon,authenticated,service_role;
create function public.prepare_launch_restitch(p_team uuid,p_generation uuid,p_exclude uuid[] default '{}') returns jsonb
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
