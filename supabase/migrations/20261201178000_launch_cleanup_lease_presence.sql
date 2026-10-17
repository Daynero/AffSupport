-- Missing lease fields never confer provider cleanup authority.
create or replace function public.service_authorize_launch_cleanup(p_team uuid,p_generation uuid,p_owner uuid,p_fence text,p_intent_fence text,p_file text) returns text
language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;i private.catalog_generation_intents%rowtype;
begin
 if p_owner is null or p_fence is null or p_intent_fence is null or p_file is null then return 'unknown';end if;
 select * into g from public.team_launch_generations where team_id=p_team and id=p_generation;
 if g.id is null or g.state is distinct from 'canceled_with_cleanup_pending' or g.lease_owner is distinct from p_owner::text or g.fence::text is distinct from p_fence or (g.lease_expires_at is null or g.lease_expires_at<=clock_timestamp()) then return 'unknown';end if;
 select * into i from private.catalog_generation_intents where team_id=p_team and actor_id=g.actor_id and request_key='launch:'||g.id::text||':catalog';
 if i.id is null or i.lease_owner is distinct from p_owner or i.fence::text is distinct from p_intent_fence or (i.lease_expires_at is null or i.lease_expires_at<=clock_timestamp()) then return 'unknown';end if;
 if i.state='registered' or exists(select 1 from public.team_materials where drive_file_id=p_file) then return 'retained';end if;
 if i.checkpoint->>'providerFileId'=p_file and i.checkpoint->>'launchOutputCleaned' is distinct from 'true' then return 'owned_unpublished';end if;
 return 'unknown';
end $$;
create or replace function public.service_finish_launch_cleanup(p_team uuid,p_generation uuid,p_owner uuid,p_fence text,p_intent_fence text,p_cleaned_file text default null) returns text
language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;l public.team_launches%rowtype;i private.catalog_generation_intents%rowtype;settled boolean;
begin
 if p_owner is null or p_fence is null or p_intent_fence is null then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 select * into l from public.team_launches where id=(select launch_id from public.team_launch_generations where id=p_generation and team_id=p_team) for update;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 select * into i from private.catalog_generation_intents where team_id=p_team and actor_id=g.actor_id and request_key='launch:'||g.id::text||':catalog' for update;
 if g.id is null or i.id is null or g.state is distinct from 'canceled_with_cleanup_pending' or g.lease_owner is distinct from p_owner::text or g.fence::text is distinct from p_fence or (g.lease_expires_at is null or g.lease_expires_at<=clock_timestamp())
  or i.lease_owner is distinct from p_owner or i.fence::text is distinct from p_intent_fence or (i.lease_expires_at is null or i.lease_expires_at<=clock_timestamp()) then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 if p_cleaned_file is not null then
  if public.service_authorize_launch_cleanup(p_team,p_generation,p_owner,p_fence,p_intent_fence,p_cleaned_file) is distinct from 'owned_unpublished' then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
  update private.catalog_generation_intents set checkpoint=checkpoint||'{"launchOutputCleaned":true}',updated_at=clock_timestamp() where id=i.id returning * into i;
 end if;
 -- Registered catalogs are retained as workspace resources, including their required grants.
 -- Unknown permission/create outcomes remain pending; no ownership is inferred from absence.
 settled:=i.state='registered' or
  ((i.checkpoint->>'createStarted' is distinct from 'true' or i.checkpoint->>'launchOutputCleaned'='true')
   and not exists(select 1 from private.catalog_generation_sharing s where s.intent_id=i.id and not s.prior_anyone
    and s.state<>'cleaned' and (s.created_by_attempt or s.state in('pending','cleanup_pending'))));
 if settled and i.state<>'registered' then update private.catalog_generation_intents set state='canceled',lease_expires_at=null,next_attempt_at=null,updated_at=clock_timestamp() where id=i.id;end if;
 update public.team_launch_generations set state=case when settled then 'canceled' else 'canceled_with_cleanup_pending' end,
  stage=case when settled then 'cancel' else 'cleanup' end,state_version=state_version+1,lease_owner=null,lease_expires_at=null,
  next_attempt_at=case when settled then null else clock_timestamp()+interval '5 minutes' end,
  safe_error_code=case when settled then null else 'LAUNCH_RESULT_UNCERTAIN' end,updated_at=clock_timestamp() where id=g.id;
 update private.catalog_generation_intents set lease_expires_at=clock_timestamp(),next_attempt_at=case when settled then null else clock_timestamp()+interval '5 minutes' end where id=i.id;
 perform private.launch_signal(p_team,g.launch_id,l.aggregate_version);
 return case when settled then 'canceled' else 'canceled_with_cleanup_pending' end;
end $$;
