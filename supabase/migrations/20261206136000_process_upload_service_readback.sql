begin;

-- Business finalize can read captured ownership only through its actor-scoped
-- service seam. No token, session URL or client-readable ownership table.
create function public.service_get_process_upload(p_operation uuid,p_actor uuid)
returns jsonb language sql stable security definer set search_path='' as $$
 select private.process_upload_binding(u)
 from private.process_upload_ownership u join public.team_operations o on o.id=u.operation_id
 where u.operation_id=p_operation and u.actor_id=p_actor and o.actor_id=p_actor and o.team_id=u.team_id
$$;
revoke all on function public.service_get_process_upload(uuid,uuid) from public,anon,authenticated;
grant execute on function public.service_get_process_upload(uuid,uuid) to service_role;

-- This boolean explains adoption refusal without exposing identity or content.
create or replace view public.analytics_process_output_cleanup as
 select operation_id as id,actor_id,upload_state,cleanup_state,attempts,24::integer as max_attempts,
 handoff_expires_at as captured_handoff_expires_at,next_attempt_at,lease_expires_at,created_at,updated_at,
 cleanup_mutation_started_at is not null as provider_mutation_reserved
 from private.process_upload_ownership;
revoke all on public.analytics_process_output_cleanup from public,anon,authenticated;
grant select on public.analytics_process_output_cleanup to service_role;
do $$ begin if exists(select 1 from pg_catalog.pg_roles where rolname='wishly_analytics_ro') then grant select on public.analytics_process_output_cleanup to wishly_analytics_ro; end if;end $$;

commit;
