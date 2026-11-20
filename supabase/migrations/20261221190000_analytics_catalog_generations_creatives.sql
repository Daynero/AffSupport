-- 062 (T074): catalog generations show what a catalog Launch's creatives were.
--
-- public.analytics_catalog_generations gets one LAST column, creative_diagnostics:
-- the intent checkpoint's 'creativeDiagnostics', projected only in the shape
-- parseCatalogCreativeDiagnostics (packages/shared/src/team/launches/lifecycle.ts)
-- accepts and nothing else:
--   {creativeKind, creativeCount, productCount, variationCount, customDistribution,
--    images: [{creativeOrdinal, stage, attemptId, code?}], failedOrdinal?}
-- An image code outside LAUNCH_ANALYTICS_CODES reads as 'UNKNOWN'; any other
-- deviation reads as null (never partially trusted). The closed safe_error_code
-- list learns the nine 062 codes. Grants stay: service_role and wishly_analytics_ro.
begin;

create function private.catalog_diagnostic_int_v1(v jsonb, lo integer, hi integer)
returns boolean language sql immutable set search_path = '' as $$
 select case when jsonb_typeof(v) = 'number' and v::text ~ '^[0-9]{1,3}$' then (v::text)::integer between lo and hi else false end
$$;
revoke all on function private.catalog_diagnostic_int_v1(jsonb, integer, integer) from public, anon, authenticated;
grant execute on function private.catalog_diagnostic_int_v1(jsonb, integer, integer) to service_role;

