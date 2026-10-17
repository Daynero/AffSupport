-- Diagnostic role sees state and reason only, never task/material IDs or paths.
create view public.analytics_task_orphan_receipts as
select i.id as intent_id, i.detached_by as actor_id, i.detached_at,
  i.cleanup_not_before, i.state, i.reason_code, i.attempt_count,
  i.updated_at, i.operation_id is not null as has_operation
from private.team_task_orphan_intents i;

revoke all on public.analytics_task_orphan_receipts from public, anon, authenticated;
grant select on public.analytics_task_orphan_receipts to wishly_analytics_ro;
