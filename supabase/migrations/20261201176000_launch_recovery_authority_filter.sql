-- Authority settlement is bounded; unrelated valid work must proceed immediately.
create or replace function public.service_list_launch_catalog_recovery(p_limit integer default 3) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if p_limit is null or p_limit not between 1 and 10 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('teamId',x.team_id,'generationId',x.id,'actorId',x.actor_id)) from (
  select g.id,g.team_id,g.actor_id from public.team_launch_generations g
  join public.team_launch_revisions r on r.id=g.revision_id
  join public.team_launches l on l.id=g.launch_id and l.archived_at is null
  where r.config->>'method'='catalog' and (r.config->'catalog'->>'restitchEnabled'='false' or private.launch_reusable_restitch(g.team_id,g.id) is not null or exists(select 1 from private.launch_restitch_preparations p join public.team_operations o on o.id=p.operation_id where p.generation_id=g.id and o.state='succeeded' and o.result_material_id is not null))
   and private.can(g.team_id,'edit',g.actor_id)
   and g.state in('accepted','running','interrupted')
   and (g.next_attempt_at is null or g.next_attempt_at<=clock_timestamp())
   and (g.lease_expires_at is null or g.lease_expires_at<=clock_timestamp())
   and (g.safe_error_code is null or g.safe_error_code in('DRIVE_UNAVAILABLE','RATE_LIMITED','LAUNCH_INTERNAL_ERROR','LAUNCH_RESULT_UNCERTAIN','GROUP_RECONCILING','LEASE_MISMATCH','UNKNOWN'))
   and not exists(select 1 from private.catalog_generation_intents i where i.team_id=g.team_id
    and i.request_key='launch:'||g.id::text||':catalog' and i.lease_expires_at>clock_timestamp())
  order by coalesce(g.next_attempt_at,g.created_at),g.id limit p_limit
 ) x),'[]');
end $$;
