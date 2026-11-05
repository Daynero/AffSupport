begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(6);

select ok(has_table_privilege('wishly_analytics_ro','public.analytics_catalog_claim_eligibility','select'),
 'read-only analytics can inspect current claim eligibility');
select ok(not has_table_privilege('authenticated','public.analytics_catalog_claim_eligibility','select')
 and not has_table_privilege('anon','public.analytics_catalog_claim_eligibility','select')
 and not has_table_privilege('service_role','public.analytics_catalog_claim_eligibility','select'),
 'eligibility is not exposed as a client or service data endpoint');
select ok(not has_table_privilege('wishly_analytics_ro','public.analytics_catalog_claim_eligibility','insert,update,delete'),
 'analytics cannot mutate eligibility');
select ok(not has_function_privilege('authenticated','private.catalog_restitch_actor_blockers(uuid,uuid,text)','execute')
 and not has_function_privilege('authenticated','private.catalog_restitch_job_blockers(uuid)','execute'),
 'client cannot call private eligibility functions');
select ok(has_function_privilege('wishly_analytics_ro','private.catalog_restitch_actor_blockers(uuid,uuid,text)','execute')
 and has_function_privilege('wishly_analytics_ro','private.catalog_restitch_job_blockers(uuid)','execute'),
 'view consumers can execute its read-only predicates');
select ok(has_function_privilege('service_role','public.service_claim_restitch_job(uuid,uuid,bytea,integer)','execute')
 and not has_function_privilege('authenticated','public.service_claim_restitch_job(uuid,uuid,bytea,integer)','execute'),
 'job mutation remains service-only');
select * from finish();
rollback;
