-- Settle failed browser video preparation without replaying uncertain native/provider work.
begin;
create or replace function public.service_complete_restitch_job(
  p_actor uuid,
  p_job uuid,
  p_lease_token_hash bytea,
  p_outcome text,
  p_error text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  job private.catalog_restitch_jobs;
begin
  if p_outcome not in ('finalized', 'failed')
     or (p_error is not null and p_error !~ '^[A-Z_]{2,64}$') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into job from private.catalog_restitch_jobs as candidate
  where candidate.catalog_material_id = p_job
    and candidate.lease_owner = p_actor
    and candidate.state = 'leased'
    and candidate.lease_token_hash = p_lease_token_hash
  for update;
  if job.catalog_material_id is null then return false; end if;

  -- A browser reports only after its local process has returned. Before any
  -- upload or native execution reservation, its failed handoff can be closed
  -- atomically with returning the job. Otherwise the open operation blocks every
  -- later claimant, particularly a different member who cannot retire it.
  if p_outcome = 'failed' and job.operation_id is not null
     -- A lost loopback reply is not proof that native work stopped. Only a
     -- classified media failure authorizes settling this pre-upload handoff.
     and p_error in (
       'BODY_PREPARE_FAILED', 'BODY_REMUX_FAILED', 'BODY_HEAD_FAILED',
       'BODY_TAIL_FAILED', 'BODY_AUDIO_MISMATCH', 'BODY_RECOVERY_FAILED',
       'BODY_RECOVERY_VERIFICATION_FAILED', 'BODY_TIMING_UNREADABLE', 'BODY_JOIN_FAILED',
       'MEDIA_TOOL_UNAVAILABLE', 'SILENCE_BANK_FAILED', 'SCREEN_ENCODE_FAILED',
       'SCREEN_SILENCE_FAILED', 'SCREEN_MUX_FAILED', 'STITCH_TOOL_FAILED',
       'STITCH_VERIFICATION_FAILED', 'STITCH_JOIN_FAILED', 'STITCH_AUDIO_MISMATCH',
       'STITCH_IMAGE_UNAVAILABLE', 'STITCH_OUTPUT_UNWRITABLE'
     ) then
    perform 1 from public.team_operations operation
      where operation.id = job.operation_id and operation.team_id = job.team_id
        and operation.actor_id = p_actor
      for update;
    if exists (
      select 1 from public.team_operations operation
      where operation.id = job.operation_id and operation.team_id = job.team_id
        and operation.actor_id = p_actor and operation.kind = 'process'
        and operation.state in ('pending', 'running') and operation.stage = 'awaiting_agent'
        and operation.result_material_id is null
    ) and not exists (
      select 1 from private.team_recovery_execution_fences where operation_id = job.operation_id
    ) and not exists (
      select 1 from private.process_upload_ownership where operation_id = job.operation_id
    ) and not exists (
      select 1 from private.team_operation_intents
      where operation_id = job.operation_id and provider_result_id is not null
    ) then
      perform public.service_transition_team_operation(
        job.operation_id, 'failed', 'failed', 100, null,
        case when exists(select 1 from public.team_error_codes where code = p_error)
          then p_error else 'PROCESS_FAILED' end, true
      );
      perform private.record_team_audit(job.team_id, p_actor, 'operation.failed',
        jsonb_build_object('operation_id', job.operation_id, 'state', 'failed'),
        'failed', 'PROCESS_FAILED');
    end if;
  end if;

  update private.catalog_restitch_jobs as candidate
     set state = 'queued',
         lease_token_hash = null,
         lease_expires_at = null,
         next_attempt_at = clock_timestamp() + case
           when job.attempts <= 1 then interval '1 minute'
           when job.attempts = 2 then interval '5 minutes'
           else interval '15 minutes'
         end,
         last_error_code = case
           when p_outcome = 'failed' then coalesce(p_error, 'PROCESS_FAILED')
           else 'STALE_RESULT'
         end
   where candidate.catalog_material_id = p_job;
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (job.team_id, p_job, 'upserted');
  return true;
end;
$$;
-- Preserve the precise local cause instead of masking it with PROCESS_FAILED.
create or replace view public.analytics_catalog_updates as
select attempt.attempt_id, attempt.catalog_material_id, attempt.team_id,
       attempt.trigger_kind, attempt.started_at, attempt.ended_at,
       attempt.result, attempt.failure_code, attempt.delivery_verified_at,
       attempt.profile_version, attempt.source_attempt_id, attempt.stage_history,
       attempt.actual_changes,
       profile.version as current_profile_version,
       item.update_interval, item.next_run_at, item.reconciliation_required,
       catalog.last_updated_at as last_success_at,
       catalog.last_update_error as last_error_code,
       catalog.last_update_error_at as last_error_at,
       job.state as video_preparation_state,
       case when job.state = 'queued'
         then coalesce(job.last_error_code, operation.error_code)
         else coalesce(operation.error_code, job.last_error_code)
       end as video_preparation_error,
       job.next_attempt_at as video_preparation_retry_at,
       job.lease_expires_at as video_preparation_lease_until,
       operation.state as video_operation_state, operation.stage as video_operation_stage,
       profile.schedule, attempt.profile_snapshot -> 'schedule' as attempt_schedule
from public.team_catalog_update_attempts as attempt
join public.team_product_catalogs as catalog
  on catalog.material_id = attempt.catalog_material_id
join public.team_catalog_update_profiles as profile
  on profile.catalog_material_id = attempt.catalog_material_id
left join public.team_catalog_updater_items as item
  on item.catalog_material_id = attempt.catalog_material_id
left join private.catalog_restitch_jobs as job
  on job.catalog_material_id = attempt.catalog_material_id
left join public.team_operations as operation on operation.id = job.operation_id;

commit;
