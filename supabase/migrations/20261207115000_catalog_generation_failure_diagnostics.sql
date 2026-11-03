-- Existing fenced checkpoint RPC stores only a normalized closed failure code.
-- Do not expose the private JSON or infer historical transitions from it.
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
 i.state='registered' result_registered
from private.catalog_generation_intents i
cross join lateral (
 select case when i.checkpoint ? 'safeErrorCode' then i.checkpoint->>'safeErrorCode'
   else i.safe_error_code end code
) failure;

-- Reset inherited/default ACLs even when the view already exists.
revoke all on public.analytics_catalog_generations from public,anon,authenticated,service_role;
grant select on public.analytics_catalog_generations to service_role;
do $$ begin
 if exists(select 1 from pg_catalog.pg_roles where rolname='wishly_analytics_ro') then
  revoke all on public.analytics_catalog_generations from wishly_analytics_ro;
  grant select on public.analytics_catalog_generations to wishly_analytics_ro;
 end if;
end $$;
