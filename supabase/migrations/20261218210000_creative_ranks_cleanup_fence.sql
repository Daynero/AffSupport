-- Creative ranks (20261218200000) added two team_* tables that name a material, and
-- every such table keeps the attachment cleanup fence (20261205122000).
--
-- The fence is an inventory, not a convention: private.task_cleanup_reference_tables()
-- lists every table that can hold a reference to a material, and
-- private.task_cleanup_coverage_verified() refuses to call the cleanup of task-owned
-- uploads safe while any of them lacks the guard. With the two rank tables unfenced
-- that answer was false for the whole database: no orphaned upload could be claimed
-- (cleanup_unverified), and a rank row could be written for a material whose removal
-- was already under way.
--
-- Additive only: two triggers on tables that already exist. `create or replace` so the
-- statement is the same whether or not a database has met it before.
begin;

create or replace trigger task_cleanup_reference_fence
  before insert or update on public.team_creative_launch_events
  for each row execute function private.guard_task_cleanup_reference();

create or replace trigger task_cleanup_reference_fence
  before insert or update on public.team_creative_ranks
  for each row execute function private.guard_task_cleanup_reference();

commit;
