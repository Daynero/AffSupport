-- Serialize the final permission to call Drive with parent cancellation.
-- Cancellation locks launch -> generation -> child operation; use the same order.
create or replace function public.service_start_launch_process_upload(p_operation uuid,p_actor uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare prep private.launch_restitch_preparations%rowtype;
  l public.team_launches%rowtype;g public.team_launch_generations%rowtype;
  o public.team_operations%rowtype;i private.team_operation_intents%rowtype;v_launch uuid;
begin
 select p.* into prep from private.launch_restitch_preparations p
  join public.team_operations child on child.team_id=p.team_id and child.actor_id=p.actor_id
   and (p.operation_id=child.id or p.process_key=child.idempotency_key)
  where child.id=p_operation and child.actor_id=p_actor;
 if prep.generation_id is null then raise exception 'WRONG_STATE' using errcode='23514';end if;
 select launch_id into v_launch from public.team_launch_generations where id=prep.generation_id and team_id=prep.team_id;
 select * into l from public.team_launches where id=v_launch and team_id=prep.team_id for update;
 select * into g from public.team_launch_generations where id=prep.generation_id and launch_id=l.id and team_id=l.team_id for update;
 select * into o from public.team_operations where id=p_operation and actor_id=p_actor and team_id=prep.team_id for update;
 select * into i from private.team_operation_intents where operation_id=o.id and team_id=o.team_id for update;
 if l.id is null or g.id is null or o.id is null or i.operation_id is null
  or o.kind<>'process' or o.state<>'running' or i.tool_id is distinct from 'restitch'
  or i.expected_size is null or i.launch_upload_phase is distinct from 'not_started'
  or g.state not in('accepted','running','waiting_dependency','interrupted')
  or not (prep.operation_id=o.id or prep.process_key=o.idempotency_key)
 then raise exception 'WRONG_STATE' using errcode='23514';end if;
 update private.team_operation_intents set launch_upload_phase='started',updated_at=clock_timestamp()
  where operation_id=o.id;
 return true;
end $$;
