-- One content-free row per hosted group for the SELECT-only diagnostic role.
create view public.analytics_bulk_trash_receipts as
with items as (
  select g.id as group_id, g.actor_id, g.request_id, g.created_at,
    op.updated_at as operation_at,
    case
      when op.id is null and i.attempted_at is null then 'queued'
      when op.id is null then 'unknown'
      when op.state = 'succeeded' and m.lifecycle = 'trashed' then 'confirmed'
      when op.state = 'succeeded' then 'unknown'
      when op.state in ('failed','canceled') then 'failed'
      else 'active'
    end as state,
    case when op.state in ('failed','canceled') and op.error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'
      then op.error_code else null end as error_code
  from private.team_bulk_trash_groups g
  join private.team_bulk_trash_items i on i.group_id = g.id
  left join public.team_materials m on m.id = i.material_id and m.team_id = g.team_id
  left join public.team_operations op on op.team_id = g.team_id
    and op.actor_id = g.actor_id and op.kind = 'trash'
    and op.idempotency_key = i.idempotency_key::text
    and op.source_material_id = i.material_id
)
select group_id, actor_id, request_id, created_at,
  count(*)::integer as item_count,
  count(*) filter (where state = 'queued')::integer as queued_count,
  count(*) filter (where state = 'active')::integer as active_count,
  count(*) filter (where state = 'confirmed')::integer as confirmed_count,
  count(*) filter (where state = 'failed')::integer as failed_count,
  count(*) filter (where state = 'unknown')::integer as unknown_count,
  max(operation_at) as last_operation_at,
  (array_agg(distinct error_code) filter (where error_code is not null))[1:10] as error_codes
from items group by group_id, actor_id, request_id, created_at;

revoke all on public.analytics_bulk_trash_receipts from public, anon, authenticated;
grant select on public.analytics_bulk_trash_receipts to wishly_analytics_ro;
