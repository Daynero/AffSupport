-- Agent-readable authoritative evidence. This projection cannot expose tracking URLs or content.
create view public.analytics_launch_generations as
select g.id generation_id,g.team_id,g.launch_id,g.actor_id,g.revision_id,
 case when g.request_key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then g.request_key else null end flow_id,
 g.state,case when g.stage in('accepted','preparing','restitch_preparing','restitch_processing','restitch_uploading','catalog_planning','catalog_creating','catalog_sharing','catalog_registering','result_committing','result_committed','cancel','cleanup') then g.stage else 'unknown' end stage,
 g.state_version::text,g.attempt_no,g.retryable,g.cancel_requested_at,g.created_at,g.updated_at,
 g.lease_expires_at,g.next_attempt_at,
 case when g.safe_error_code in('INVALID_INPUT','INVALID_RESPONSE','SOURCE_CHANGED','PERMISSION_DENIED','NOT_FOUND','SPACE_BLOCKED','LAUNCH_BUSY','LAUNCH_VERSION_CONFLICT','LAUNCH_URL_INVALID','LAUNCH_SUB_INVALID','LAUNCH_BUDGET_INVALID','LAUNCH_RESULT_UNCERTAIN','LEASE_MISMATCH','DRIVE_UNAVAILABLE','DRIVE_FILE_MISSING','AGENT_UPDATE_REQUIRED','SHARE_NOT_ALLOWED','NO_WORK') then g.safe_error_code when g.safe_error_code is not null then 'UNKNOWN' else null end safe_error_code,
 case when r.config->>'method'='catalog' then 'catalog' else 'other' end method,
 l.active_revision_id=g.revision_id result_is_active,
 exists(select 1 from public.team_launch_revision_catalogs c where c.revision_id=g.revision_id) catalog_registered,
 coalesce((select jsonb_agg(jsonb_build_object('stage',s.stage,'state',s.state,'child_operation_id',s.team_operation_id,'created_at',s.created_at,'updated_at',s.updated_at) order by s.created_at,s.id)
 from public.team_launch_generation_steps s where s.generation_id=g.id and s.stage in('preparing','restitch_preparing','restitch_processing','restitch_uploading','catalog_planning','catalog_creating','catalog_sharing','catalog_registering','result_committing','cleanup')),'[]'::jsonb) steps
from public.team_launch_generations g join public.team_launch_revisions r on r.id=g.revision_id and r.team_id=g.team_id join public.team_launches l on l.id=g.launch_id and l.team_id=g.team_id;
revoke all on public.analytics_launch_generations from public,anon,authenticated;
grant select on public.analytics_launch_generations to service_role;
do $$ begin if exists(select 1 from pg_catalog.pg_roles where rolname='wishly_analytics_ro') then grant select on public.analytics_launch_generations to wishly_analytics_ro;end if;end $$;
