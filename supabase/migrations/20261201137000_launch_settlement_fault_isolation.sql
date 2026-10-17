-- Isolate each settlement failure; keep diagnostics closed and content-free.
create or replace function public.service_settle_launch_batch(p_limit integer default 3) returns jsonb
language plpgsql security definer set search_path='' as $$
declare candidate record;g public.team_launch_generations%rowtype;l public.team_launches%rowtype;
 claimed jsonb;failure_code text;owner text:=gen_random_uuid()::text;n integer:=0;done integer:=0;canceled integer:=0;
begin
 if p_limit is null or p_limit not between 1 and 10 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 for candidate in select x.id,x.launch_id,x.team_id from public.team_launch_generations x
  join public.team_launch_revisions r on r.id=x.revision_id
  where (x.next_attempt_at is null or x.next_attempt_at<=clock_timestamp())
   and (x.lease_expires_at is null or x.lease_expires_at<=clock_timestamp())
   and ((x.state in('accepted','running','interrupted') and
    (r.config->>'method'='other' or exists(select 1 from private.catalog_generation_intents i
     where i.team_id=x.team_id and i.actor_id=x.actor_id and i.state='registered'
      and i.request_key='launch:'||x.id::text||':catalog')))
    or (x.state='cancel_requested' and
      not exists(select 1 from private.catalog_generation_intents i where i.team_id=x.team_id and i.request_key='launch:'||x.id::text||':catalog')
      and not exists(select 1 from public.team_launch_generation_steps s where s.generation_id=x.id
       and (s.team_operation_id is not null or s.provider_file_id is not null or s.result_material_id is not null))))
  order by coalesce(x.next_attempt_at,x.created_at),x.id limit p_limit*4
 loop
  exit when n>=p_limit;
  -- Every Launch mutation takes aggregate before generation.
  select * into l from public.team_launches where id=candidate.launch_id and archived_at is null for update skip locked;
  if not found then continue;end if;
  select * into g from public.team_launch_generations where id=candidate.id for update skip locked;
  if not found or g.state in('succeeded','canceled','failed','partial','waiting_dependency','canceled_with_cleanup_pending')
    or g.lease_expires_at>clock_timestamp() or g.next_attempt_at>clock_timestamp() then continue;end if;
  if g.state='cancel_requested' then
   if exists(select 1 from private.catalog_generation_intents i where i.team_id=g.team_id and i.request_key='launch:'||g.id::text||':catalog')
    or exists(select 1 from public.team_launch_generation_steps s where s.generation_id=g.id
      and (s.team_operation_id is not null or s.provider_file_id is not null or s.result_material_id is not null)) then continue;end if;
   n:=n+1;
   update public.team_launch_generations set state='canceled',stage='cancel',state_version=state_version+1,
    lease_owner=null,lease_expires_at=null,next_attempt_at=null,fence=fence+1,updated_at=clock_timestamp() where id=g.id;
   update public.team_launch_generation_steps set state='canceled',updated_at=clock_timestamp()
    where generation_id=g.id and state in('pending','running');
   perform private.launch_signal(g.team_id,g.launch_id,l.aggregate_version);
   canceled:=canceled+1;continue;
  end if;
  n:=n+1;
  if not private.can(g.team_id,'edit',g.actor_id) then
   update public.team_launch_generations set state='failed',safe_error_code='PERMISSION_DENIED',retryable=false,
    state_version=state_version+1,next_attempt_at=null,updated_at=clock_timestamp() where id=g.id;
   perform private.launch_signal(g.team_id,g.launch_id,l.aggregate_version);continue;
  end if;
  begin
  claimed:=public.service_claim_launch_generation(g.team_id,g.id,g.actor_id,owner);
  if (select config->>'method' from public.team_launch_revisions where id=g.revision_id)='other'
    or public.service_restore_registered_launch_catalog(g.team_id,g.id,g.actor_id,owner,claimed->>'fence') then
   perform public.service_publish_launch_generation(g.team_id,g.id,g.actor_id,claimed->>'fence');done:=done+1;
  end if;
  exception when others then
   -- Never persist SQLERRM: it can contain user/provider content.
   failure_code:=case when SQLERRM in('SOURCE_CHANGED','NOT_FOUND','PERMISSION_DENIED','WRONG_STATE') then SQLERRM else 'UNKNOWN' end;
   update public.team_launch_generations set state=case when failure_code='UNKNOWN' then 'interrupted' else 'failed' end,
    safe_error_code=failure_code,retryable=(failure_code='UNKNOWN'),lease_owner=null,lease_expires_at=clock_timestamp(),
    next_attempt_at=case when failure_code='UNKNOWN' then clock_timestamp()+interval '5 minutes' else null end,
    state_version=state_version+1,updated_at=clock_timestamp() where id=g.id;
   perform private.launch_signal(g.team_id,g.launch_id,l.aggregate_version);
  end;
 end loop;
 return jsonb_build_object('examined',n,'completed',done,'canceled',canceled);
end $$;
