begin;
select plan(34);
select has_table('private','catalog_image_storage','durable physical storage attribution exists');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='private.catalog_image_storage'::regclass),'storage attribution forces RLS');
select ok(not has_table_privilege('authenticated','private.catalog_image_storage','SELECT'),'browser cannot read account or private object attribution');
select ok(not has_function_privilege('service_role','private.catalog_image_reserve_pre_storage(uuid,text,bigint,jsonb)','EXECUTE'),'service cannot bypass account admission');
select has_column('private','catalog_image_import_entries','canonical_sha256','final identity is persisted separately from source');
select ok(private.task_cleanup_coverage_verified(),'new storage attribution preserves platform Task cleanup coverage');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='public.team_catalog_image_storage_signals'::regclass) and not exists(select 1 from pg_constraint where conrelid='public.team_catalog_image_storage_signals'::regclass and contype='f'),'content-free storage signal forces RLS and takes no FK locks on other team rows');
select ok(not has_table_privilege('authenticated','public.team_catalog_image_storage_signals','INSERT,UPDATE,DELETE') and not has_table_privilege('service_role','public.team_catalog_image_storage_signals','INSERT,UPDATE,DELETE'),'neither browser nor service clients can forge storage signals');
select ok(exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='team_catalog_image_storage_signals'),'storage signals are in the actual Supabase Realtime publication');

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('f0452000-0000-4000-8000-000000000001','authenticated','authenticated','storage-owner-a@soty.invalid','{}','{}'),
 ('f0452000-0000-4000-8000-000000000002','authenticated','authenticated','storage-owner-b@soty.invalid','{}','{}'),
 ('f0452000-0000-4000-8000-000000000003','authenticated','authenticated','storage-viewer@soty.invalid','{}','{}');
insert into public.admin_users(user_id) values('f0452000-0000-4000-8000-000000000001'),('f0452000-0000-4000-8000-000000000002');
insert into public.teams(id,name,owner_id) values
 ('f0452000-0000-4000-8000-000000000011','Storage A','f0452000-0000-4000-8000-000000000001'),
 ('f0452000-0000-4000-8000-000000000012','Storage B','f0452000-0000-4000-8000-000000000001'),
 ('f0452000-0000-4000-8000-000000000013','Storage C','f0452000-0000-4000-8000-000000000002');
insert into public.team_members(team_id,user_id,base_role) select id,owner_id,'admin' from public.teams where id in('f0452000-0000-4000-8000-000000000011','f0452000-0000-4000-8000-000000000012','f0452000-0000-4000-8000-000000000013');
insert into public.team_members(team_id,user_id,base_role) values('f0452000-0000-4000-8000-000000000011','f0452000-0000-4000-8000-000000000003','viewer');
insert into private.catalog_image_publications(id,team_id,sha256,size_bytes,mime,width,height,classification,state,public_url) values
 ('f0452000-0000-4000-8000-000000000021','f0452000-0000-4000-8000-000000000011',repeat('1',64),32,'image/png',1,1,'{"mode":"unclassified","garment":null,"color":null,"vocabularyVersion":"catalog-clothing-v1","reason":"unknown"}','ready','https://media.test/v1/f0452000-0000-4000-8000-000000000021'),
 ('f0452000-0000-4000-8000-000000000022','f0452000-0000-4000-8000-000000000012',repeat('2',64),64,'image/png',1,1,'{"mode":"unclassified","garment":null,"color":null,"vocabularyVersion":"catalog-clothing-v1","reason":"unknown"}','candidate',null);
insert into public.team_catalog_image_pool_entries(id,team_id,publication_id,public_url,classification)
 select 'f0452000-0000-4000-8000-000000000031',team_id,id,public_url,classification from private.catalog_image_publications where id='f0452000-0000-4000-8000-000000000021';
