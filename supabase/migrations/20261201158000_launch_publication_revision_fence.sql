-- Uncertain work cannot overwrite a newer active revision or accept silent edits.
create or replace function private.launch_unlocked(p_team uuid,p_launch uuid) returns void
language plpgsql stable security definer set search_path='' as $$
begin
 if exists(select 1 from public.team_launch_generations where team_id=p_team and launch_id=p_launch and state not in('succeeded','canceled','failed')) then raise exception 'LAUNCH_BUSY' using errcode='55000';end if;
end $$;
create or replace function public.service_publish_launch_generation(p_team uuid,p_generation uuid,p_actor uuid,p_fence text) returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;l public.team_launches%rowtype;r public.team_launch_revisions%rowtype;
begin
 if not private.can(p_team,'edit',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 -- All mutations lock aggregate before generation to avoid cancel/commit deadlocks.
 select * into l from public.team_launches where id=(select launch_id from public.team_launch_generations where id=p_generation and team_id=p_team) for update;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 if g.state='succeeded' then return jsonb_build_object('id',g.id,'state',g.state,'revisionId',g.revision_id);end if;
 if g.fence::text<>p_fence or g.state not in('accepted','running') or l.archived_at is not null then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into r from public.team_launch_revisions where id=g.revision_id;
 if l.active_revision_id is distinct from r.base_revision_id then raise exception 'LAUNCH_VERSION_CONFLICT' using errcode='40001';end if;
 if r.config->>'method'='catalog' and not exists(select 1 from public.team_launch_revision_catalogs where revision_id=r.id) then raise exception 'WRONG_STATE' using errcode='55000';end if;
 update public.team_launch_generations set state='succeeded',stage='result_committed',state_version=state_version+1,updated_at=clock_timestamp() where id=g.id;
 update public.team_launches set active_revision_id=r.id,effective_launch_date=(r.config->>'launchDate')::date,aggregate_version=aggregate_version+1,updated_at=clock_timestamp() where id=l.id returning * into l;
 perform private.launch_signal(p_team,l.id,l.aggregate_version);
 return jsonb_build_object('id',g.id,'state','succeeded','revisionId',r.id);
end $$;
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
   failure_code:=case when SQLERRM in('SOURCE_CHANGED','NOT_FOUND','PERMISSION_DENIED','WRONG_STATE','LAUNCH_VERSION_CONFLICT') then SQLERRM else 'UNKNOWN' end;
   update public.team_launch_generations set state=case when failure_code='UNKNOWN' then 'interrupted' else 'failed' end,
    safe_error_code=failure_code,retryable=(failure_code='UNKNOWN'),lease_owner=null,lease_expires_at=clock_timestamp(),
    next_attempt_at=case when failure_code='UNKNOWN' then clock_timestamp()+interval '5 minutes' else null end,
    state_version=state_version+1,updated_at=clock_timestamp() where id=g.id;
   perform private.launch_signal(g.team_id,g.launch_id,l.aggregate_version);
  end;
 end loop;
 return jsonb_build_object('examined',n,'completed',done,'canceled',canceled);
end $$;
create or replace function public.retry_launch_restitch(p_team uuid,p_generation uuid,p_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;l public.team_launches%rowtype;r public.team_launch_revisions%rowtype;
 p private.launch_restitch_preparations%rowtype;o public.team_operations%rowtype;payload jsonb:=jsonb_build_array(p_generation);replay jsonb;result jsonb;fresh jsonb;
begin
 perform private.launch_access(p_team,'edit');
 if not private.can(p_team,'download',auth.uid()) or not private.can(p_team,'upload',auth.uid()) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 replay:=private.launch_request(p_team,p_key,'restitch-retry',payload);if replay is not null then return replay;end if;
 select * into l from public.team_launches where id=(select launch_id from public.team_launch_generations where id=p_generation and team_id=p_team) and archived_at is null for update;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 if g.id is null or l.id is null or g.actor_id is distinct from auth.uid() then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if g.state<>'failed' or g.stage<>'restitch_processing' then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into p from private.launch_restitch_preparations where generation_id=g.id for update;
 select * into o from public.team_operations where id=p.operation_id and team_id=p_team for update;
 if o.id is null or o.state not in('failed','canceled') or p.process_attempt>=100 then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into r from public.team_launch_revisions where id=g.revision_id;
 if l.draft_config is distinct from r.config or l.active_revision_id is distinct from r.base_revision_id then raise exception 'LAUNCH_VERSION_CONFLICT' using errcode='40001';end if;
 fresh:=private.launch_sources_from_config(p_team,r.config,auth.uid());
 if private.launch_material_identity(fresh) is null or private.launch_material_identity(fresh) is distinct from private.launch_material_identity(r.sources) then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 update private.launch_restitch_preparations set process_attempt=process_attempt+1,
  process_key='launch-restitch:'||g.id::text||':'||(process_attempt+1)::text,operation_id=null,updated_at=clock_timestamp() where generation_id=g.id returning * into p;
 update public.team_launch_generations set state='waiting_dependency',stage='restitch_preparing',safe_error_code=null,retryable=false,
  lease_owner=null,lease_expires_at=null,next_attempt_at=null,fence=fence+1,state_version=state_version+1,updated_at=clock_timestamp() where id=g.id;
 result:=jsonb_build_object('generationId',g.id,'processKey',p.process_key);
 perform private.launch_signal(p_team,g.launch_id,l.aggregate_version);
 perform private.launch_remember(p_team,p_key,'restitch-retry',payload,result);
 return result;
end $$;
