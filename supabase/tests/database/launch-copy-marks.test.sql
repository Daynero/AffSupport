begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(11);
select is(encode(extensions.hmac(convert_to('abc','UTF8'),decode('010203','hex'),'sha256'),'hex'),
 '200fd2f9dada90b91212225a6b5e5975512edffd02503bb98ea612ca904daa24',
 'native pgcrypto HMAC matches an independently computed SHA-256 vector');
select ok(not has_table_privilege('authenticated','private.launch_copy_keys','SELECT'),'personal HMAC keys are never browser-readable');
select ok(not has_table_privilege('authenticated','private.launch_copy_marks','SELECT'),'receipts require the protected read boundary');
select ok(not has_table_privilege('service_role','private.launch_copy_marks','SELECT'),'receipt fingerprints are not a service analytics projection');
select ok(not has_function_privilege('anon','public.get_launch_copy_marks(uuid,uuid,uuid,uuid,jsonb)','EXECUTE'),'anonymous mark reads denied');
select ok(has_function_privilege('authenticated','public.get_launch_copy_marks(uuid,uuid,uuid,uuid,jsonb)','EXECUTE'),'member reads use an ACL-checked RPC');
select ok(has_function_privilege('authenticated','public.set_launch_copy_marks(uuid,uuid,uuid,uuid,jsonb,boolean)','EXECUTE'),'personal writes use an ACL-checked RPC');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='private.launch_copy_marks'::regclass),'personal receipts force RLS');
select ok(exists(select 1 from pg_trigger where tgrelid='private.launch_copy_keys'::regclass and tgname='task_cleanup_reference_fence' and tgenabled='O' and tgfoid='private.guard_task_cleanup_reference()'::regprocedure),'personal key records retain the shared cleanup fence');
select ok(exists(select 1 from pg_trigger where tgrelid='private.launch_copy_marks'::regclass and tgname='task_cleanup_reference_fence' and tgenabled='O' and tgfoid='private.guard_task_cleanup_reference()'::regprocedure),'copy receipts retain the shared cleanup fence');
select ok(private.task_cleanup_coverage_verified(),'copy marks do not create a global cleanup coverage gap');
select * from finish();
rollback;
