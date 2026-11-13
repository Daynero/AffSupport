-- 055: bounded frozen-content evidence; private recipes never cross this boundary.
begin;

create function private.catalog_content_diagnostic_receipt(
 p_receipt jsonb,p_rows_count integer,p_admitted_policy jsonb default null
) returns jsonb language plpgsql immutable set search_path='' as $$
declare selected boolean:=p_admitted_policy='1'::jsonb;present boolean;key text;planned integer;automatic integer;retained integer;
begin
 if p_admitted_policy is not null and p_admitted_policy<>'null'::jsonb and p_admitted_policy<>'1'::jsonb then
  return jsonb_build_object('status','invalid');
 end if;
 present:=coalesce(jsonb_typeof(p_receipt)='object' and exists(
  select 1 from jsonb_each(case when jsonb_typeof(p_receipt)='object' then p_receipt else '{}'::jsonb end) e where e.key=any(array['content_policy_version','planned_row_count','automatic_row_count','retained_row_count']) and e.value<>'null'::jsonb
 ),false);
 if not present then
  return jsonb_build_object('status',case when selected then 'policy_selected' when p_admitted_policy is null or p_admitted_policy='null'::jsonb then 'unavailable' else 'invalid' end,
   'content_policy_version',case when selected then 1 end);
 end if;
 if p_receipt->'content_policy_version' is distinct from '1'::jsonb then
  return jsonb_build_object('status','invalid');
 end if;
 foreach key in array array['planned_row_count','automatic_row_count','retained_row_count'] loop
  if jsonb_typeof(p_receipt->key) is distinct from 'number' or not coalesce((p_receipt->>key) ~ '^[0-9]{1,3}$',false) then
   return jsonb_build_object('status','invalid');
  end if;
 end loop;
 planned:=(p_receipt->>'planned_row_count')::integer;
 automatic:=(p_receipt->>'automatic_row_count')::integer;
 retained:=(p_receipt->>'retained_row_count')::integer;
 if planned not between 1 and 400 or automatic not between 0 and 400 or retained not between 0 and 400
  or automatic+retained<>planned or p_rows_count is distinct from planned then
  return jsonb_build_object('status','invalid');
 end if;
 return jsonb_build_object('status','frozen','content_policy_version',1,'planned_row_count',planned,
  'automatic_row_count',automatic,'retained_row_count',retained);
end $$;
revoke all on function private.catalog_content_diagnostic_receipt(jsonb,integer,jsonb) from public,anon,authenticated;
grant execute on function private.catalog_content_diagnostic_receipt(jsonb,integer,jsonb) to service_role;

