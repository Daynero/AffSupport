-- Native beta sheet writes keep the existing bounded, content-free diagnostic seam.
begin;
create or replace function private.catalog_generation_timings_v1(value jsonb) returns jsonb language sql immutable set search_path='' as $$
 select case when jsonb_typeof(value->'attempt')='number' and value->>'attempt' ~ '^[0-9]{1,6}$'
  and jsonb_typeof(value->'steps')='object' then jsonb_build_object('attempt',(value->>'attempt')::integer,'steps',
   coalesce((select jsonb_object_agg(key,jsonb_build_object('calls',(metric->>'calls')::integer,'total_ms',(metric->>'total_ms')::bigint))
    from jsonb_each(case when jsonb_typeof(value->'steps')='object' then value->'steps' else '{}'::jsonb end) x(key,metric)
    where key=any(array['image_contract','video_context','settings','catalog_lookup','drive_client','video_proof','destination','resource_selection','row_recipe','name_conflicts','source_link','operation_start','operation_running','sheet_rows','image_validation','xlsx_build','sheet_upload','sheet_write','permission_read','permission_write','intent_binding','catalog_finalize','catalog_link','image_finalize','checkpoint'])
     and jsonb_typeof(metric->'calls')='number' and metric->>'calls' ~ '^[0-9]{1,5}$'
     and jsonb_typeof(metric->'total_ms')='number' and metric->>'total_ms' ~ '^[0-9]{1,8}$'), '{}'::jsonb)) else null end;
$$;

-- Acknowledgement is explicit; false never proves an unknown write did not apply.
create or replace view public.analytics_catalog_generations as
select i.id intent_id,i.team_id,i.actor_id,i.operation_id,i.attempt,
 case when i.request_key like 'launch:%' then 'launch' else 'standalone' end origin,
 case when i.state in ('reserved','planning','planned','create_started','created','finalized','registered','interrupted','cleanup_pending','canceled') then i.state else 'unknown' end state,
 case when i.state in ('interrupted','cleanup_pending') then
   case
    when i.checkpoint ? 'safeErrorCode' and jsonb_typeof(i.checkpoint->'safeErrorCode') <> 'string' then 'UNKNOWN'
    when failure.code in ('NEEDS_REAUTH','PERMISSION_DENIED','SOURCE_CHANGED','NOT_FOUND','RATE_LIMITED','DRIVE_UNAVAILABLE','LEASE_MISMATCH','GROUP_RECONCILING','WRONG_STATE','INVALID_RESPONSE','LAUNCH_RESULT_UNCERTAIN','LAUNCH_INTERNAL_ERROR','IMAGE_PUBLICATION_REVOKED','CATALOG_IMAGE_UPGRADE_REQUIRED') then failure.code
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
 else null end native_write_acknowledged
from private.catalog_generation_intents i
cross join lateral (
 select case when i.checkpoint ? 'safeErrorCode' then i.checkpoint->>'safeErrorCode'
   else i.safe_error_code end code
) failure;
commit;
