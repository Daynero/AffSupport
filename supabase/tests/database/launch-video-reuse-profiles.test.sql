begin;
select plan(5);
select ok(has_function_privilege('authenticated','public.patch_team_catalog_update_profile(uuid,uuid,bigint,jsonb)','execute'),'N preferences retain the existing caller-facing profile CAS boundary');
select ok(not has_function_privilege('service_role','private.launch_ready_video_reuse(uuid,uuid,uuid,jsonb,text)','execute') and not has_function_privilege('authenticated','private.launch_ready_video_reuse(uuid,uuid,uuid,jsonb,text)','execute'),'unvalidated private reuse candidate cannot be called directly');
select ok(has_function_privilege('service_role','public.service_find_launch_catalog_video_reuse(uuid,uuid,uuid,jsonb,text)','execute') and not has_function_privilege('authenticated','public.service_find_launch_catalog_video_reuse(uuid,uuid,uuid,jsonb,text)','execute') and not has_function_privilege('anon','public.service_find_launch_catalog_video_reuse(uuid,uuid,uuid,jsonb,text)','execute'),'reuse candidate is available only to the trusted admission adapter');
select ok(has_function_privilege('service_role','public.service_read_catalog_video_consumer_acceptance(uuid,uuid,uuid,uuid)','execute') and not has_function_privilege('authenticated','public.service_read_catalog_video_consumer_acceptance(uuid,uuid,uuid,uuid)','execute'),'consumer read cannot become a browser authority bypass');
select throws_ok($$select public.service_read_catalog_video_consumer_acceptance('c1740000-0000-4000-8000-000000000001','c1740000-0000-4000-8000-000000000002','c1740000-0000-4000-8000-000000000003','c1740000-0000-4000-8000-000000000004')$$,'42501','PERMISSION_DENIED','missing membership never reveals an existing recipe');
select * from finish();
rollback;