create or replace view public.analytics_catalog_generations as
select i.id intent_id,i.team_id,i.actor_id,i.operation_id,i.attempt,
 case when i.request_key like 'launch:%' then 'launch' else 'standalone' end origin,
 case when i.state in ('reserved','planning','planned','create_started','created','finalized','registered','interrupted','cleanup_pending','canceled') then i.state else 'unknown' end state,
 case when i.state in ('interrupted','cleanup_pending') then
   case
    when i.checkpoint ? 'safeErrorCode' and jsonb_typeof(i.checkpoint->'safeErrorCode') not in ('string','null') then 'UNKNOWN'
    when failure.code in ('CATALOG_IMAGE_UPGRADE_REQUIRED','CATALOG_IMAGE_IMPORT_DISABLED','IMAGE_QUOTA_EXCEEDED','IMAGE_UPLOAD_CAPACITY_BUSY','IMAGE_MANIFEST_INCOMPLETE','IMAGE_SOURCE_UNAVAILABLE','IMAGE_SOURCE_CHANGED','IMAGE_LOCAL_SOURCE_REQUIRED','IMAGE_UNSUPPORTED_FORMAT','IMAGE_TOO_LARGE','IMAGE_DIMENSIONS_INVALID','IMAGE_ANIMATED_UNSUPPORTED','IMAGE_ORIENTATION_UNSUPPORTED','IMAGE_CONTENT_INVALID','IMAGE_CLASSIFICATION_CONFLICT','IMAGE_TEXT_PAIRING_CONFLICT','IMAGE_PROVIDER_UNAVAILABLE','IMAGE_PROVIDER_RATE_LIMITED','IMAGE_PUBLIC_VERIFICATION_FAILED','IMAGE_WRITE_UNCERTAIN','IMAGE_DICTIONARY_COMMIT_FAILED','IMAGE_PUBLICATION_REVOKED','IMAGE_CLIPBOARD_UNAVAILABLE','IDEMPOTENCY_CONFLICT','GLOBAL_IMAGE_POOL_UNAVAILABLE','GLOBAL_IMAGE_READINESS_UNKNOWN','GLOBAL_IMAGE_ALLOCATION_UNKNOWN','GLOBAL_IMAGE_SETTINGS_RETIRED','GLOBAL_IMAGE_CLIENT_UPGRADE_REQUIRED','GLOBAL_IMAGE_POLICY_CONFLICT','GLOBAL_IMAGE_CLEANUP_UNKNOWN','NEEDS_REAUTH','PERMISSION_DENIED','SOURCE_CHANGED','NOT_FOUND','RATE_LIMITED','DRIVE_UNAVAILABLE','LEASE_MISMATCH','GROUP_RECONCILING','WRONG_STATE','INVALID_RESPONSE','LAUNCH_RESULT_UNCERTAIN','LAUNCH_INTERNAL_ERROR','IMAGE_PUBLICATION_REVOKED','CATALOG_IMAGE_UPGRADE_REQUIRED','RESTITCH_SCREEN_SELECTION_LIMIT','RESTITCH_SCREEN_CANDIDATES_EXHAUSTED','RESTITCH_SCREEN_PREVIOUS_FAILURES','RESTITCH_SCREEN_BYTE_LIMIT','RESTITCH_SCREEN_IO_LIMIT','RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN','RESTITCH_SCREEN_UNAVAILABLE','RESTITCH_SCREEN_FETCH_FAILED','RESTITCH_SCREEN_UNSUPPORTED','RESTITCH_FORBIDDEN','RESTITCH_NO_SCREENS','RESTITCH_INVALID','RESTITCH_POOL_EMPTY','RESTITCH_SOURCE_FORBIDDEN','RESTITCH_SOURCES_INVALID','RESTITCH_SOURCES_TOO_MANY','RESTITCH_CLIENT_OUTDATED','PROCESS_RESULT_UNCERTAIN','AGENT_UPDATE_REQUIRED','SHARE_NOT_ALLOWED','INVALID_INPUT','CATALOG_WRITE_UNSUPPORTED') then failure.code
    when failure.code is not null then 'UNKNOWN'
    else null
   end
 else null end safe_error_code,
 i.created_at,i.updated_at,
 coalesce(jsonb_typeof(i.checkpoint->'settings')='object',false) settings_observed,
 coalesce(jsonb_typeof(i.checkpoint->('source_'||i.video_material_id::text))='object',false) source_observed,
 coalesce(jsonb_typeof(i.checkpoint->'sheetRows')='array',false) rows_planned,
 coalesce(jsonb_typeof(i.checkpoint->'providerFileId')='string',false) provider_result_observed,
 i.state='registered' result_registered,
 private.catalog_generation_timings_v1(i.checkpoint->'performance') performance,
 case when i.checkpoint->>'sheetEngine' in ('native','xlsx') then i.checkpoint->>'sheetEngine'='native' else null end native_sheet_mode,
 case when i.checkpoint->>'sheetEngine'='native' then coalesce(jsonb_typeof(i.checkpoint->'nativeSheet')='object'
  and jsonb_typeof(i.checkpoint->'nativeSheet'->'fileId')='string'
  and i.checkpoint->'nativeSheet'->>'fileId'=i.checkpoint->>'providerFileId'
  and jsonb_typeof(i.checkpoint->'nativeSheet'->'sheetId')='number',false) else null end native_sheet_bound,
 case when i.checkpoint->>'sheetEngine'='native' then coalesce(
  jsonb_typeof(i.checkpoint->'nativeRowsWritten')='object'
  and jsonb_typeof(i.checkpoint->'nativeRowsWritten'->'fileId')='string'
  and jsonb_typeof(i.checkpoint->'nativeRowsWritten'->'sheetId')='number'
  and jsonb_typeof(i.checkpoint->'nativeSheet'->'sheetId')='number'
  and i.checkpoint->'nativeSheet'->>'fileId'=i.checkpoint->>'providerFileId'
  and i.checkpoint->'nativeRowsWritten'->>'fileId'=i.checkpoint->>'providerFileId'
  and i.checkpoint->'nativeRowsWritten'->>'sheetId'=i.checkpoint->'nativeSheet'->>'sheetId',false)
 else null end native_write_acknowledged,
 (content.receipt->>'content_policy_version')::integer content_policy_version,
 (content.receipt->>'planned_row_count')::integer planned_row_count,
 (content.receipt->>'automatic_row_count')::integer automatic_row_count,
 (content.receipt->>'retained_row_count')::integer retained_row_count,
 content.receipt->>'status' content_receipt_status
from private.catalog_generation_intents i
cross join lateral (
 select case when i.checkpoint ? 'safeErrorCode' then i.checkpoint->>'safeErrorCode'
   else i.safe_error_code end code
) failure
cross join lateral (select private.catalog_content_diagnostic_receipt(i.checkpoint,
 case when jsonb_typeof(i.checkpoint->'rowRecipe')='array' then jsonb_array_length(i.checkpoint->'rowRecipe') end,
 i.checkpoint->'contentPolicyVersion') receipt) content;

