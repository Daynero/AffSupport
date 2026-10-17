-- Cleanup authority is service-only and tied to cancellation, an exact journal and leases.
create function public.service_claim_launch_cleanup(p_owner uuid,p_limit integer default 3) returns jsonb
language plpgsql security definer set search_path='' as $$
declare candidate record;g public.team_launch_generations%rowtype;l public.team_launches%rowtype;
 i private.catalog_generation_intents%rowtype;plans jsonb:='[]';outputs jsonb;file_id text;credential text;parent text;
begin
 if p_owner is null or p_limit is null or p_limit not between 1 and 10 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 for candidate in select id,launch_id from public.team_launch_generations
  where state in('cancel_requested','canceled_with_cleanup_pending')
   and (lease_expires_at is null or lease_expires_at<=clock_timestamp())
   and (next_attempt_at is null or next_attempt_at<=clock_timestamp())
  order by coalesce(next_attempt_at,created_at),id limit p_limit*4
 loop
  exit when jsonb_array_length(plans)>=p_limit;
  select * into l from public.team_launches where id=candidate.launch_id for update skip locked;
  if not found then continue;end if;
  select * into g from public.team_launch_generations where id=candidate.id for update skip locked;
  if not found or g.state not in('cancel_requested','canceled_with_cleanup_pending') or g.lease_expires_at>clock_timestamp() or g.next_attempt_at>clock_timestamp() then continue;end if;
  select * into i from private.catalog_generation_intents where team_id=g.team_id
    and actor_id=g.actor_id and request_key='launch:'||g.id::text||':catalog' for update skip locked;
  if not found or i.lease_expires_at>clock_timestamp() then continue;end if;
  update public.team_launch_generations set state='canceled_with_cleanup_pending',stage='cleanup',lease_owner=p_owner::text,
   lease_expires_at=clock_timestamp()+interval '180 seconds',fence=fence+1,state_version=state_version+1,
   next_attempt_at=clock_timestamp()+interval '180 seconds',updated_at=clock_timestamp() where id=g.id returning * into g;
  update private.catalog_generation_intents set lease_owner=p_owner,lease_expires_at=clock_timestamp()+interval '180 seconds',
   fence=fence+1,updated_at=clock_timestamp() where id=i.id returning * into i;
  -- Fence upload/finalize before any output is considered for cleanup.
  update public.team_operations set state='canceled',stage='canceled',finished_at=clock_timestamp(),updated_at=clock_timestamp()
   where id=i.operation_id and state in('pending','running');
  outputs:='[]';file_id:=i.checkpoint->>'providerFileId';credential:=i.checkpoint->>'credentialId';parent:=i.checkpoint->>'parentId';
  if i.state<>'registered' and i.checkpoint->>'launchOutputCleaned' is distinct from 'true'
    and file_id is not null and char_length(file_id) between 1 and 200
    and parent is not null and char_length(parent) between 1 and 200
    and credential ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and not exists(select 1 from public.team_materials m where m.drive_file_id=file_id) then
   outputs:=jsonb_build_array(jsonb_build_object('intentId',i.id,'fileId',file_id,'parentId',parent,'credentialId',credential));
  end if;
  plans:=plans||jsonb_build_array(jsonb_build_object('teamId',g.team_id,'generationId',g.id,'fence',g.fence::text,'intentFence',i.fence::text,'outputs',outputs));
  perform private.launch_signal(g.team_id,g.launch_id,l.aggregate_version);
 end loop;
 return plans;
end $$;
create function public.service_authorize_launch_cleanup(p_team uuid,p_generation uuid,p_owner uuid,p_fence text,p_intent_fence text,p_file text) returns text
language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;i private.catalog_generation_intents%rowtype;
begin
 if p_owner is null or p_fence is null or p_intent_fence is null or p_file is null then return 'unknown';end if;
 select * into g from public.team_launch_generations where team_id=p_team and id=p_generation;
 if g.id is null or g.state<>'canceled_with_cleanup_pending' or g.lease_owner<>p_owner::text or g.fence::text<>p_fence or g.lease_expires_at<=clock_timestamp() then return 'unknown';end if;
 select * into i from private.catalog_generation_intents where team_id=p_team and actor_id=g.actor_id and request_key='launch:'||g.id::text||':catalog';
 if i.id is null or i.lease_owner<>p_owner or i.fence::text<>p_intent_fence or i.lease_expires_at<=clock_timestamp() then return 'unknown';end if;
 if i.state='registered' or exists(select 1 from public.team_materials where drive_file_id=p_file) then return 'retained';end if;
 if i.checkpoint->>'providerFileId'=p_file and i.checkpoint->>'launchOutputCleaned' is distinct from 'true' then return 'owned_unpublished';end if;
 return 'unknown';
