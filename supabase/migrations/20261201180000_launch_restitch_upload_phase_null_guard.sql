-- Forward correction for installations that applied 179000 before the nullable guard was tightened.
create or replace function public.service_prepare_launch_process_upload(p_operation uuid,p_actor uuid)
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

create or replace function public.service_start_launch_process_upload(p_operation uuid,p_actor uuid)
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
