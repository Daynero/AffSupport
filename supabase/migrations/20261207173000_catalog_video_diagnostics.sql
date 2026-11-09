-- Content-free current-state evidence. Never expose pools, snapshots, URLs or grants.
begin;
create view public.analytics_catalog_video_sets with (security_barrier=true) as
select s.id video_set_id,s.team_id,s.actor_id,s.catalog_material_id,s.catalog_intent_id,s.update_attempt_id,
 s.state,s.requested_count,s.product_count,s.recipe_revision,s.revision,
 s.executor_id is not null executor_bound,s.native_instance_id is not null native_boot_observed,
 s.created_at,s.updated_at,
 (select count(*)::integer from private.catalog_video_variants v where v.video_set_id=s.id and v.state='registered') registered_count,
 (select count(*)::integer from private.catalog_video_variants v where v.video_set_id=s.id and v.state='working') working_count,
 (select count(*)::integer from private.catalog_video_variants v where v.video_set_id=s.id and v.state='unknown') unknown_count,
 (select count(*)::integer from private.catalog_video_variants v where v.video_set_id=s.id and v.state='queued') queued_count
from private.catalog_video_sets s;
create view public.analytics_catalog_video_children with (security_barrier=true) as
select v.video_set_id,v.video_variant_index,v.request_id,v.operation_id,v.state,
 v.output_material_id is not null output_registered,o.state operation_state
from private.catalog_video_variants v left join public.team_operations o on o.id=v.operation_id;
create view public.analytics_catalog_video_consumers with (security_barrier=true) as
select r.id reference_id,r.video_set_id,r.team_id,r.actor_id,r.recipe_revision,recipe.product_count,
 r.catalog_intent_id,r.update_attempt_id,c.material_id catalog_material_id
from private.catalog_video_recipe_references r
join private.catalog_video_sets s on s.id=r.video_set_id and s.team_id=r.team_id
join private.catalog_video_set_recipes recipe on recipe.video_set_id=r.video_set_id and recipe.team_id=r.team_id and recipe.recipe_revision=r.recipe_revision
left join private.catalog_generation_intents i on i.id=r.catalog_intent_id and i.team_id=r.team_id and i.actor_id=r.actor_id and i.video_material_id=s.source_material_id and i.state='registered'
left join public.team_product_catalogs c on c.team_id=r.team_id and c.video_material_id=s.source_material_id and c.material_id=coalesce(r.catalog_material_id,case when coalesce(i.result#>>'{catalog,materialId}',i.checkpoint->>'materialId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then coalesce(i.result#>>'{catalog,materialId}',i.checkpoint->>'materialId')::uuid end);
create view public.analytics_catalog_updater_video_requests with (security_barrier=true) as
select r.request_id,r.set_id video_set_id,r.team_id,r.actor_id,r.catalog_material_id,r.attempt_id,
 r.requested_count,r.profile_version,r.created_at,r.last_proven_stage,r.canceled_at is not null canceled,
 s.id is null set_admission_missing,coalesce(s.state,'accepted') state,
 to_jsonb(r)->>'failure_code' is not null failure_observed,
 case when to_jsonb(r)->>'failure_code' in('SOURCE_CHANGED','PERMISSION_DENIED','DRIVE_UNAVAILABLE','RATE_LIMITED','NOT_FOUND','RESTITCH_INVALID','PROCESS_RESULT_UNCERTAIN','RESTITCH_NO_SCREENS','RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN','INVALID_RESPONSE','SHARE_NOT_ALLOWED','RESTITCH_CLIENT_OUTDATED','RESTITCH_FORBIDDEN','RESTITCH_POOL_EMPTY','RESTITCH_SCREEN_BYTE_LIMIT','RESTITCH_SCREEN_CANDIDATES_EXHAUSTED','RESTITCH_SCREEN_IO_LIMIT','RESTITCH_SCREEN_PREVIOUS_FAILURES','RESTITCH_SCREEN_SELECTION_LIMIT','RESTITCH_SOURCES_INVALID','RESTITCH_SOURCES_TOO_MANY','RESTITCH_SOURCE_FORBIDDEN') then to_jsonb(r)->>'failure_code' end safe_failure_code
from private.catalog_updater_variant_requests r left join private.catalog_video_sets s on s.id=r.set_id;
revoke all on public.analytics_catalog_video_sets,public.analytics_catalog_video_children,public.analytics_catalog_updater_video_requests,public.analytics_catalog_video_consumers from public,anon,authenticated;
grant select on public.analytics_catalog_video_sets,public.analytics_catalog_video_children,public.analytics_catalog_updater_video_requests,public.analytics_catalog_video_consumers to service_role;
do $$ begin
 if exists(select 1 from pg_roles where rolname='wishly_analytics_ro') then
  grant select on public.analytics_catalog_video_sets,public.analytics_catalog_video_children,public.analytics_catalog_updater_video_requests,public.analytics_catalog_video_consumers to wishly_analytics_ro;
 end if;
end $$;

-- Preserve classified initial N-admission failures before a set exists.
create or replace view public.analytics_catalog_generations as
select i.id intent_id,i.team_id,i.actor_id,i.operation_id,i.attempt,
 case when i.request_key like 'launch:%' then 'launch' else 'standalone' end origin,
 case when i.state in ('reserved','planning','planned','create_started','created','finalized','registered','interrupted','cleanup_pending','canceled') then i.state else 'unknown' end state,
 case when i.state in ('interrupted','cleanup_pending') then
   case
    when i.checkpoint ? 'safeErrorCode' and jsonb_typeof(i.checkpoint->'safeErrorCode') not in ('string','null') then 'UNKNOWN'
    when failure.code in ('NEEDS_REAUTH','PERMISSION_DENIED','SOURCE_CHANGED','NOT_FOUND','RATE_LIMITED','DRIVE_UNAVAILABLE','LEASE_MISMATCH','GROUP_RECONCILING','WRONG_STATE','INVALID_RESPONSE','LAUNCH_RESULT_UNCERTAIN','LAUNCH_INTERNAL_ERROR','IMAGE_PUBLICATION_REVOKED','CATALOG_IMAGE_UPGRADE_REQUIRED','RESTITCH_SCREEN_SELECTION_LIMIT','RESTITCH_SCREEN_CANDIDATES_EXHAUSTED','RESTITCH_SCREEN_PREVIOUS_FAILURES','RESTITCH_SCREEN_BYTE_LIMIT','RESTITCH_SCREEN_IO_LIMIT','RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN','RESTITCH_SCREEN_UNAVAILABLE','RESTITCH_SCREEN_FETCH_FAILED','RESTITCH_SCREEN_UNSUPPORTED','RESTITCH_FORBIDDEN','RESTITCH_NO_SCREENS','RESTITCH_INVALID','RESTITCH_POOL_EMPTY','RESTITCH_SOURCE_FORBIDDEN','RESTITCH_SOURCES_INVALID','RESTITCH_SOURCES_TOO_MANY','RESTITCH_CLIENT_OUTDATED','PROCESS_RESULT_UNCERTAIN','AGENT_UPDATE_REQUIRED','SHARE_NOT_ALLOWED','INVALID_INPUT','CATALOG_WRITE_UNSUPPORTED') then failure.code
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
