-- One explicit Launch retry authorizes at most one failed catalog child replacement.
-- Ordinary interrupted recovery can still reconcile the same provider intent.
alter table public.team_launch_generations add column catalog_retry_from_attempt integer
 check(catalog_retry_from_attempt is null or catalog_retry_from_attempt between 1 and 100);
create or replace function public.retry_launch_generation(p_team uuid,p_generation uuid,p_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;l public.team_launches%rowtype;r public.team_launch_revisions%rowtype;fresh jsonb;
 payload jsonb:=jsonb_build_array(p_generation);replay jsonb;result jsonb;retry_from integer;
begin
 perform private.launch_access(p_team,'edit');
 replay:=private.launch_request(p_team,p_key,'generation-retry',payload);if replay is not null then return replay;end if;
 select * into l from public.team_launches where id=(select launch_id from public.team_launch_generations where id=p_generation and team_id=p_team) and archived_at is null for update;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 if g.id is null or l.id is null or g.actor_id is distinct from auth.uid() then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if g.state not in('interrupted','partial','failed') or g.lease_expires_at>clock_timestamp() then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into r from public.team_launch_revisions where id=g.revision_id;
 if g.stage='restitch_processing' and r.config->'catalog'->>'restitchEnabled'='true' then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if l.draft_config is distinct from r.config or l.active_revision_id is distinct from r.base_revision_id then raise exception 'LAUNCH_VERSION_CONFLICT' using errcode='40001';end if;
 fresh:=private.launch_sources_from_config(p_team,r.config,auth.uid());
 if private.launch_material_identity(fresh) is null or private.launch_material_identity(fresh) is distinct from private.launch_material_identity(r.sources) then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 if exists(select 1 from private.catalog_generation_intents where team_id=p_team and request_key='launch:'||g.id::text||':catalog' and lease_expires_at>clock_timestamp()) then raise exception 'LAUNCH_BUSY' using errcode='55000';end if;
 select i.attempt into retry_from from private.catalog_generation_intents i
 join public.team_operations o on o.id=i.operation_id and o.team_id=p_team and o.actor_id=g.actor_id and o.state='failed'
 where i.team_id=p_team and i.request_key='launch:'||g.id::text||':catalog';
 update public.team_launch_generations set state='accepted',stage='preparing',safe_error_code=null,retryable=false,lease_owner=null,lease_expires_at=null,
  fence=fence+1,state_version=state_version+1,attempt_no=attempt_no+1,catalog_retry_from_attempt=retry_from,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp() where id=g.id;
 result:=jsonb_build_object('generationId',g.id,'state','accepted');
 perform private.launch_signal(p_team,g.launch_id,l.aggregate_version);perform private.launch_remember(p_team,p_key,'generation-retry',payload,result);
 return result;
end $$;
create or replace function public.service_retry_catalog_child(p_team uuid,p_intent uuid,p_actor uuid,p_owner uuid,p_fence text) returns integer language plpgsql security definer set search_path='' as $$
declare r private.catalog_generation_intents%rowtype;n integer;begin
 select * into r from private.catalog_generation_intents where team_id=p_team and id=p_intent for update;
 if r.id is null or p_actor is null or not private.can(p_team,'view',p_actor) or r.actor_id<>p_actor or r.lease_owner<>p_owner or r.fence::text<>p_fence or r.lease_expires_at<=clock_timestamp() then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 if r.request_key like 'launch:%:catalog' then
  -- A failed child is terminal until the actor explicitly retries this parent.
  -- A retry before this child failed does not authorize its replacement.
  if r.request_key !~* '^launch:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:catalog$'
   then raise exception 'WRONG_STATE' using errcode='55000';end if;
  if not exists(
   select 1 from public.team_launch_generations g
   where g.id=substring(r.request_key from 8 for 36)::uuid and g.team_id=p_team
    and g.actor_id=p_actor and g.state='running'
    and g.catalog_retry_from_attempt=r.attempt
  ) then raise exception 'WRONG_STATE' using errcode='55000';end if;
 end if;
 if not exists(select 1 from public.team_operations where id=r.operation_id and team_id=p_team and actor_id=p_actor and state='failed') then raise exception 'WRONG_STATE' using errcode='55000';end if;
 update private.catalog_generation_intents set operation_id=null,attempt=attempt+1,lease_expires_at=clock_timestamp()+interval '180 seconds',updated_at=clock_timestamp() where id=r.id returning attempt into n;return n;
end $$;
