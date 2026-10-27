begin;
select plan(36);
select has_table('public','team_catalog_image_imports','045 team_catalog_image_imports exists');
select has_table('public','team_catalog_image_pool_entries','045 team_catalog_image_pool_entries exists');
select has_table('private','catalog_image_publications','045 catalog_image_publications exists');
select has_table('private','catalog_image_purges','045 catalog_image_purges exists');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='public.team_catalog_image_imports'::regclass),'import snapshots force RLS');
select ok(not has_function_privilege('authenticated','public.service_catalog_image_claim_v2(text)','EXECUTE'),'browser cannot claim worker jobs');
select ok(not has_function_privilege('anon','public.service_catalog_image_control_v2(text,uuid,jsonb)','EXECUTE'),'anonymous cannot operate image imports');
select ok(not has_table_privilege('authenticated','private.catalog_image_publications','SELECT'),'digests and private keys are not browser readable');
select ok(private.task_cleanup_coverage_verified(),'all image metadata consumers retain the task cleanup reference fence');
select ok(not has_function_privilege('authenticated','public.service_catalog_image_validate_rows_v2(uuid,jsonb)','EXECUTE'),'browser cannot validate private publication identities');
select ok(not has_function_privilege('service_role','private.catalog_image_complete_update_v1(uuid,text,integer,uuid,integer,jsonb)','EXECUTE'),'service cannot bypass retained-row completion guard');
select ok((select count(*)=14 and bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname like 'catalog_image_%' and c.relkind='r'),'all fourteen private image metadata tables enable RLS');
select has_column('public','team_launch_generations','catalog_image_contract_version','Launch persists the accepted image contract');
select has_column('public','team_launch_generations','catalog_image_attempt_id','Launch reserves the future child identity before restitch');
select ok(not has_column_privilege('authenticated','public.team_launch_generations','catalog_image_contract_version','SELECT'),'browser cannot read the server-owned image contract');
select ok(not has_function_privilege('authenticated','public.service_claim_launch_generation(uuid,uuid,uuid,text)','EXECUTE'),'browser cannot claim Launch execution');
select ok(not has_function_privilege('service_role','private.catalog_image_accepted_launch_version(uuid,uuid,uuid,text)','EXECUTE'),'service cannot invoke the private legacy-proof helper directly');

-- Native PostgreSQL regression for the beta-observed row-variable/alias error.
-- Reintroduce only that original alias inside this rollback-only transaction,
-- prove the failed action is atomic, then restore the additive migration's body.
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
 values('f0450000-0000-4000-8000-000000000001','authenticated','authenticated','native-r2-revoke@soty.invalid','{}','{}');
