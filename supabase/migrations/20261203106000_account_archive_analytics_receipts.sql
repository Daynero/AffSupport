-- Read-only commit evidence. Social IDs, team IDs and names remain private.
create view public.analytics_account_archive_receipts as
select actor_id, request_id, desired_archived,
  (result ->> 'version')::bigint as result_version,
  created_at
from private.team_account_archive_requests
where result ->> 'status' = 'applied';

revoke all on public.analytics_account_archive_receipts from public, anon, authenticated;
grant select on public.analytics_account_archive_receipts to wishly_analytics_ro;
