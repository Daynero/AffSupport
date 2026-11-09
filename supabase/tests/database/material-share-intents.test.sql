begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(10);
select ok(has_table_privilege('wishly_analytics_ro','public.analytics_material_share_intents','select'),
 'read-only diagnostics can discover sharing receipts');
select ok(not has_table_privilege('wishly_analytics_ro','public.analytics_material_share_intents','insert,update,delete'),
 'diagnostics cannot mutate receipts');
select ok(not has_table_privilege('authenticated','public.analytics_material_share_intents','select')
 and not has_table_privilege('anon','public.analytics_material_share_intents','select')
 and not has_table_privilege('service_role','public.analytics_material_share_intents','select'),
 'receipt projection is not a client or service data endpoint');
select ok(not has_table_privilege('authenticated','private.team_material_share_intents','select,insert,update,delete'),
 'clients cannot bypass the sharing permit');
select ok(has_function_privilege('service_role','public.service_begin_material_share(uuid,uuid,uuid,uuid,text,text,boolean,boolean,uuid)','execute')
 and not has_function_privilege('authenticated','public.service_begin_material_share(uuid,uuid,uuid,uuid,text,text,boolean,boolean,uuid)','execute'),
 'permission creation permit is service-only');
select ok(has_function_privilege('service_role','public.service_prune_material_share_receipts(integer)','execute')
 and not has_function_privilege('authenticated','public.service_prune_material_share_receipts(integer)','execute'),
 'bounded retention is service-only');
select is(encode(extensions.digest(convert_to('abc','UTF8'),'sha256'),'hex'),
 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
 'native pgcrypto supplies real SHA-256');
select ok(not exists(select 1 from information_schema.columns where table_schema='public'
 and table_name='analytics_material_share_intents' and column_name in ('provider_file_id','permission_id','request_key','fingerprint','file_fingerprint')),
 'diagnostics do not expose provider IDs, keys or payload hashes');
select is((select count(*)::int from cron.job where jobname='material-share-receipt-retention'
 and schedule='*/5 * * * *' and command='select public.service_prune_material_share_receipts(100)'),1,
 'bounded receipt retention is registered once');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='private.team_material_share_intents'::regclass)
 and (select relrowsecurity and relforcerowsecurity from pg_class where oid='private.team_material_share_authorities'::regclass),
 'both private sharing tables force RLS');
select * from finish();
rollback;
