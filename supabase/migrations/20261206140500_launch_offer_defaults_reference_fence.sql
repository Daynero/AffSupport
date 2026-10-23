-- Offer defaults are a new consumer table. Keep it inside the existing
-- conservative reference scan and late-reference fence, including future columns.
-- Do not exempt its JSON configuration from cleanup coverage.
begin;
create trigger task_cleanup_reference_fence
 before insert or update on public.team_launch_offer_defaults
 for each row execute function private.guard_task_cleanup_reference();
commit;
