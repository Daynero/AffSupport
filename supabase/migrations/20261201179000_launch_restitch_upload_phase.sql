-- A nullable phase protects operations created by older Edge builds: NULL is unknown.
-- Only the new handler writes not_started before it can attempt the Drive request.
alter table private.team_operation_intents
  add column launch_upload_phase text
  constraint team_operation_intents_launch_upload_phase_check
  check (launch_upload_phase in ('not_started','started'));

create function public.service_is_launch_restitch_process(p_operation uuid,p_actor uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.team_operations o
  join private.launch_restitch_preparations p on p.team_id=o.team_id and p.actor_id=o.actor_id
   and (p.operation_id=o.id or p.process_key=o.idempotency_key)
  where o.id=p_operation and o.actor_id=p_actor and o.kind='process')
$$;
revoke all on function public.service_is_launch_restitch_process(uuid,uuid) from public,anon,authenticated;
grant execute on function public.service_is_launch_restitch_process(uuid,uuid) to service_role;

create function public.service_prepare_launch_process_upload(p_operation uuid,p_actor uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare o public.team_operations%rowtype;i private.team_operation_intents%rowtype;
begin
 select * into o from public.team_operations where id=p_operation and actor_id=p_actor for update;
 if o.id is null then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 select * into i from private.team_operation_intents where operation_id=o.id and team_id=o.team_id for update;
 if o.kind<>'process' or o.state<>'running' or i.operation_id is null
  or i.tool_id is distinct from 'restitch' or i.expected_size is not null
  or not exists(select 1 from private.launch_restitch_preparations p
    join public.team_launch_generations g on g.id=p.generation_id
    where p.team_id=o.team_id and p.actor_id=o.actor_id
      and (p.operation_id=o.id or p.process_key=o.idempotency_key)
      and g.state in('accepted','running','waiting_dependency','interrupted'))
 then raise exception 'WRONG_STATE' using errcode='23514';end if;
 if i.launch_upload_phase is null then
  update private.team_operation_intents set launch_upload_phase='not_started',updated_at=clock_timestamp()
   where operation_id=o.id;
 elsif i.launch_upload_phase is distinct from 'not_started' then
  raise exception 'WRONG_STATE' using errcode='23514';
 end if;
 return true;
end $$;

create function public.service_start_launch_process_upload(p_operation uuid,p_actor uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare o public.team_operations%rowtype;i private.team_operation_intents%rowtype;
begin
 select * into o from public.team_operations where id=p_operation and actor_id=p_actor for update;
 if o.id is null then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 select * into i from private.team_operation_intents where operation_id=o.id and team_id=o.team_id for update;
 if o.kind<>'process' or o.state<>'running' or i.operation_id is null
  or i.tool_id is distinct from 'restitch' or i.expected_size is null or i.launch_upload_phase is distinct from 'not_started'
  or not exists(select 1 from private.launch_restitch_preparations p
    join public.team_launch_generations g on g.id=p.generation_id
    where p.team_id=o.team_id and p.actor_id=o.actor_id
      and (p.operation_id=o.id or p.process_key=o.idempotency_key)
      and g.state in('accepted','running','waiting_dependency','interrupted'))
 then raise exception 'WRONG_STATE' using errcode='23514';end if;
 update private.team_operation_intents set launch_upload_phase='started',updated_at=clock_timestamp()
  where operation_id=o.id;
 return true;
end $$;

revoke all on function public.service_prepare_launch_process_upload(uuid,uuid),public.service_start_launch_process_upload(uuid,uuid) from public,anon,authenticated;
grant execute on function public.service_prepare_launch_process_upload(uuid,uuid),public.service_start_launch_process_upload(uuid,uuid) to service_role;

create or replace function public.service_settle_launch_restitch_cancellations(p_limit integer default 3) returns integer
language plpgsql security definer set search_path='' as $$
declare candidate record;g public.team_launch_generations%rowtype;l public.team_launches%rowtype;p private.launch_restitch_preparations%rowtype;op record;settled boolean;n integer:=0;
begin
 if p_limit is null or p_limit not between 1 and 10 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 for candidate in select x.id,x.launch_id from public.team_launch_generations x join private.launch_restitch_preparations prep on prep.generation_id=x.id
  where x.state in('cancel_requested','canceled_with_cleanup_pending') and (x.next_attempt_at is null or x.next_attempt_at<=clock_timestamp())
   and not exists(select 1 from private.catalog_generation_intents i where i.team_id=x.team_id and i.request_key='launch:'||x.id::text||':catalog')
  order by x.updated_at,x.id limit p_limit
 loop
  select * into l from public.team_launches where id=candidate.launch_id for update skip locked;if not found then continue;end if;
  select * into g from public.team_launch_generations where id=candidate.id for update skip locked;
  if not found or g.state not in('cancel_requested','canceled_with_cleanup_pending') or g.next_attempt_at>clock_timestamp() then continue;end if;
  select * into p from private.launch_restitch_preparations where generation_id=g.id for update;
  settled:=true;
  for op in select o.*,i.expected_size,i.provider_result_id,i.tool_id,i.launch_upload_phase from public.team_operations o
   left join private.team_operation_intents i on i.operation_id=o.id and i.team_id=g.team_id
   where o.team_id=g.team_id and (o.id=p.operation_id or o.idempotency_key=p.process_key or exists(
    select 1 from public.team_launch_generation_steps s where s.generation_id=g.id and s.team_operation_id=o.id))
   for update of o
  loop
   -- NULL means a legacy or unknown upload; started may have caused Drive effects.
   -- not_started is positive proof only when the process has stopped.
   if op.actor_id is distinct from g.actor_id or op.kind<>'process' or op.tool_id is distinct from 'restitch'
    or op.state not in('failed','canceled') or
    (op.expected_size is not null and op.launch_upload_phase is distinct from 'not_started')
    or op.provider_result_id is not null or op.result_material_id is not null then settled:=false;end if;
  end loop;
  update public.team_launch_generations set state=case when settled then 'canceled' else 'canceled_with_cleanup_pending' end,
   stage=case when settled then 'cancel' else 'cleanup' end,safe_error_code=case when settled then null else 'LAUNCH_RESULT_UNCERTAIN' end,
   state_version=state_version+1,next_attempt_at=case when settled then null else clock_timestamp()+interval '5 minutes' end,
   lease_owner=null,lease_expires_at=null,updated_at=clock_timestamp() where id=g.id;
  if settled then update public.team_launch_generation_steps set state='canceled',updated_at=clock_timestamp() where generation_id=g.id and state in('pending','running');end if;
  perform private.launch_signal(g.team_id,g.launch_id,l.aggregate_version);n:=n+1;
 end loop;
 return n;
end $$;