create function private.catalog_creative_diagnostics_v1(p jsonb)
returns jsonb language sql immutable set search_path = '' as $$
 select case when jsonb_typeof(p) is distinct from 'object' or jsonb_typeof(p->'images') is distinct from 'array' then null
  when p->>'creativeKind' in ('video', 'image')
   and private.catalog_diagnostic_int_v1(p->'creativeCount', 1, 400)
   and private.catalog_diagnostic_int_v1(p->'productCount', 1, 400)
   and private.catalog_diagnostic_int_v1(p->'variationCount', 0, 400)
   and jsonb_typeof(p->'customDistribution') = 'boolean'
   and jsonb_array_length(p->'images') <= 400
   and (not (p ? 'failedOrdinal') or private.catalog_diagnostic_int_v1(p->'failedOrdinal', 0, 399))
   and not exists(select 1 from jsonb_array_elements(p->'images') e(image) where not coalesce(
     jsonb_typeof(e.image) = 'object'
     and private.catalog_diagnostic_int_v1(e.image->'creativeOrdinal', 0, 399)
     and e.image->>'stage' in ('creative_image.accepted', 'creative_image.published', 'creative_image.verified', 'creative_image.failed')
     and e.image ? 'attemptId'
     and (jsonb_typeof(e.image->'attemptId') = 'null' or (jsonb_typeof(e.image->'attemptId') = 'string'
       and e.image->>'attemptId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
     and (not (e.image ? 'code') or jsonb_typeof(e.image->'code') = 'string'), false))
  then jsonb_build_object(
   'creativeKind', p->>'creativeKind',
   'creativeCount', (p->>'creativeCount')::integer,
   'productCount', (p->>'productCount')::integer,
   'variationCount', (p->>'variationCount')::integer,
   'customDistribution', (p->>'customDistribution')::boolean,
   'images', coalesce((select jsonb_agg(jsonb_build_object(
       'creativeOrdinal', (e.image->>'creativeOrdinal')::integer,
       'stage', e.image->>'stage',
       'attemptId', case when jsonb_typeof(e.image->'attemptId') = 'string' then lower(e.image->>'attemptId') end)
     || case when e.image ? 'code' then jsonb_build_object('code', case when e.image->>'code' in (
   'RESTITCH_SCREEN_CANDIDATES_EXHAUSTED','RESTITCH_SCREEN_PREVIOUS_FAILURES','RESTITCH_SCREEN_BYTE_LIMIT',
   'RESTITCH_SCREEN_IO_LIMIT','RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN','RESTITCH_SCREEN_UNAVAILABLE',
   'RESTITCH_SCREEN_FETCH_FAILED','RESTITCH_SCREEN_UNSUPPORTED','STITCH_INTERRUPTED','STITCH_TOOL_FAILED',
   'STITCH_PATH_INVALID','STITCH_PLAN_VIDEO_CODEC','STITCH_PLAN_AUDIO_CODEC',
   'STITCH_PLAN_VARIABLE_FRAME_RATE','STITCH_PLAN_CONTAINER','STITCH_PLAN_UNREADABLE',
   'STITCH_PLAN_NOTHING_TO_REMOVE','STITCH_PLAN_NO_SCREENS','STITCH_OUTPUT_UNWRITABLE',
   'STITCH_VERIFICATION_FAILED','STITCH_IMAGE_UNAVAILABLE','STITCH_JOIN_FAILED','STITCH_AUDIO_MISMATCH',
   'MEDIA_TOOL_UNAVAILABLE','SILENCE_BANK_FAILED','SCREEN_ENCODE_FAILED','SCREEN_SILENCE_FAILED',
   'SCREEN_MUX_FAILED','BODY_PREPARE_FAILED','BODY_REMUX_FAILED','BODY_HEAD_FAILED','BODY_TAIL_FAILED',
   'BODY_AUDIO_MISMATCH','BODY_RECOVERY_FAILED','BODY_RECOVERY_VERIFICATION_FAILED','BODY_TIMING_UNREADABLE',
   'BODY_JOIN_FAILED','PROCESS_RESULT_UNCERTAIN','CATALOG_IMAGE_UPGRADE_REQUIRED',
   'CATALOG_IMAGE_IMPORT_DISABLED','IMAGE_QUOTA_EXCEEDED','IMAGE_UPLOAD_CAPACITY_BUSY',
   'IMAGE_MANIFEST_INCOMPLETE','IMAGE_SOURCE_UNAVAILABLE','IMAGE_SOURCE_CHANGED',
   'IMAGE_LOCAL_SOURCE_REQUIRED','IMAGE_UNSUPPORTED_FORMAT','IMAGE_TOO_LARGE','IMAGE_DIMENSIONS_INVALID',
   'IMAGE_ANIMATED_UNSUPPORTED','IMAGE_ORIENTATION_UNSUPPORTED','IMAGE_CONTENT_INVALID',
   'IMAGE_CLASSIFICATION_CONFLICT','IMAGE_TEXT_PAIRING_CONFLICT','IMAGE_PROVIDER_UNAVAILABLE',
   'IMAGE_PROVIDER_RATE_LIMITED','IMAGE_PUBLIC_VERIFICATION_FAILED','IMAGE_WRITE_UNCERTAIN',
   'IMAGE_DICTIONARY_COMMIT_FAILED','IMAGE_PUBLICATION_REVOKED','IMAGE_CLIPBOARD_UNAVAILABLE',
   'IDEMPOTENCY_CONFLICT','GLOBAL_IMAGE_POOL_UNAVAILABLE','GLOBAL_IMAGE_READINESS_UNKNOWN',
   'GLOBAL_IMAGE_ALLOCATION_UNKNOWN','GLOBAL_IMAGE_SETTINGS_RETIRED','GLOBAL_IMAGE_CLIENT_UPGRADE_REQUIRED',
   'GLOBAL_IMAGE_POLICY_CONFLICT','GLOBAL_IMAGE_CLEANUP_UNKNOWN','INVALID_INPUT','INVALID_RESPONSE',
   'SOURCE_CHANGED','PERMISSION_DENIED','NOT_FOUND','SPACE_BLOCKED','LAUNCH_BUSY','LAUNCH_VERSION_CONFLICT',
   'LAUNCH_URL_INVALID','LAUNCH_SUB_INVALID','LAUNCH_BUDGET_INVALID','LAUNCH_RESULT_UNCERTAIN',
   'LEASE_MISMATCH','DRIVE_UNAVAILABLE','DRIVE_FILE_MISSING','AGENT_UPDATE_REQUIRED','AGENT_REQUIRED',
   'NEEDS_REAUTH','RESTITCH_INVALID','RESTITCH_NO_SCREENS','RESTITCH_POOL_EMPTY','RESTITCH_SOURCE_FORBIDDEN',
   'RESTITCH_SOURCES_INVALID','RESTITCH_CLIENT_OUTDATED','PROCESS_FAILED','PROCESS_CANCELED','WRONG_STATE',
   'LAUNCH_INTERNAL_ERROR','SHARE_NOT_ALLOWED','NO_WORK','CREATIVES_MIXED','CREATIVES_LIMIT',
   'CREATIVE_DUPLICATE','DISTRIBUTION_INVALID','VARIATIONS_RANGE','CREATIVE_IMAGE_FORMAT',
   'CREATIVE_IMAGE_TOO_LARGE','PUBLIC_READ_UNVERIFIED','MULTI_CREATIVE_UNSUPPORTED','UNKNOWN'
       ) then e.image->>'code' else 'UNKNOWN' end) else '{}'::jsonb end order by e.ordinality)
     from jsonb_array_elements(p->'images') with ordinality e(image, ordinality)), '[]'::jsonb))
   || case when p ? 'failedOrdinal' then jsonb_build_object('failedOrdinal', (p->>'failedOrdinal')::integer) else '{}'::jsonb end
 end
$$;
revoke all on function private.catalog_creative_diagnostics_v1(jsonb) from public, anon, authenticated;
grant execute on function private.catalog_creative_diagnostics_v1(jsonb) to service_role;

create or replace view public.analytics_catalog_generations as
select i.id intent_id,i.team_id,i.actor_id,i.operation_id,i.attempt,
 case when i.request_key like 'launch:%' then 'launch' else 'standalone' end origin,
 case when i.state in ('reserved','planning','planned','create_started','created','finalized','registered','interrupted','cleanup_pending','canceled') then i.state else 'unknown' end state,
 case when i.state in ('interrupted','cleanup_pending') then
   case
    when i.checkpoint ? 'safeErrorCode' and jsonb_typeof(i.checkpoint->'safeErrorCode') not in ('string','null') then 'UNKNOWN'
    when failure.code in ('CATALOG_IMAGE_UPGRADE_REQUIRED','CATALOG_IMAGE_IMPORT_DISABLED','IMAGE_QUOTA_EXCEEDED','IMAGE_UPLOAD_CAPACITY_BUSY','IMAGE_MANIFEST_INCOMPLETE','IMAGE_SOURCE_UNAVAILABLE','IMAGE_SOURCE_CHANGED','IMAGE_LOCAL_SOURCE_REQUIRED','IMAGE_UNSUPPORTED_FORMAT','IMAGE_TOO_LARGE','IMAGE_DIMENSIONS_INVALID','IMAGE_ANIMATED_UNSUPPORTED','IMAGE_ORIENTATION_UNSUPPORTED','IMAGE_CONTENT_INVALID','IMAGE_CLASSIFICATION_CONFLICT','IMAGE_TEXT_PAIRING_CONFLICT','IMAGE_PROVIDER_UNAVAILABLE','IMAGE_PROVIDER_RATE_LIMITED','IMAGE_PUBLIC_VERIFICATION_FAILED','IMAGE_WRITE_UNCERTAIN','IMAGE_DICTIONARY_COMMIT_FAILED','IMAGE_PUBLICATION_REVOKED','IMAGE_CLIPBOARD_UNAVAILABLE','IDEMPOTENCY_CONFLICT','GLOBAL_IMAGE_POOL_UNAVAILABLE','GLOBAL_IMAGE_READINESS_UNKNOWN','GLOBAL_IMAGE_ALLOCATION_UNKNOWN','GLOBAL_IMAGE_SETTINGS_RETIRED','GLOBAL_IMAGE_CLIENT_UPGRADE_REQUIRED','GLOBAL_IMAGE_POLICY_CONFLICT','GLOBAL_IMAGE_CLEANUP_UNKNOWN','NEEDS_REAUTH','PERMISSION_DENIED','SOURCE_CHANGED','NOT_FOUND','RATE_LIMITED','DRIVE_UNAVAILABLE','LEASE_MISMATCH','GROUP_RECONCILING','WRONG_STATE','INVALID_RESPONSE','LAUNCH_RESULT_UNCERTAIN','LAUNCH_INTERNAL_ERROR','IMAGE_PUBLICATION_REVOKED','CATALOG_IMAGE_UPGRADE_REQUIRED','RESTITCH_SCREEN_SELECTION_LIMIT','RESTITCH_SCREEN_CANDIDATES_EXHAUSTED','RESTITCH_SCREEN_PREVIOUS_FAILURES','RESTITCH_SCREEN_BYTE_LIMIT','RESTITCH_SCREEN_IO_LIMIT','RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN','RESTITCH_SCREEN_UNAVAILABLE','RESTITCH_SCREEN_FETCH_FAILED','RESTITCH_SCREEN_UNSUPPORTED','RESTITCH_FORBIDDEN','RESTITCH_NO_SCREENS','RESTITCH_INVALID','RESTITCH_POOL_EMPTY','RESTITCH_SOURCE_FORBIDDEN','RESTITCH_SOURCES_INVALID','RESTITCH_SOURCES_TOO_MANY','RESTITCH_CLIENT_OUTDATED','PROCESS_RESULT_UNCERTAIN','AGENT_UPDATE_REQUIRED','SHARE_NOT_ALLOWED','INVALID_INPUT','CATALOG_WRITE_UNSUPPORTED',
     'CREATIVES_MIXED','CREATIVES_LIMIT','CREATIVE_DUPLICATE','DISTRIBUTION_INVALID','VARIATIONS_RANGE','CREATIVE_IMAGE_FORMAT','CREATIVE_IMAGE_TOO_LARGE','PUBLIC_READ_UNVERIFIED','MULTI_CREATIVE_UNSUPPORTED') then failure.code
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
 content.receipt->>'status' content_receipt_status,
 private.catalog_creative_diagnostics_v1(i.checkpoint->'creativeDiagnostics') creative_diagnostics
from private.catalog_generation_intents i
cross join lateral (
 select case when i.checkpoint ? 'safeErrorCode' then i.checkpoint->>'safeErrorCode'
   else i.safe_error_code end code
) failure
cross join lateral (select private.catalog_content_diagnostic_receipt(i.checkpoint,
 case when jsonb_typeof(i.checkpoint->'rowRecipe')='array' then jsonb_array_length(i.checkpoint->'rowRecipe') end,
 i.checkpoint->'contentPolicyVersion') receipt) content;

revoke all on public.analytics_catalog_generations from public, anon, authenticated, service_role;
grant select on public.analytics_catalog_generations to service_role;
do $$ begin
 if exists(select 1 from pg_catalog.pg_roles where rolname = 'wishly_analytics_ro') then
  revoke all on public.analytics_catalog_generations from wishly_analytics_ro;
  grant select on public.analytics_catalog_generations to wishly_analytics_ro;
  grant execute on function private.catalog_creative_diagnostics_v1(jsonb) to wishly_analytics_ro;
  grant execute on function private.catalog_diagnostic_int_v1(jsonb, integer, integer) to wishly_analytics_ro;
 end if;
end $$;

commit;