create or replace view public.analytics_catalog_updates as
select attempt.attempt_id, attempt.catalog_material_id, attempt.team_id,
       attempt.trigger_kind, attempt.started_at, attempt.ended_at,
       attempt.result, attempt.failure_code, attempt.delivery_verified_at,
       attempt.profile_version, attempt.source_attempt_id, attempt.stage_history,
       attempt.actual_changes,
       profile.version as current_profile_version,
       item.update_interval, item.next_run_at,
       (coalesce(item.reconciliation_required,false) or exists (
         select 1 from private.catalog_update_reconciliations pending
         where pending.catalog_material_id=attempt.catalog_material_id
       )) as reconciliation_required,
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
       profile.schedule, attempt.profile_snapshot -> 'schedule' as attempt_schedule,
 (content.receipt->>'content_policy_version')::integer content_policy_version,
 (content.receipt->>'planned_row_count')::integer planned_row_count,
 (content.receipt->>'automatic_row_count')::integer automatic_row_count,
 (content.receipt->>'retained_row_count')::integer retained_row_count,
 content.receipt->>'status' content_receipt_status
from public.team_catalog_update_attempts as attempt
join public.team_product_catalogs as catalog
  on catalog.material_id = attempt.catalog_material_id
join public.team_catalog_update_profiles as profile
  on profile.catalog_material_id = attempt.catalog_material_id
left join public.team_catalog_updater_items as item
  on item.catalog_material_id = attempt.catalog_material_id
left join private.catalog_restitch_jobs as job
  on job.catalog_material_id = attempt.catalog_material_id
left join public.team_operations as operation on operation.id = job.operation_id
cross join lateral (select private.catalog_content_diagnostic_receipt(jsonb_build_object(
 'content_policy_version',attempt.content_policy_version,'planned_row_count',attempt.planned_row_count,'automatic_row_count',attempt.automatic_row_count,'retained_row_count',attempt.retained_row_count),attempt.planned_row_count) receipt) content;

