-- One uncertain set must not hold all newer background launches. Claim pacing
-- is per set; credentials, execution fences and the existing worker stay shared.
begin;
create table private.catalog_background_claim_schedule (
 set_id uuid primary key references private.catalog_video_sets(id) on delete cascade,
 next_attempt_at timestamptz not null,last_claim_at timestamptz not null,
 last_error_code text references public.team_error_codes(code)
);
alter table private.catalog_background_claim_schedule enable row level security;
alter table private.catalog_background_claim_schedule force row level security;
revoke all on private.catalog_background_claim_schedule from public,anon,authenticated,service_role;

create or replace function public.service_claim_catalog_video_set(p_hash bytea,p_native uuid,p_protocol integer)returns jsonb language plpgsql security definer set search_path=''as $$
declare authority jsonb;s private.catalog_video_sets%rowtype;candidate record;delegation_version bigint;quiescent boolean;failure_code text;
begin
 if p_protocol is distinct from 1 or p_native is null then raise exception 'AGENT_UPDATE_REQUIRED'using errcode='55000';end if;
 authority:=public.service_team_recovery('authorize_claim',p_hash,'{}'::jsonb);
 select version into delegation_version from private.team_recovery_delegations where id=(authority->>'delegationId')::uuid;
 -- Null schedule means fresh work. A deferred old set moves behind independent
 -- siblings and is revisited after its own bounded cooldown.
 for candidate in
  select v.id from private.catalog_video_sets v left join private.catalog_background_claim_schedule q on q.set_id=v.id
  where v.team_id=(authority->>'teamId')::uuid and v.actor_id=(authority->>'actorId')::uuid and v.executor_id=(authority->>'installationId')::uuid
   and v.state in('accepted','preparing','unknown')and(q.next_attempt_at is null or q.next_attempt_at<=clock_timestamp())
   and not exists(select 1 from private.catalog_video_foreground_authorities f where f.video_set_id=v.id)
  order by q.last_claim_at nulls first,v.created_at,v.id for update of v skip locked limit 10
 loop
  select*into s from private.catalog_video_sets where id=candidate.id;
  insert into private.catalog_background_claim_schedule(set_id,next_attempt_at,last_claim_at)
   values(s.id,clock_timestamp()+case when s.state='unknown'then interval '2 minutes'else interval '30 seconds'end,clock_timestamp())
   on conflict(set_id)do update set next_attempt_at=excluded.next_attempt_at,last_claim_at=excluded.last_claim_at;
  begin
  -- Revocation/renewal and workspace suspension are never bypassed by reboot.
  if s.workspace_epoch is distinct from(select coalesce(max(epoch),0)from private.workspace_pauses where team_id=s.team_id)
   or(s.recovery_delegation_id is not null and(s.recovery_delegation_id is distinct from(authority->>'delegationId')::uuid or s.recovery_delegation_version is distinct from delegation_version))then continue;end if;
  if s.native_instance_id is not null and s.native_instance_id<>p_native then
   if s.updated_at>clock_timestamp()-interval '2 minutes'then continue;end if;
   -- Same installation, new boot. Keep the full two-minute silence horizon;
   -- the old native heartbeat watchdog may legitimately run for 90 seconds.
   perform private.release_silent_catalog_video_variants(s.id,interval '2 minutes');
   perform public.service_retry_failed_catalog_video_variants(s.id,s.team_id,s.actor_id);
   select*into s from private.catalog_video_sets where id=s.id;
   select not exists(
    select 1 from private.catalog_video_variants v where v.video_set_id=s.id and(
     v.state not in('queued','registered')or(v.state='queued'and exists(
      select 1 from public.team_operations o where o.team_id=s.team_id and o.actor_id=s.actor_id and o.idempotency_key='catalog-variant:'||v.request_id::text and(
       exists(select 1 from private.team_recovery_execution_fences f where f.operation_id=o.id)
       or exists(select 1 from private.process_upload_ownership w where w.operation_id=o.id)
      )
     ))
    )
   )into quiescent;
   if not quiescent then continue;end if;
   -- A returned pending claim commits any safe silence settlement. Raising here
   -- would roll it back and strand the same set on every later pass.
   update private.catalog_video_sets set native_instance_id=p_native,epoch=epoch+1,revision=revision+1,state='preparing',updated_at=clock_timestamp()where id=s.id;
  end if;
  perform public.service_authorize_catalog_video_executor(s.id,p_hash,p_native,p_protocol);
  update private.catalog_background_claim_schedule set last_error_code=null where set_id=s.id;
  return jsonb_build_object('setId',s.id);
  exception when others then
   get stacked diagnostics failure_code=message_text;
   if not exists(select 1 from public.team_error_codes where team_error_codes.code=failure_code)then failure_code:='LAUNCH_INTERNAL_ERROR';end if;
   update private.catalog_background_claim_schedule set last_error_code=failure_code where set_id=s.id;
  end;
 end loop;
 return jsonb_build_object('setId',null);
end $$;
revoke all on function public.service_claim_catalog_video_set(bytea,uuid,integer)from public,anon,authenticated;
grant execute on function public.service_claim_catalog_video_set(bytea,uuid,integer)to service_role;
create trigger task_cleanup_reference_fence before insert or update on private.catalog_background_claim_schedule for each row execute function private.guard_task_cleanup_reference();
commit;
