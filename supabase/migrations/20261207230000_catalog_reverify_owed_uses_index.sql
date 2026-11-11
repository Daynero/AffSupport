-- The per-minute recovery listing evaluates initial_publication_reverify_owed for
-- every registered intent of the last 7 days. Its "no policy" test compared
-- catalog_material_id::text with the checkpoint text, which cannot use the
-- primary key, so each evaluation scanned every publication policy. Compare as
-- uuid (guarded, so a malformed checkpoint never breaks the listing).
begin;
create or replace function private.initial_publication_reverify_owed(i private.catalog_generation_intents) returns boolean language sql stable security definer set search_path='' as $$
 select i.state='registered' and i.request_payload->>'catalogVideoProtocolVersion'='1'
 and jsonb_typeof(i.checkpoint->'initialVideoPlan')='object'
 and i.checkpoint->>'materialId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
 and (
  exists(select 1 from private.catalog_initial_publication_checks ic join private.catalog_video_publication_jobs j on j.id=ic.job_id where ic.intent_id=i.id and ic.state='reading' and j.state='blocked' and j.blocked_reason='legacy_adoption_required')
  or (
   i.created_at>statement_timestamp()-interval '7 days'
   and not exists(select 1 from private.catalog_initial_publication_checks ic where ic.intent_id=i.id)
   and not exists(select 1 from private.catalog_video_publication_policies p where p.catalog_material_id=(i.checkpoint->>'materialId')::uuid)
  )
 )
$$;
revoke all on function private.initial_publication_reverify_owed(private.catalog_generation_intents) from public,anon,authenticated,service_role;
commit;
