-- Read-only, content-free evidence that an idempotent task copy committed.
-- Source and result task identifiers remain in the private receipt table.
create view public.analytics_task_copy_receipts as
select actor_id, request_id, cardinality(result_ids) as result_count, created_at
from private.team_task_copy_requests;

revoke all on public.analytics_task_copy_receipts from public, anon, authenticated;
grant select on public.analytics_task_copy_receipts to wishly_analytics_ro;
