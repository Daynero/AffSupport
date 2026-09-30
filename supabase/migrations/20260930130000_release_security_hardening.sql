-- Close two security gaps exposed by the full release database suite.
-- Trigger execution does not require callers to execute its function directly.
revoke all on function private.reset_catalog_restitch_job_progress()
  from public, anon, authenticated, service_role;

-- The account's Vault pointer is only read by narrowly scoped SECURITY DEFINER
-- functions; table owners must not silently bypass its RLS policy.
alter table private.team_account_two_factor force row level security;