create temporary table storage_results(key text primary key,value jsonb);
insert into storage_results values('initial',public.service_catalog_image_control_v2('storage','f0452000-0000-4000-8000-000000000001','{"teamId":"f0452000-0000-4000-8000-000000000011"}'));
select is((select value from storage_results where key='initial'),'{"limitBytes":100000000,"limitImages":500,"usedBytes":96,"reservedBytes":64,"pendingDeletionBytes":0,"retainedBytes":0,"libraryBytes":32,"totalImages":2,"availableBytes":99999904,"teamBytes":32,"otherTeamBytes":64}'::jsonb,'one owner budget includes reserved bytes in another workspace without double counting');
select is((select limit_bytes::text||':'||limit_images::text from public.analytics_catalog_image_storage where team_id='f0452000-0000-4000-8000-000000000011'),'100000000:500','read-only diagnosis reports the same amended 100 MB and 500-image quota as admission');
select ok((select revision>0 from public.team_catalog_image_storage_signals where team_id='f0452000-0000-4000-8000-000000000012'),'charging one workspace emits a real storage revision in another workspace of its owner');
select is(public.service_catalog_image_control_v2('storage','f0452000-0000-4000-8000-000000000003','{"teamId":"f0452000-0000-4000-8000-000000000011"}'),(select value from storage_results where key='initial'),'viewer can read the bounded numeric usage aggregate');
select throws_ok($$select public.service_catalog_image_control_v2('library','f0452000-0000-4000-8000-000000000003','{"teamId":"f0452000-0000-4000-8000-000000000011"}')$$,'42501','PERMISSION_DENIED','viewer cannot read management library identities');
select throws_ok($$select public.service_catalog_image_control_v2('storage','f0452000-0000-4000-8000-000000000002','{"teamId":"f0452000-0000-4000-8000-000000000011"}')$$,'42501','PERMISSION_DENIED','known workspace ID does not allow cross-team aggregate discovery');
select lives_ok($$select public.service_catalog_image_control_v2('remove','f0452000-0000-4000-8000-000000000001','{"entryId":"f0452000-0000-4000-8000-000000000031","revision":1,"idempotencyKey":"storage-remove-01"}')$$,'ordinary library removal stays available');
select is(public.service_catalog_image_control_v2('storage','f0452000-0000-4000-8000-000000000001','{"teamId":"f0452000-0000-4000-8000-000000000011"}')->'usedBytes','96'::jsonb,'ordinary removal preserves the charged physical bytes');
select is(public.service_catalog_image_control_v2('storage','f0452000-0000-4000-8000-000000000001','{"teamId":"f0452000-0000-4000-8000-000000000011"}')->'retainedBytes','32'::jsonb,'removed publication becomes retained usage');
insert into private.catalog_image_uses(team_id,publication_id,catalog_attempt_id,row_identity,state)
 values('f0452000-0000-4000-8000-000000000011','f0452000-0000-4000-8000-000000000021','f0452000-0000-4000-8000-000000000041','create:1','unknown');
insert into storage_results values('library',public.service_catalog_image_control_v2('library','f0452000-0000-4000-8000-000000000001','{"teamId":"f0452000-0000-4000-8000-000000000011"}'));
select ok((select value->'items'->0->'active'='false'::jsonb and value->'items'->0->'inUse'='true'::jsonb and value->'items'->0->'sizeBytes'='32'::jsonb from storage_results where key='library'),'management library exposes inactive image bytes and conservative unknown-use warning');
insert into public.team_members(team_id,user_id,base_role) values('f0452000-0000-4000-8000-000000000011','f0452000-0000-4000-8000-000000000002','admin');
insert into storage_results values('signalsBeforeTransfer',jsonb_build_object('source',(select revision from public.team_catalog_image_storage_signals where team_id='f0452000-0000-4000-8000-000000000012'),'recipient',coalesce((select revision from public.team_catalog_image_storage_signals where team_id='f0452000-0000-4000-8000-000000000013'),0)));
select lives_ok($$update public.teams set owner_id='f0452000-0000-4000-8000-000000000002' where id='f0452000-0000-4000-8000-000000000011'$$,'owner transfer reattributes existing storage atomically');
select ok((select revision from public.team_catalog_image_storage_signals where team_id='f0452000-0000-4000-8000-000000000012')>(select (value->>'source')::bigint from storage_results where key='signalsBeforeTransfer') and (select revision from public.team_catalog_image_storage_signals where team_id='f0452000-0000-4000-8000-000000000013')>(select (value->>'recipient')::bigint from storage_results where key='signalsBeforeTransfer'),'owner transfer invalidates another current workspace of both affected accounts');
select is(public.service_catalog_image_control_v2('storage','f0452000-0000-4000-8000-000000000002','{"teamId":"f0452000-0000-4000-8000-000000000013"}')->'usedBytes','32'::jsonb,'recipient account sees transferred bytes across its workspaces');
select is(public.service_catalog_image_control_v2('storage','f0452000-0000-4000-8000-000000000001','{"teamId":"f0452000-0000-4000-8000-000000000012"}')->'usedBytes','64'::jsonb,'former account stops being charged for the transferred team');
select lives_ok($$delete from public.teams where id='f0452000-0000-4000-8000-000000000012'$$,'team deletion preserves the accounting tombstone');
select ok(not exists(select 1 from public.team_catalog_image_storage_signals where team_id='f0452000-0000-4000-8000-000000000012'),'team deletion does not leave or recreate an orphan public signal');
select ok((select charged and size_bytes=64 and owner_scope='f0452000-0000-4000-8000-000000000001' from private.catalog_image_storage where publication_id='f0452000-0000-4000-8000-000000000022'),'physical quota attribution survives deletion of the publication and team');

