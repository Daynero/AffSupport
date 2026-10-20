begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(17);

select ok((select relrowsecurity and relforcerowsecurity from pg_class
           where oid='public.team_catalog_update_profiles'::regclass),
          'catalog profiles enforce row level security');
select ok((select relrowsecurity and relforcerowsecurity from pg_class
           where oid='public.team_catalog_update_attempts'::regclass),
          'attempt history enforces row level security');
select ok(not has_table_privilege('authenticated','public.team_catalog_update_profiles','UPDATE'),
          'members cannot bypass profile version checks');
select ok(not has_table_privilege('authenticated','public.team_catalog_update_attempts','INSERT'),
          'members cannot forge attempt history');
select ok(has_function_privilege('authenticated',
          'public.list_team_catalog_update_profiles(uuid)','execute'),
          'members can read profiles through guarded RPC');
select ok(has_function_privilege('authenticated',
          'public.patch_team_catalog_update_profile(uuid,uuid,bigint,jsonb)','execute'),
          'members can submit guarded profile patches');
select ok(not has_function_privilege('anon',
          'public.patch_team_catalog_update_profile(uuid,uuid,bigint,jsonb)','execute'),
          'anonymous profile writes are denied');
select ok(has_function_privilege('authenticated',
          'public.cancel_team_catalog_update(uuid,uuid)','execute'),
          'members can request a separate cancellation');
select ok(not has_function_privilege('anon',
          'public.list_team_catalog_update_attempts(uuid,uuid,integer)','execute'),
          'anonymous attempt reads are denied');
select ok(has_function_privilege('service_role',
          'public.service_record_catalog_update_changes(uuid,text,jsonb)','execute'),
          'worker can record content-free delivery evidence');
select ok(not has_function_privilege('authenticated',
          'public.service_record_catalog_update_changes(uuid,text,jsonb)','execute'),
          'members cannot forge delivered change evidence');
select ok(has_function_privilege('service_role',
          'public.service_mark_catalog_update_unknown(uuid,text,text)','execute'),
          'worker can stop replay after an ambiguous Drive write');
select ok(not has_function_privilege('authenticated',
          'public.service_mark_catalog_update_unknown(uuid,text,text)','execute'),
          'members cannot forge an ambiguous result');
select ok(has_function_privilege('service_role',
          'public.service_begin_catalog_update_write(uuid,text,uuid,text,integer,uuid,integer,jsonb)','execute'),
          'worker can persist a write marker before Drive mutation');
select ok(not has_function_privilege('authenticated',
          'public.service_begin_catalog_update_write(uuid,text,uuid,text,integer,uuid,integer,jsonb)','execute'),
          'members cannot forge a pending write');
select ok(has_function_privilege('service_role',
          'public.service_resolve_catalog_reconciliation(uuid,uuid,text,text)','execute'),
          'worker can reconcile a marked Drive write');
select ok(not has_function_privilege('authenticated',
          'public.service_resolve_catalog_reconciliation(uuid,uuid,text,text)','execute'),
          'members cannot release a hold without Drive evidence');

select * from finish();
rollback;