create or replace view public.analytics_launch_generations as
select g.id generation_id,g.team_id,g.launch_id,g.actor_id,g.revision_id,
 case when g.request_key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then g.request_key else null end flow_id,
 g.state,case when g.stage in('accepted','preparing','restitch_preparing','restitch_processing','restitch_uploading','catalog_planning','catalog_creating','catalog_sharing','catalog_registering','result_committing','result_committed','cancel','cleanup') then g.stage else 'unknown' end stage,
 g.state_version::text,g.attempt_no,g.retryable,g.cancel_requested_at,g.created_at,g.updated_at,
 g.lease_expires_at,g.next_attempt_at,
 case when g.safe_error_code in('CATALOG_IMAGE_UPGRADE_REQUIRED','CATALOG_IMAGE_IMPORT_DISABLED','IMAGE_QUOTA_EXCEEDED','IMAGE_UPLOAD_CAPACITY_BUSY','IMAGE_MANIFEST_INCOMPLETE','IMAGE_SOURCE_UNAVAILABLE','IMAGE_SOURCE_CHANGED','IMAGE_LOCAL_SOURCE_REQUIRED','IMAGE_UNSUPPORTED_FORMAT','IMAGE_TOO_LARGE','IMAGE_DIMENSIONS_INVALID','IMAGE_ANIMATED_UNSUPPORTED','IMAGE_ORIENTATION_UNSUPPORTED','IMAGE_CONTENT_INVALID','IMAGE_CLASSIFICATION_CONFLICT','IMAGE_TEXT_PAIRING_CONFLICT','IMAGE_PROVIDER_UNAVAILABLE','IMAGE_PROVIDER_RATE_LIMITED','IMAGE_PUBLIC_VERIFICATION_FAILED','IMAGE_WRITE_UNCERTAIN','IMAGE_DICTIONARY_COMMIT_FAILED','IMAGE_PUBLICATION_REVOKED','IMAGE_CLIPBOARD_UNAVAILABLE','IDEMPOTENCY_CONFLICT','GLOBAL_IMAGE_POOL_UNAVAILABLE','GLOBAL_IMAGE_READINESS_UNKNOWN','GLOBAL_IMAGE_ALLOCATION_UNKNOWN','GLOBAL_IMAGE_SETTINGS_RETIRED','GLOBAL_IMAGE_CLIENT_UPGRADE_REQUIRED','GLOBAL_IMAGE_POLICY_CONFLICT','GLOBAL_IMAGE_CLEANUP_UNKNOWN','INVALID_INPUT','INVALID_RESPONSE','SOURCE_CHANGED','PERMISSION_DENIED','NOT_FOUND','SPACE_BLOCKED','LAUNCH_BUSY','LAUNCH_VERSION_CONFLICT','LAUNCH_URL_INVALID','LAUNCH_SUB_INVALID','LAUNCH_BUDGET_INVALID','LAUNCH_RESULT_UNCERTAIN','LEASE_MISMATCH','DRIVE_UNAVAILABLE','DRIVE_FILE_MISSING','AGENT_UPDATE_REQUIRED','AGENT_REQUIRED','NEEDS_REAUTH','RESTITCH_INVALID','RESTITCH_NO_SCREENS','RESTITCH_POOL_EMPTY','RESTITCH_SOURCE_FORBIDDEN','RESTITCH_SOURCES_INVALID','RESTITCH_CLIENT_OUTDATED','PROCESS_FAILED','PROCESS_CANCELED','WRONG_STATE','LAUNCH_INTERNAL_ERROR','SHARE_NOT_ALLOWED','NO_WORK') then g.safe_error_code when g.safe_error_code is not null then 'UNKNOWN' else null end safe_error_code,
 case when r.config->>'method'='catalog' then 'catalog' else 'other' end method,
 coalesce(l.active_revision_id=g.revision_id,false) result_is_active,
 exists(select 1 from public.team_launch_revision_catalogs c where c.revision_id=g.revision_id) catalog_registered,
 coalesce((select jsonb_agg(jsonb_build_object('stage',s.stage,'state',s.state,'child_operation_id',s.team_operation_id,'created_at',s.created_at,'updated_at',s.updated_at) order by s.created_at,s.id)
 from public.team_launch_generation_steps s where s.generation_id=g.id and s.stage in('preparing','restitch_preparing','restitch_processing','restitch_uploading','catalog_planning','catalog_creating','catalog_sharing','catalog_registering','result_committing','cleanup')),'[]'::jsonb) steps,
 jsonb_build_object(
  'video_operation_id',(select c.restitch_operation_id from public.team_launch_revision_catalogs c where c.revision_id=r.id and c.team_id=g.team_id),
  'video_generation_id',(select prep.generation_id from public.team_launch_revision_catalogs c
    join private.launch_restitch_preparations prep on prep.team_id=c.team_id and prep.operation_id=c.restitch_operation_id
    where c.revision_id=r.id and c.team_id=g.team_id limit 1),
  'catalog_revision_id',(select prior.revision_id from public.team_launch_revision_catalogs c
    join public.team_launch_revision_catalogs prior on prior.team_id=c.team_id and prior.material_id=c.material_id and prior.revision_id=r.base_revision_id
    where c.revision_id=r.id and c.team_id=g.team_id)
 ) reuse_evidence,
 jsonb_build_object(
  'required',exists(select 1 from jsonb_each(r.config->'subConfig') c where jsonb_typeof(c.value)='array' and c.value ? 'catalogName'),
  'resolved',exists(select 1 from private.catalog_generation_intents i where i.team_id=g.team_id and i.request_key='launch:'||g.id::text||':catalog' and i.checkpoint ? 'launchSubBinding'),
  'committed',g.state='succeeded' and exists(select 1 from private.catalog_generation_intents i join public.team_launch_revision_catalogs c on c.revision_id=r.id and c.team_id=g.team_id where i.team_id=g.team_id and i.request_key='launch:'||g.id::text||':catalog' and i.state='registered' and i.checkpoint->'launchSubBinding'->>'advertisingUrl'=r.generated_url and i.checkpoint->'launchSubBinding'->'subValues'=r.sub_values)
 ) catalog_sub_binding
from public.team_launch_generations g join public.team_launch_revisions r on r.id=g.revision_id and r.team_id=g.team_id join public.team_launches l on l.id=g.launch_id and l.team_id=g.team_id;

revoke all on public.analytics_catalog_generations,public.analytics_catalog_updates,public.analytics_launch_generations from public,anon,authenticated,service_role;
grant select on public.analytics_catalog_generations,public.analytics_catalog_updates,public.analytics_launch_generations to service_role;
do $$ begin
 if exists(select 1 from pg_catalog.pg_roles where rolname='wishly_analytics_ro') then
  revoke all on public.analytics_catalog_generations,public.analytics_catalog_updates,public.analytics_launch_generations from wishly_analytics_ro;
  grant select on public.analytics_catalog_generations,public.analytics_catalog_updates,public.analytics_launch_generations to wishly_analytics_ro;
  grant execute on function private.catalog_content_diagnostic_receipt(jsonb,integer,jsonb) to wishly_analytics_ro;
 end if;
end $$;
commit;
