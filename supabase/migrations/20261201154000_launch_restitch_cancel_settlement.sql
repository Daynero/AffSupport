-- Settle pre-upload local cancellation only with the existing durable output-intent proof.
create function public.service_settle_launch_restitch_cancellations(p_limit integer default 3) returns integer
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
  for op in select o.*,i.expected_size,i.provider_result_id,i.tool_id from public.team_operations o
   left join private.team_operation_intents i on i.operation_id=o.id and i.team_id=g.team_id
   where o.team_id=g.team_id and (o.id=p.operation_id or o.idempotency_key=p.process_key or exists(
    select 1 from public.team_launch_generation_steps s where s.generation_id=g.id and s.team_operation_id=o.id))
   for update of o
  loop
   -- Output size is durably bound before Drive upload creation; absence here is positive
   -- pre-upload evidence, not an inference from a failed marker lookup or lost reply.
   if op.actor_id is distinct from g.actor_id or op.kind<>'process' or op.tool_id is distinct from 'restitch'
    or op.state not in('failed','canceled') or op.expected_size is not null or op.provider_result_id is not null or op.result_material_id is not null then settled:=false;end if;
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
revoke all on function public.service_settle_launch_restitch_cancellations(integer) from public,anon,authenticated;
grant execute on function public.service_settle_launch_restitch_cancellations(integer) to service_role;

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
 or (g.state in('cancel_requested','canceled_with_cleanup_pending') and exists(select 1 from private.launch_restitch_preparations p where p.generation_id=g.id) and not exists(select 1 from private.catalog_generation_intents i where i.team_id=g.team_id and i.request_key='launch:'||g.id::text||':catalog'))
 or (g.state='cancel_requested' and
   not exists(select 1 from private.catalog_generation_intents i where i.team_id=g.team_id
     and i.request_key='launch:'||g.id::text||':catalog') and
   not exists(select 1 from public.team_launch_generation_steps s where s.generation_id=g.id
     and (s.team_operation_id is not null or s.provider_file_id is not null or s.result_material_id is not null)))))
$$;