insert into private.catalog_image_publications(id,team_id,sha256,size_bytes,mime,width,height,classification)
 values('f0452000-0000-4000-8000-000000000023','f0452000-0000-4000-8000-000000000013',repeat('3',64),64,'image/png',1,1,'{"mode":"unclassified","garment":null,"color":null,"vocabularyVersion":"catalog-clothing-v1","reason":"unknown"}');
insert into private.catalog_image_purges(publication_id,scope_id,bucket_kind,object_key,reason,not_before)
 select id,team_id,'public',object_key,'orphan_candidate',clock_timestamp() from private.catalog_image_publications where id='f0452000-0000-4000-8000-000000000023';
insert into storage_results values('orphanClaim',public.service_catalog_image_purge_claim_v2());
insert into storage_results values('orphanSignal',to_jsonb((select revision from public.team_catalog_image_storage_signals where team_id='f0452000-0000-4000-8000-000000000011')));
select is((select value->>'id' from storage_results where key='orphanClaim'),(select id::text from private.catalog_image_purges where publication_id='f0452000-0000-4000-8000-000000000023'),'unused candidate receives a real orphan deletion claim');
select lives_ok($$select public.service_catalog_image_purge_finish_v2((select (value->>'id')::uuid from storage_results where key='orphanClaim'),(select (value->>'fence')::bigint from storage_results where key='orphanClaim'),true)$$,'known orphan deletion can finish through the quota wrapper');
select ok((select not charged from private.catalog_image_storage where publication_id='f0452000-0000-4000-8000-000000000023'),'actual known orphan deletion releases physical capacity');
select ok((select revision from public.team_catalog_image_storage_signals where team_id='f0452000-0000-4000-8000-000000000011')>(select value::text::bigint from storage_results where key='orphanSignal'),'private purge completion invalidates another owned workspace through an actual public revision');
insert into private.catalog_image_purges(publication_id,scope_id,bucket_kind,object_key,reason,not_before)
 select id,team_id,'public',object_key,'orphan_candidate',clock_timestamp() from private.catalog_image_publications where id='f0452000-0000-4000-8000-000000000021';
do $$ begin perform public.service_catalog_image_purge_claim_v2(); end $$;
select ok((select s.charged and p.state='ready' and q.state='complete' from private.catalog_image_storage s join private.catalog_image_publications p on p.id=s.publication_id join private.catalog_image_purges q on q.publication_id=p.id where p.id='f0452000-0000-4000-8000-000000000021'),'orphan completed because ready bytes were kept does not return quota');
do $$ begin
 perform public.service_catalog_image_control_v2('revoke','f0452000-0000-4000-8000-000000000002','{"publicationId":"f0452000-0000-4000-8000-000000000021","revision":2,"explicitRevocation":true,"idempotencyKey":"storage-unknown-delete"}');
end $$;
insert into storage_results values('unknownClaim',public.service_catalog_image_purge_claim_v2()),('unknownSignal',to_jsonb((select revision from public.team_catalog_image_storage_signals where team_id='f0452000-0000-4000-8000-000000000013')));
select lives_ok($$select public.service_catalog_image_purge_finish_v2((select (value->>'id')::uuid from storage_results where key='unknownClaim'),(select (value->>'fence')::bigint from storage_results where key='unknownClaim'),false)$$,'actual failed cleanup records uncertainty through the service path');
select is(public.service_catalog_image_control_v2('library','f0452000-0000-4000-8000-000000000002','{"teamId":"f0452000-0000-4000-8000-000000000011"}')->'items'->0->>'publicationState','purge_unknown','library derives cleanup uncertainty without forging the publication state');
select ok((select charged from private.catalog_image_storage where publication_id='f0452000-0000-4000-8000-000000000021') and (select revision from public.team_catalog_image_storage_signals where team_id='f0452000-0000-4000-8000-000000000013')>(select value::text::bigint from storage_results where key='unknownSignal'),'uncertain cleanup stays charged and emits a sibling-space invalidation');
select * from finish();
rollback;
