begin;
select plan(3);
select ok(not has_function_privilege('authenticated','private.filter_process_output_catalog_files(jsonb)','execute'),'catalog ownership filter is private');
select has_column('public','analytics_process_output_cleanup','provider_material_registered','agent can explain a material reference fence safely');
select has_column('public','analytics_process_output_cleanup','provider_result_recorded','agent can explain a recorded result fence safely');
select * from finish();
rollback;
