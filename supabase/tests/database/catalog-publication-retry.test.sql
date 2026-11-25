-- 072 (П3, П6): «Опублікувати ще раз», Drive coming back, and the creation preflight.
begin;
select plan(24);

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('c0720000-0000-4000-8000-000000000001','authenticated','authenticated','retry-owner@test.invalid','{}','{}'),
 ('c0720000-0000-4000-8000-000000000002','authenticated','authenticated','retry-stranger@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('c0720000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values('c0720000-0000-4000-8000-000000000011','Retry fixture','c0720000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values('c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000001','admin');
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values('c0720000-0000-4000-8000-000000000021','c0720000-0000-4000-8000-000000000001','retry-test','retry-owner@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values('c0720000-0000-4000-8000-000000000031','c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000021','retry-root','Root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values
 ('c0720000-0000-4000-8000-000000000041','c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000031','retry-video','Video','file','video','video/mp4','1'),
 ('c0720000-0000-4000-8000-000000000042','c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000031','retry-catalog','Catalog','file','other','application/vnd.google-apps.spreadsheet','1');
insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot) values('c0720000-0000-4000-8000-000000000042','c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000041','https://offer.example.invalid/',2,'https://docs.google.com/spreadsheets/d/retry-catalog/edit','https://drive.google.com/file/d/retry-video/view','{}');
select public.service_save_catalog_publication('c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000001','c0720000-0000-4000-8000-000000000051','c0720000-0000-4000-8000-000000000042',0,'immediate',null,null,jsonb_build_object('kind','source','materialId','c0720000-0000-4000-8000-000000000041','sourceVersion',private.catalog_publication_source_version('c0720000-0000-4000-8000-000000000041','c0720000-0000-4000-8000-000000000011')));
create temporary table retry_job as select id from private.catalog_video_publication_jobs where catalog_material_id='c0720000-0000-4000-8000-000000000042' and revision=1;
grant select on retry_job to authenticated;

-- Grants.
select ok(has_function_privilege('authenticated','public.retry_team_catalog_publication(uuid,uuid,uuid)','execute'),'a signed-in person can ask to publish again');
select ok(not has_function_privilege('anon','public.retry_team_catalog_publication(uuid,uuid,uuid)','execute'),'nobody anonymous can');
select ok(has_function_privilege('authenticated','public.team_catalog_creation_preflight(uuid)','execute'),'the creation preflight is the browser''s to read');
select ok(not has_function_privilege('authenticated','private.requeue_catalog_publications_for_connection(uuid,uuid)','execute'),'the requeue itself is not');
select ok(exists(select 1 from pg_trigger where tgrelid='public.team_drive_connections'::regclass and tgname='team_drive_connections_requeue_catalog_publications' and not tgisinternal),'Drive returning to connected has its trigger');

-- Blocked after an hour of Drive errors: publish again puts the same job back in the queue.
update private.catalog_video_publication_jobs set state='blocked',blocked_reason='target_unavailable',preparation_error_code='DRIVE_UNAVAILABLE',preparation_error_at=now(),validation_epoch_started_at=now()-interval '2 hours' where id=(select id from retry_job);
select set_config('request.jwt.claim.sub','c0720000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"c0720000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select is(public.retry_team_catalog_publication('c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000042',(select id from retry_job))->>'outcome','requeued','a blocked, untouched job is requeued');
select is((select state||':'||coalesce(blocked_reason,'-')||':'||coalesce(preparation_error_code,'-')||':'||(validation_epoch_started_at is null)::text from private.catalog_video_publication_jobs where id=(select id from retry_job)),'retry_wait:-:-:true','it waits for the worker with its reason and epoch cleared');
select is(public.retry_team_catalog_publication('c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000042',(select id from retry_job))->>'outcome','queued','a second press changes nothing');
select ok(exists(select 1 from public.team_catalog_events where team_id='c0720000-0000-4000-8000-000000000011' and material_id='c0720000-0000-4000-8000-000000000042' and event_kind='upserted'),'open pages hear about it');

-- Drive is away: publish again says so instead of queueing into the same wall.
update public.team_drive_connections set state='needs_reauth' where id='c0720000-0000-4000-8000-000000000031';
update private.catalog_video_publication_jobs set state='blocked',blocked_reason='target_unavailable' where id=(select id from retry_job);
select throws_ok($$select public.retry_team_catalog_publication('c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000042',(select id from retry_job))$$,'55000','NEEDS_REAUTH','a disconnected Drive is named, with its own way out');
-- … and reconnecting it returns the job by itself.
update public.team_drive_connections set state='connected' where id='c0720000-0000-4000-8000-000000000031';
select is((select state from private.catalog_video_publication_jobs where id=(select id from retry_job)),'retry_wait','Drive coming back requeues what it blocked');
-- Only target_unavailable is the trigger's: a stale job stays for the person to decide.
update private.catalog_video_publication_jobs set state='blocked',blocked_reason='stale_job' where id=(select id from retry_job);
update public.team_drive_connections set state='unavailable' where id='c0720000-0000-4000-8000-000000000031';
update public.team_drive_connections set state='connected' where id='c0720000-0000-4000-8000-000000000031';
select is((select state||':'||blocked_reason from private.catalog_video_publication_jobs where id=(select id from retry_job)),'blocked:stale_job','a stale job is not revived by a reconnect');

-- A job the writer already touched is not revived: the page publishes a new revision instead.
update private.catalog_video_publication_jobs set dispatched_at=now()-interval '3 hours',writer_fence=gen_random_uuid() where id=(select id from retry_job);
select is(public.retry_team_catalog_publication('c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000042',(select id from retry_job))->>'outcome','republish','a dispatched job asks for a new revision');
select is((select state from private.catalog_video_publication_jobs where id=(select id from retry_job)),'blocked','and stays as it was');
update private.catalog_video_publication_jobs set dispatched_at=null,writer_fence=null where id=(select id from retry_job);

-- What has its own way out is refused.
update private.catalog_video_publication_jobs set blocked_reason='legacy_adoption_required' where id=(select id from retry_job);
select throws_ok($$select public.retry_team_catalog_publication('c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000042',(select id from retry_job))$$,'55000','WRONG_STATE','legacy adoption keeps its verification');
update private.catalog_video_publication_jobs set blocked_reason='target_unavailable' where id=(select id from retry_job);
select throws_ok($$select public.retry_team_catalog_publication('c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000042',gen_random_uuid())$$,'55000','WRONG_STATE','another job id is refused');

-- The preflight, for a member.
select is((select public.team_catalog_creation_preflight('c0720000-0000-4000-8000-000000000011')->>'driveState'),'connected','the preflight sees the Drive');
select is((select (public.team_catalog_creation_preflight('c0720000-0000-4000-8000-000000000011')->>'spaceAllowed')::boolean),true,'… and an open space');
select is((select (public.team_catalog_creation_preflight('c0720000-0000-4000-8000-000000000011')->>'backgroundExecutor')::boolean),false,'… and no background executor yet');
select is((select (public.team_catalog_creation_preflight('c0720000-0000-4000-8000-000000000011')->>'canRestitch')::boolean),true,'… and the right to restitch');

-- A stranger gets nothing.
select set_config('request.jwt.claim.sub','c0720000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"sub":"c0720000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select throws_ok($$select public.retry_team_catalog_publication('c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000042',(select id from retry_job))$$,'42501','PERMISSION_DENIED','a stranger cannot publish');
select throws_ok($$select public.team_catalog_creation_preflight('c0720000-0000-4000-8000-000000000011')$$,'42501','PERMISSION_DENIED','nor read the preflight');

-- A paused space is named as paused, to its members.
select set_config('request.jwt.claim.sub','c0720000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"c0720000-0000-4000-8000-000000000001","role":"authenticated"}',true);
delete from public.admin_users where user_id='c0720000-0000-4000-8000-000000000001';
select throws_ok($$select public.retry_team_catalog_publication('c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000042',(select id from retry_job))$$,'42501','SPACE_BLOCKED','a paused space says it is paused');
select is((select (public.team_catalog_creation_preflight('c0720000-0000-4000-8000-000000000011')->>'spaceAllowed')::boolean),false,'the preflight says it before creation starts');

select * from finish();
rollback;
