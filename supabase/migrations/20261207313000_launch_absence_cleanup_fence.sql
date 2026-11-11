-- 20261207300000 added private.launch_video_absence_observations. Its name puts
-- it in private.task_cleanup_reference_tables(), and a listed table without the
-- task_cleanup_reference_fence trigger is a coverage gap: every task-attachment
-- cleanup then retains its file as cleanup_unverified instead of trashing it.
-- The table holds no material reference, so the fence only restores coverage.
begin;

do $fence$
begin
 if not exists(
  select 1 from pg_catalog.pg_trigger tr
  join pg_catalog.pg_class c on c.oid=tr.tgrelid
  join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where n.nspname='private' and c.relname='launch_video_absence_observations'
   and tr.tgname='task_cleanup_reference_fence'
 ) then
  create trigger task_cleanup_reference_fence
   before insert or update on private.launch_video_absence_observations
   for each row execute function private.guard_task_cleanup_reference();
 end if;
end $fence$;

commit;
