begin;
select plan(4);
select has_function('public','service_get_process_upload',array['uuid','uuid'],'ownership has a scoped service readback');
select ok(not has_function_privilege('authenticated','public.service_get_process_upload(uuid,uuid)','execute'),'client cannot inspect captured ownership');
select ok(has_function_privilege('service_role','public.service_get_process_upload(uuid,uuid)','execute'),'service can verify finalize identity');
select has_column('public','analytics_process_output_cleanup','provider_mutation_reserved','agent can explain adoption reservation without provider identity');
select * from finish();
rollback;
