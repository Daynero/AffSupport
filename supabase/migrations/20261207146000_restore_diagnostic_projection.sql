-- Preserve hosted restore outcomes even when browser feedback is interrupted.
begin;
create or replace view public.analytics_workspace_operations as
 select c.request_id as id,c.team_id,c.actor_id,'task_copy'::text as action,'confirmed'::text as state,
 null::text as code,cardinality(c.result_ids)::integer as item_count,cardinality(c.result_ids)::integer as confirmed_count,
 c.created_at as created_at,c.created_at as updated_at
 from private.team_task_copy_receipts c
 union all
 select c.id,c.team_id,c.actor_id,'task_cleanup',c.state,coalesce(o.error_code,c.reason),1,case when c.state='trashed' then 1 else 0 end,c.detached_at,c.updated_at from private.task_attachment_cleanup c left join public.team_operations o on o.id=c.operation_id
 union all
 select g.id,g.team_id,g.actor_id,'bulk_trash',
 case when count(*) filter(where o.state='succeeded')=count(*) then 'confirmed'
 when count(*) filter(where o.state in ('failed','canceled'))>0 then 'partial'
 when count(*) filter(where o.state in ('pending','running'))>0 then 'running' else 'unknown' end,
 min(o.error_code) filter(where o.state='failed'),
 count(*)::integer,count(*) filter(where o.state='succeeded')::integer,g.created_at,
 greatest(g.created_at,max(o.updated_at),max(i.requested_at))
 from private.team_bulk_trash_groups g join private.team_bulk_trash_items i on i.group_id=g.id
 left join public.team_operations o on o.team_id=g.team_id and o.actor_id=g.actor_id and o.kind='trash' and o.idempotency_key=i.idempotency_key
 group by g.id,g.team_id,g.actor_id,g.created_at
 union all
 select u.operation_id,u.team_id,u.actor_id,'process_output_cleanup',
 case when u.upload_state='published' then 'confirmed'
      when u.cleanup_state='not_created' then 'cancelled'
      when u.cleanup_state='not_needed' then u.upload_state else u.cleanup_state end,
 u.last_code,1,case when u.upload_state='published' or u.cleanup_state in('trashed','not_created') then 1 else 0 end,
 u.created_at,u.updated_at from private.process_upload_ownership u
 union all
 select o.id,o.team_id,o.actor_id,'restore',
 case when o.state='succeeded' then 'confirmed' when o.state='canceled' then 'cancelled' else o.state end,
 case when o.error_code is null then null
      when exists(select 1 from public.team_error_codes c where c.code=o.error_code) then o.error_code
      else 'UNKNOWN' end,
 1,case when o.state='succeeded' then 1 else 0 end,o.created_at,o.updated_at
 from public.team_operations o where o.kind='restore';
revoke all on public.analytics_workspace_operations from public,anon,authenticated;
grant select on public.analytics_workspace_operations to service_role;
do $$ begin if exists(select 1 from pg_catalog.pg_roles where rolname='wishly_analytics_ro') then grant select on public.analytics_workspace_operations to wishly_analytics_ro; end if;end $$;

commit;
