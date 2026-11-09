begin;
select plan(5);
select ok(has_function_privilege('service_role','public.service_begin_catalog_nonvideo_update_write(uuid,text,uuid,text,integer,integer,jsonb,text)','execute') and not has_function_privilege('authenticated','public.service_begin_catalog_nonvideo_update_write(uuid,text,uuid,text,integer,integer,jsonb,text)','execute'),'ordinary policy writer admission remains service-only');
select ok(not has_function_privilege('service_role','private.catalog_nonvideo_update_context(uuid,text)','execute') and not has_function_privilege('authenticated','private.catalog_nonvideo_update_context(uuid,text)','execute'),'private preservation token cannot be read directly');
select ok(not has_function_privilege('service_role','private.nonvideo_legacy_complete_catalog_update(uuid,text,integer,uuid,integer,jsonb)','execute'),'service cannot bypass the original multi-phase parent completion guard');
select ok(has_function_privilege('authenticated','public.list_team_catalog_manager_snapshot(uuid)','execute') and not has_function_privilege('anon','public.list_team_catalog_manager_snapshot(uuid)','execute'),'registry desired K/N uses the existing authenticated team boundary');
select throws_ok($$select public.service_read_catalog_nonvideo_update_context('c1770000-0000-4000-8000-000000000001','not-an-owning-worker')$$,'55000','LEASE_MISMATCH','missing lease never invents blank or active video cells');
select * from finish();
rollback;
