-- Read-only order evidence. Account and agent IDs, ordered arrays, and team IDs stay private.
create view public.analytics_account_order_receipts as
select actor_id, request_id,
  case when scope_id = team_id then 'socials' else 'agents' end as scope_kind,
  (result ->> 'version')::bigint as result_version,
  created_at
from private.team_account_order_requests;

revoke all on public.analytics_account_order_receipts from public, anon, authenticated;
grant select on public.analytics_account_order_receipts to wishly_analytics_ro;
