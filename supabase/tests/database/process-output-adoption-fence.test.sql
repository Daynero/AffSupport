begin;
select plan(4);
select has_column('private','process_upload_ownership','cleanup_mutation_started_at','provider mutation reservation is durable');
select ok(not has_function_privilege('authenticated','public.service_begin_process_output_trash(uuid,uuid,text)','execute'),'client cannot begin cleanup');
select ok(has_function_privilege('service_role','public.service_begin_process_output_trash(uuid,uuid,text)','execute'),'service can begin scoped cleanup');
select has_trigger('public','team_materials','process_output_adoption_fence','material insert and identity rebind are fenced');
select * from finish();
rollback;
