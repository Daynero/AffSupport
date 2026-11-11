-- 20261207196000 created private.catalog_initial_publication_reverify (it
-- names catalog materials) without the task-cleanup reference fence every such
-- table carries, so private.task_cleanup_coverage_verified() turned false and
-- task attachment cleanup refused to accept work. Idempotent: another branch
-- may add the same fence.
begin;
do $fence$
begin
  if not exists (
    select 1 from pg_catalog.pg_trigger tr
    join pg_catalog.pg_class c on c.oid = tr.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'private' and c.relname = 'catalog_initial_publication_reverify'
      and tr.tgname = 'task_cleanup_reference_fence'
  ) then
    create trigger task_cleanup_reference_fence
      before insert or update on private.catalog_initial_publication_reverify
      for each row execute function private.guard_task_cleanup_reference();
  end if;
end
$fence$;
commit;
