begin;
-- New team tables participate in the conservative attachment reference inventory.
-- Keep its coverage complete instead of silently disabling orphan cleanup.
create trigger task_cleanup_reference_fence
  before insert or update on public.team_membership_access_signals
  for each row execute function private.guard_task_cleanup_reference();
commit;
