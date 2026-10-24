-- Execution metadata is a registered consumer too: job IDs can identify a
-- catalog material. Preserve the conservative coverage and late-reference fence.
begin;
create trigger task_cleanup_reference_fence
 before insert or update on private.team_recovery_execution_fences
 for each row execute function private.guard_task_cleanup_reference();
commit;
