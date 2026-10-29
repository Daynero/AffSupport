-- Bounded, content-free evidence for agent-readable cancellation diagnosis.
create view public.analytics_launch_cleanup with (security_barrier=true) as
select g.id generation_id,g.actor_id,g.updated_at generation_updated_at,
 o.id operation_id,o.state operation_state,i.launch_upload_phase upload_phase,
 i.launch_upload_quiesced_at is not null quiescence_proven,
 i.provider_result_id is not null provider_result_known,
 exists(select 1 from public.team_materials m where m.drive_file_id=i.provider_result_id) registered_output_present,
 i.updated_at
from public.team_launch_generations g
join public.team_launch_generation_steps s on s.generation_id=g.id and s.team_operation_id is not null
join public.team_operations o on o.id=s.team_operation_id and o.team_id=g.team_id
join private.team_operation_intents i on i.operation_id=o.id and i.team_id=g.team_id
where i.tool_id='restitch';
revoke all on public.analytics_launch_cleanup from public,anon,authenticated,service_role;
do $$begin if exists(select 1 from pg_roles where rolname='wishly_analytics_ro') then
 grant select on public.analytics_launch_cleanup to wishly_analytics_ro;end if;end $$;
