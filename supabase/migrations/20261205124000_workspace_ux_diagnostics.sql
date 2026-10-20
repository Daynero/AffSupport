begin;
create view public.analytics_workspace_operations as
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
 group by g.id,g.team_id,g.actor_id,g.created_at;
revoke all on public.analytics_workspace_operations from public,anon,authenticated;
grant select on public.analytics_workspace_operations to service_role;
do $$ begin if exists(select 1 from pg_catalog.pg_roles where rolname='wishly_analytics_ro') then grant select on public.analytics_workspace_operations to wishly_analytics_ro; end if; end $$;
-- Read-model invalidation has one existing Realtime owner and no content payload.
create function private.signal_task_cleanup_change() returns trigger language plpgsql set search_path='' as $$
begin
 insert into public.team_catalog_events(team_id,material_id,event_kind) values(new.team_id,new.material_id,'upserted');
 return new;
end $$;
create trigger signal_task_cleanup_change after insert or update of state,reason on private.task_attachment_cleanup for each row execute function private.signal_task_cleanup_change();
revoke all on function private.signal_task_cleanup_change() from public,anon,authenticated;
commit;
