-- A classified native screen failure must not strand all later catalog copies.
-- The execution fence is retained; only an authenticated, quiescent pre-upload
-- failure can close its exact operation. Uncertain uploads remain fenced.
begin;
alter function public.service_team_recovery(text,bytea,jsonb) set schema private;
alter function private.service_team_recovery(text,bytea,jsonb) rename to recovery_before_screen_failure;
revoke all on function private.recovery_before_screen_failure(text,bytea,jsonb)
 from public,anon,authenticated,service_role;

create function public.service_team_recovery(p_action text,p_hash bytea,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare authority jsonb; operation public.team_operations%rowtype; code text;
begin
 if p_action<>'report_failure' then
  return private.recovery_before_screen_failure(p_action,p_hash,p_input);
 end if;
 if p_input->'protocolVersion' is distinct from '2'::jsonb then
  raise exception 'AGENT_UPDATE_REQUIRED' using errcode='55000';
 end if;
 authority:=private.recovery_before_screen_failure('authorize_execute',p_hash,p_input);
 code:=p_input->>'failureCode';
 if code is null or code not in ('RESTITCH_SCREEN_FETCH_FAILED','RESTITCH_SCREEN_UNAVAILABLE','RESTITCH_SCREEN_UNSUPPORTED') then
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;
 select * into operation from public.team_operations
  where id=(authority->>'operationId')::uuid
   and team_id=(authority->>'teamId')::uuid and actor_id=(authority->>'actorId')::uuid
  for update;
 if operation.id is null then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
 if operation.kind='process' and operation.state in ('pending','running')
  and operation.stage='awaiting_agent' and operation.result_material_id is null
  and exists(select 1 from private.team_recovery_execution_fences
   where operation_id=operation.id and job_id=(authority->>'jobId')::uuid)
  and not exists(select 1 from private.process_upload_ownership where operation_id=operation.id)
  and not exists(select 1 from private.team_operation_intents
   where operation_id=operation.id and provider_result_id is not null) then
  perform public.service_transition_team_operation(operation.id,'failed','failed',100,null,code,true);
  perform private.record_team_audit(operation.team_id,operation.actor_id,'operation.failed',
   jsonb_build_object('operation_id',operation.id,'state','failed'),'failed',code);
 end if;
 return private.recovery_before_screen_failure('authorize_execute',p_hash,p_input);
end $$;
revoke all on function public.service_team_recovery(text,bytea,jsonb) from public,anon,authenticated;
grant execute on function public.service_team_recovery(text,bytea,jsonb) to service_role;
commit;
