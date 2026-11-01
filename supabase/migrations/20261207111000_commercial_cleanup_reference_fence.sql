-- Commercial mutation receipts contain JSON, including future fields. Keep them
-- inside the conservative reference inventory and late-reference fence so adding
-- the commercial feature does not pause every task attachment cleanup.
begin;
create trigger task_cleanup_reference_fence
 before insert or update on private.commercial_tariff_mutations
 for each row execute function private.guard_task_cleanup_reference();
commit;
