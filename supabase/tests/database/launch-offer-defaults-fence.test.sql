begin;
select plan(6);
select ok(exists(select 1 from private.task_cleanup_reference_tables()
 where schema_name='public' and table_name='team_launch_offer_defaults'),
 'offer profiles remain inside conservative reference discovery');
select ok(exists(select 1 from pg_trigger
 where tgrelid='public.team_launch_offer_defaults'::regclass
 and tgname='task_cleanup_reference_fence' and tgenabled='O'
 and tgfoid='private.guard_task_cleanup_reference()'::regprocedure),
 'offer profiles use the actual shared late-reference guard');
select ok(private.task_cleanup_coverage_verified(),'the complete consumer schema is covered');
alter table public.team_launch_offer_defaults disable trigger task_cleanup_reference_fence;
select ok(not private.task_cleanup_coverage_verified(),'a disabled offer-profile fence fails closed');
alter table public.team_launch_offer_defaults enable trigger task_cleanup_reference_fence;
select ok(private.task_cleanup_coverage_verified(),'coverage returns when the fence is restored');
select ok(not has_function_privilege('authenticated','private.guard_task_cleanup_reference()','EXECUTE'),
 'browser actors cannot invoke the private guard directly');
select * from finish();
rollback;
