begin;
select plan(5);
select ok(not has_function_privilege('authenticated','public.service_settle_catalog_video_cancellations(integer)','execute'),'browser cannot invoke global cancellation settlement');
select ok(has_function_privilege('service_role','public.service_settle_catalog_video_cancellations(integer)','execute'),'existing trusted worker can settle requested cancellation');
select ok(not has_function_privilege('service_role','private.catalog_video_cancel_quiescent(uuid)','execute'),'private physical proof cannot be called raw');
select ok(exists(select 1 from pg_trigger where tgrelid='public.team_operations'::regclass and tgname='catalog_variant_cancel_admission'and not tgisinternal),'late original admission has a database fence');
select throws_ok('select public.service_settle_catalog_video_cancellations(11)','22023','INVALID_INPUT','worker batch remains bounded');
select *from finish();
rollback;