insert into public.admin_users(user_id) values('f0450000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
 ('f0450000-0000-4000-8000-000000000002','Native R2 revoke','f0450000-0000-4000-8000-000000000001'),
 ('f0450000-0000-4000-8000-000000000003','Native R2 delete','f0450000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role)
 select id,owner_id,'admin' from public.teams where id in ('f0450000-0000-4000-8000-000000000002','f0450000-0000-4000-8000-000000000003');
insert into private.catalog_image_publications(id,team_id,sha256,size_bytes,mime,width,height,classification,state,public_url)
 select ('f0450000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 case when n<14 then 'f0450000-0000-4000-8000-000000000002'::uuid else 'f0450000-0000-4000-8000-000000000003'::uuid end,
 lpad(n::text,64,'0'),68,'image/png',1,1,
 '{"mode":"unclassified","garment":null,"color":null,"vocabularyVersion":"catalog-clothing-v1","reason":"unknown"}'::jsonb,
 case when n=15 then 'put_unknown' else 'ready' end,'https://media.test/native/'||n
 from generate_series(11,15) n;
insert into public.team_catalog_image_pool_entries(team_id,publication_id,public_url,classification)
 select team_id,id,public_url,classification from private.catalog_image_publications where team_id in ('f0450000-0000-4000-8000-000000000002','f0450000-0000-4000-8000-000000000003');
insert into private.catalog_image_purges(publication_id,scope_id,bucket_kind,object_key,reason,state,fence,attempts,not_before)
 select id,team_id,'public',object_key,'orphan_candidate',case when id::text in ('f0450000-0000-4000-8000-000000000013','f0450000-0000-4000-8000-000000000015') then 'complete' else 'pending' end,7,8,clock_timestamp()+interval '24 hours'
 from private.catalog_image_publications where team_id in ('f0450000-0000-4000-8000-000000000002','f0450000-0000-4000-8000-000000000003');
create temporary table r2_revoke_function as select pg_get_functiondef('private.catalog_image_control_impl_v2(text,uuid,jsonb)'::regprocedure) body;
create temporary table r2_revoke_results(key text primary key,value jsonb);
do $$ declare source text; begin
 select body into source from r2_revoke_function;
 source:=replace(source,'public.team_catalog_image_pool_entries pool_entry where pool_entry.publication_id=p.id and pool_entry.revision=','public.team_catalog_image_pool_entries e where e.publication_id=p.id and e.revision=');
 execute source;
end $$;
select throws_ok($$select public.service_catalog_image_control_v2('revoke','f0450000-0000-4000-8000-000000000001','{"publicationId":"f0450000-0000-4000-8000-000000000011","revision":1,"explicitRevocation":true,"idempotencyKey":"native-revoke-first"}')$$,'42702','column reference "e.publication_id" is ambiguous','original live alias defect reproduces on native PostgreSQL');
select ok((select p.state='ready' and e.active and e.revision=1 from private.catalog_image_publications p join public.team_catalog_image_pool_entries e on e.publication_id=p.id where p.id='f0450000-0000-4000-8000-000000000011'),'failed original revoke keeps the publication and original pool unchanged');
do $$ declare source text; begin select body into source from r2_revoke_function; execute source; end $$;
select throws_ok($$select public.service_catalog_image_control_v2('revoke','f0450000-0000-4000-8000-000000000001','{"publicationId":"f0450000-0000-4000-8000-000000000011","revision":2,"explicitRevocation":true,"idempotencyKey":"native-revoke-stale"}')$$,'P0001','NOT_FOUND','repaired revoke still requires the current entry revision');
select lives_ok($$insert into r2_revoke_results values('first',public.service_catalog_image_control_v2('revoke','f0450000-0000-4000-8000-000000000001','{"publicationId":"f0450000-0000-4000-8000-000000000011","revision":1,"explicitRevocation":true,"idempotencyKey":"native-revoke-first"}'))$$,'actual service revoke succeeds after the additive repair');
select ok((select p.state='revoking' and not e.active and e.revision=2 from private.catalog_image_publications p join public.team_catalog_image_pool_entries e on e.publication_id=p.id where p.id='f0450000-0000-4000-8000-000000000011'),'successful revoke hides only the requested image and advances its revision');
select ok((select p.state='ready' and e.active and e.revision=1 from private.catalog_image_publications p join public.team_catalog_image_pool_entries e on e.publication_id=p.id where p.id='f0450000-0000-4000-8000-000000000012'),'unrelated original pool image remains ready and unchanged');
select ok((select reason='explicit_revoke' and state='pending' and fence=8 and attempts=0 and lease_until is null and not_before<=clock_timestamp() from private.catalog_image_purges where publication_id='f0450000-0000-4000-8000-000000000011'),'future orphan tombstone becomes immediate bounded explicit deletion');
select is(public.service_catalog_image_control_v2('revoke','f0450000-0000-4000-8000-000000000001','{"publicationId":"f0450000-0000-4000-8000-000000000011","revision":1,"explicitRevocation":true,"idempotencyKey":"native-revoke-first"}'),(select value from r2_revoke_results where key='first'),'exact retry replays the original dictionary response');
select ok((select e.revision=2 and q.fence=8 and q.attempts=0 from public.team_catalog_image_pool_entries e join private.catalog_image_purges q on q.publication_id=e.publication_id where e.publication_id='f0450000-0000-4000-8000-000000000011'),'exact replay changes neither entry revision nor cleanup counters');
insert into r2_revoke_results values('claim',public.service_catalog_image_purge_claim_v2());
select is((select value->>'id' from r2_revoke_results where key='claim'),(select id::text from private.catalog_image_purges where publication_id='f0450000-0000-4000-8000-000000000011'),'worker can claim the promoted deletion despite retained inactive pool metadata');
select throws_ok($$select public.service_catalog_image_purge_finish_v2((select id from private.catalog_image_purges where publication_id='f0450000-0000-4000-8000-000000000011'),7,true)$$,'P0001','LEASE_MISMATCH','old orphan receipt cannot complete the promoted deletion');
select lives_ok($$select public.service_catalog_image_purge_finish_v2((select (value->>'id')::uuid from r2_revoke_results where key='claim'),(select (value->>'fence')::bigint from r2_revoke_results where key='claim'),true)$$,'current worker cleanup receipt can finish');
select is((select state from private.catalog_image_publications where id='f0450000-0000-4000-8000-000000000011'),'revoked','authoritative successful cleanup marks publication revoked');
select lives_ok($$select public.service_catalog_image_control_v2('revoke','f0450000-0000-4000-8000-000000000001','{"publicationId":"f0450000-0000-4000-8000-000000000013","revision":1,"explicitRevocation":true,"idempotencyKey":"native-revoke-complete"}')$$,'revoke also accepts a previously completed orphan tombstone');
select ok((select reason='explicit_revoke' and state='pending' and fence=8 and attempts=0 and not_before<=clock_timestamp() from private.catalog_image_purges where publication_id='f0450000-0000-4000-8000-000000000013'),'completed orphan is reopened for actual explicit deletion');
select lives_ok($$delete from public.teams where id='f0450000-0000-4000-8000-000000000003'$$,'team deletion promotes existing orphan tombstones');
select ok((select count(*)=2 and bool_and(reason='team_deleted' and state='pending' and fence=8 and attempts=0 and lease_until is null and not_before>clock_timestamp()+interval '119 seconds' and not_before<clock_timestamp()+interval '3 minutes') from private.catalog_image_purges where scope_id='f0450000-0000-4000-8000-000000000003'),'both future and completed orphans retain the two-minute late-write hold after team deletion');
select ok((select uncertain_write from private.catalog_image_purges where publication_id='f0450000-0000-4000-8000-000000000015'),'team deletion preserves unknown provider-write evidence');
select ok(not exists(select 1 from private.catalog_image_publications where team_id='f0450000-0000-4000-8000-000000000003') and (select count(*)=2 from private.catalog_image_purges where scope_id='f0450000-0000-4000-8000-000000000003'),'purge ownership evidence survives deletion of team and publications');
select * from finish();
rollback;
