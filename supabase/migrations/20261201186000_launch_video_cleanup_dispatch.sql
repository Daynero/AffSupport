-- A canceled native child has no catalog intent, so the existing catalog
-- cleanup predicate cannot wake the hosted worker for it. A durable local
-- upload receipt or a positively unstarted upload makes settlement due.
create or replace function private.launch_cleanup_due() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.team_launch_generations g join private.catalog_generation_intents i
  on i.team_id=g.team_id and i.actor_id=g.actor_id and i.request_key='launch:'||g.id::text||':catalog'
 where g.state in('cancel_requested','canceled_with_cleanup_pending')
  and (g.next_attempt_at is null or g.next_attempt_at<=clock_timestamp())
  and (g.lease_expires_at is null or g.lease_expires_at<=clock_timestamp())
  and (i.lease_expires_at is null or i.lease_expires_at<=clock_timestamp()))
 or exists(select 1 from public.team_launch_generations g
  join private.launch_restitch_preparations p on p.generation_id=g.id
  join public.team_operations o on o.team_id=g.team_id and o.actor_id=g.actor_id
   and (o.id=p.operation_id or o.idempotency_key=p.process_key)
  join private.team_operation_intents i on i.operation_id=o.id and i.team_id=g.team_id
 where g.state in('cancel_requested','canceled_with_cleanup_pending')
  and (g.next_attempt_at is null or g.next_attempt_at<=clock_timestamp())
  and (g.lease_expires_at is null or g.lease_expires_at<=clock_timestamp())
  and not exists(select 1 from private.catalog_generation_intents c where c.team_id=g.team_id
   and c.request_key='launch:'||g.id::text||':catalog')
  and o.kind='process' and o.state in('failed','canceled') and o.result_material_id is null
  and i.tool_id='restitch' and (
   i.launch_upload_phase in('not_started','cleaned') or
   (i.launch_upload_phase='started' and i.expected_size is not null
    and i.launch_upload_quiesced_at is not null)))
$$;
