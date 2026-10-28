begin;
select plan(12);
select has_view('public','analytics_catalog_image_storage','authoritative quota is diagnosable');
select has_view('public','analytics_catalog_image_optimization','source and canonical size are diagnosable');
select ok(not has_table_privilege('anon','public.analytics_catalog_image_storage','SELECT'),'anonymous clients cannot read budget evidence');
select ok(not has_function_privilege('authenticated','public.service_catalog_image_optimization_v2(uuid,text,bigint,text)','EXECUTE'),'normalization phases are worker-only');
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
 values('f0453000-0000-4000-8000-000000000001','authenticated','authenticated','optimization-owner@soty.invalid','{}','{}');
insert into public.admin_users(user_id) values('f0453000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values('f0453000-0000-4000-8000-000000000011','Normalization fixture','f0453000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values('f0453000-0000-4000-8000-000000000011','f0453000-0000-4000-8000-000000000001','admin');
insert into private.catalog_image_config(team_id,import_enabled) values('f0453000-0000-4000-8000-000000000011',true);
insert into public.team_catalog_image_imports(id,team_id,actor_id,actor_scope,source_kind,state)
 values('f0453000-0000-4000-8000-000000000021','f0453000-0000-4000-8000-000000000011','f0453000-0000-4000-8000-000000000001','f0453000-0000-4000-8000-000000000001','local','running');
insert into private.catalog_image_import_entries(id,job_id,team_id,client_file_key,display_name,declared_size,declared_mime,classification,state,fence,lease_owner,lease_until)
 values('f0453000-0000-4000-8000-000000000031','f0453000-0000-4000-8000-000000000021','f0453000-0000-4000-8000-000000000011','fixture-one','PRIVATE_SOURCE.png',68,'image/png','{"mode":"unclassified","garment":null,"color":null,"reason":"unknown","vocabularyVersion":"catalog-clothing-v1"}','validating',1,'normalizer-fixture',clock_timestamp()+interval '5 minutes');
select lives_ok($$select public.service_catalog_image_optimization_v2('f0453000-0000-4000-8000-000000000031','normalizer-fixture',1,'started')$$,'current worker records normalization start');
select is((select stage from public.analytics_catalog_image_journal where entry_id='f0453000-0000-4000-8000-000000000031' order by evidence_id::bigint desc limit 1),'optimizing','start reaches the sanitized projection without unknown substitution');
select lives_ok($$select public.service_catalog_image_optimization_v2('f0453000-0000-4000-8000-000000000031','normalizer-fixture',1,'completed')$$,'current worker records normalization completion');
select is((select stage from public.analytics_catalog_image_journal where entry_id='f0453000-0000-4000-8000-000000000031' order by evidence_id::bigint desc limit 1),'optimized','completion reaches the sanitized projection');
select throws_ok($$select public.service_catalog_image_optimization_v2('f0453000-0000-4000-8000-000000000031','stale-worker',1,'completed')$$,'P0001','LEASE_MISMATCH','stale worker cannot manufacture a completion');
select lives_ok($$select public.service_catalog_image_reserve_v2('f0453000-0000-4000-8000-000000000031','normalizer-fixture',1,jsonb_build_object('sourceSize',68,'sourceSha256',repeat('1',64),'optimizationVersion','lossless-v1','size',32,'sha256',repeat('2',64),'mime','image/png','width',512,'height',512))$$,'canonical bytes reserve independently of source size');
select ok((select source_bytes=68 and canonical_bytes=32 and optimization_version='lossless-v1' from public.analytics_catalog_image_optimization where entry_id='f0453000-0000-4000-8000-000000000031'),'diagnosis distinguishes the actual source and canonical sizes');
select is((select used_bytes from public.analytics_catalog_image_storage where team_id='f0453000-0000-4000-8000-000000000011'),32::bigint,'quota diagnoses canonical reservation rather than raw source bytes');
select * from finish();
rollback;