end $$;
create function public.service_finish_launch_cleanup(p_team uuid,p_generation uuid,p_owner uuid,p_fence text,p_intent_fence text,p_cleaned_file text default null) returns text
language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;l public.team_launches%rowtype;i private.catalog_generation_intents%rowtype;settled boolean;
begin
 if p_owner is null or p_fence is null or p_intent_fence is null then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 select * into l from public.team_launches where id=(select launch_id from public.team_launch_generations where id=p_generation and team_id=p_team) for update;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 select * into i from private.catalog_generation_intents where team_id=p_team and actor_id=g.actor_id and request_key='launch:'||g.id::text||':catalog' for update;
 if g.id is null or i.id is null or g.state<>'canceled_with_cleanup_pending' or g.lease_owner<>p_owner::text or g.fence::text<>p_fence or g.lease_expires_at<=clock_timestamp()
  or i.lease_owner<>p_owner or i.fence::text<>p_intent_fence or i.lease_expires_at<=clock_timestamp() then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 if p_cleaned_file is not null then
  if public.service_authorize_launch_cleanup(p_team,p_generation,p_owner,p_fence,p_intent_fence,p_cleaned_file)<>'owned_unpublished' then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
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
revoke all on function public.service_claim_launch_cleanup(uuid,integer),public.service_authorize_launch_cleanup(uuid,uuid,uuid,text,text,text),public.service_finish_launch_cleanup(uuid,uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.service_claim_launch_cleanup(uuid,integer),public.service_authorize_launch_cleanup(uuid,uuid,uuid,text,text,text),public.service_finish_launch_cleanup(uuid,uuid,uuid,text,text,text) to service_role;

create function private.launch_cleanup_due() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.team_launch_generations g join private.catalog_generation_intents i
  on i.team_id=g.team_id and i.actor_id=g.actor_id and i.request_key='launch:'||g.id::text||':catalog'
 where g.state in('cancel_requested','canceled_with_cleanup_pending')
  and (g.next_attempt_at is null or g.next_attempt_at<=clock_timestamp())
  and (g.lease_expires_at is null or g.lease_expires_at<=clock_timestamp())
  and (i.lease_expires_at is null or i.lease_expires_at<=clock_timestamp()))
$$;
revoke all on function private.launch_cleanup_due() from public,anon,authenticated;

create or replace function private.invoke_catalog_updater_worker()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  endpoint text;
  worker_secret text;
  request_id bigint;
begin
  begin
    perform private.retire_unused_restitch_copies();
  exception when others then
    -- Housekeeping never stops a round from being dispatched.
    null;
  end;

  if not exists (
    select 1 from public.team_catalog_updater_items as item
    where item.update_interval is not null
      and item.next_run_at <= clock_timestamp()
      and item.round_due_at is null
  ) and not exists (
    select 1 from public.team_catalog_updater_items as item
    where item.round_due_at is not null
      and item.next_attempt_at <= clock_timestamp()
      and (item.lease_expires_at is null or item.lease_expires_at <= clock_timestamp())
  ) and not exists (
    select 1 from public.team_catalog_restitch_copies as copy
    where copy.role = 'retired' and copy.next_delete_at <= clock_timestamp()
  ) and not private.launch_settlement_due() and not private.launch_cleanup_due() then return null; end if;
  if (select count(*) from public.team_catalog_updater_items
      where lease_expires_at > clock_timestamp()) >= 12
  and not private.launch_settlement_due() and not private.launch_cleanup_due() then return null; end if;

  select private.catalog_updater_endpoint(secret.decrypted_secret) into endpoint
  from vault.decrypted_secrets as secret where secret.name = 'wishly_catalog_sync_url'
  order by secret.created_at desc limit 1;
  select secret.decrypted_secret into worker_secret
  from vault.decrypted_secrets as secret where secret.name = 'wishly_catalog_sync_secret'
  order by secret.created_at desc limit 1;
  if endpoint is null or worker_secret is null or char_length(worker_secret) < 32 then
    return null;
  end if;

  select net.http_post(
    url := endpoint,
    headers := pg_catalog.jsonb_build_object('content-type', 'application/json',
      'x-catalog-sync-secret', worker_secret),
    body := '{"scheduled":true}'::jsonb, timeout_milliseconds := 60000
  ) into request_id;
  return request_id;
end;
$$;
