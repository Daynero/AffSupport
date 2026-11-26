begin;
select plan(26);
-- Production 2026-11-26: a publication whose videos were gone asked for its cells every 30
-- seconds and was refused with SOURCE_CHANGED every time; the hour that was meant to end it
-- never began, because the stamp was rolled back with each refusal. (20261224420000)
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('c1770000-0000-4000-8000-000000000001','authenticated','authenticated','preparation-bound@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('c1770000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values('c1770000-0000-4000-8000-000000000011','Preparation bound','c1770000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values('c1770000-0000-4000-8000-000000000011','c1770000-0000-4000-8000-000000000001','admin') on conflict do nothing;
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values('c1770000-0000-4000-8000-000000000021','c1770000-0000-4000-8000-000000000001','preparation-bound','preparation-bound@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values('c1770000-0000-4000-8000-000000000031','c1770000-0000-4000-8000-000000000011','c1770000-0000-4000-8000-000000000021','bound-root','Root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values
 ('c1770000-0000-4000-8000-000000000041','c1770000-0000-4000-8000-000000000011','c1770000-0000-4000-8000-000000000031','bound-video','Video','file','video','video/mp4','1'),
 ('c1770000-0000-4000-8000-000000000042','c1770000-0000-4000-8000-000000000011','c1770000-0000-4000-8000-000000000031','bound-catalog','Catalog','file','other','application/vnd.google-apps.spreadsheet','1'),
 ('c1770000-0000-4000-8000-000000000043','c1770000-0000-4000-8000-000000000011','c1770000-0000-4000-8000-000000000031','bound-catalog-later','Catalog later','file','other','application/vnd.google-apps.spreadsheet','1');
insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot) values
 ('c1770000-0000-4000-8000-000000000042','c1770000-0000-4000-8000-000000000011','c1770000-0000-4000-8000-000000000041','https://offer.example.invalid/',2,'https://docs.google.com/spreadsheets/d/bound-catalog/edit','https://drive.google.com/file/d/bound-video/view','{}'),
 ('c1770000-0000-4000-8000-000000000043','c1770000-0000-4000-8000-000000000011','c1770000-0000-4000-8000-000000000041','https://offer.example.invalid/',2,'https://docs.google.com/spreadsheets/d/bound-catalog-later/edit','https://drive.google.com/file/d/bound-video/view','{}');
-- An immediate publication of the video as it is now, and one scheduled for tomorrow.
select public.service_save_catalog_publication('c1770000-0000-4000-8000-000000000011','c1770000-0000-4000-8000-000000000001','c1770000-0000-4000-8000-000000000051','c1770000-0000-4000-8000-000000000042',0,'immediate',null,null,
 jsonb_build_object('kind','source','materialId','c1770000-0000-4000-8000-000000000041','sourceVersion',private.catalog_publication_source_version('c1770000-0000-4000-8000-000000000041','c1770000-0000-4000-8000-000000000011')));
select public.service_save_catalog_publication('c1770000-0000-4000-8000-000000000011','c1770000-0000-4000-8000-000000000001','c1770000-0000-4000-8000-000000000052','c1770000-0000-4000-8000-000000000043',0,'scheduled',clock_timestamp()+interval '1 day','Europe/Kyiv',
 jsonb_build_object('kind','source','materialId','c1770000-0000-4000-8000-000000000041','sourceVersion',private.catalog_publication_source_version('c1770000-0000-4000-8000-000000000041','c1770000-0000-4000-8000-000000000011')));
-- Both catalogs already carry a video link nobody verified, which parks a new job for adoption;
-- that is another story (legacy_adoption_required). Here the jobs are ordinary waiting ones.
update private.catalog_video_publication_policies set legacy_delivery_unverified=false where team_id='c1770000-0000-4000-8000-000000000011';
update private.catalog_video_publication_jobs set state='waiting',blocked_reason=null where team_id='c1770000-0000-4000-8000-000000000011';
create temporary table bound_job as
 select (select id from private.catalog_video_publication_jobs where catalog_material_id='c1770000-0000-4000-8000-000000000042') now_job,
        (select id from private.catalog_video_publication_jobs where catalog_material_id='c1770000-0000-4000-8000-000000000043') later_job;

-- The worker's hold on a job, as the claim leaves it.
create function pg_temp.take(p_job uuid) returns void language sql as $$
 update private.catalog_video_publication_jobs set worker_id='c1770000-0000-4000-8000-000000000061',lease_until=clock_timestamp()+interval '2 minutes' where id=p_job;
$$;
create function pg_temp.release(p_job uuid,p_code text) returns boolean language sql as $$
 select public.service_release_catalog_publication_preparation(p_job,'c1770000-0000-4000-8000-000000000061',p_code);
$$;
create function pg_temp.job(p_job uuid) returns text language sql as $$
 select state||':'||coalesce(blocked_reason,'-')||':'||coalesce(preparation_error_code,'-')||':'||(validation_epoch_started_at is not null)::text||':'||(worker_id is null)::text
 from private.catalog_video_publication_jobs where id=p_job;
$$;
create function pg_temp.since(p_job uuid,p_ago interval) returns void language sql as $$
 update private.catalog_video_publication_jobs set validation_epoch_started_at=clock_timestamp()-p_ago where id=p_job;
$$;

-- 1. The incident. The video the job publishes is no longer the one it was made for.
update public.team_materials set drive_version='2' where id='c1770000-0000-4000-8000-000000000041';
select pg_temp.take((select now_job from bound_job));
select throws_ok($$select public.service_catalog_publication_cells_context((select now_job from bound_job),'c1770000-0000-4000-8000-000000000061')$$,
 '55000','SOURCE_CHANGED','the cells are refused: the source changed');
select is(pg_temp.job((select now_job from bound_job)),'waiting:-:-:false:false','and the refusal takes its own hour stamp back with it');
select is(pg_temp.release((select now_job from bound_job),'SOURCE_CHANGED'),true,'the worker reports the refusal');
select is(pg_temp.job((select now_job from bound_job)),'waiting:-:SOURCE_CHANGED:true:true','the report starts the hour the refusal could not');
select ok((select next_attempt_at between clock_timestamp()+interval '25 seconds' and clock_timestamp()+interval '35 seconds' from private.catalog_video_publication_jobs where id=(select now_job from bound_job)),'the job is tried again in thirty seconds');
-- Refused again a few minutes later: still waiting.
select pg_temp.since((select now_job from bound_job),interval '9 minutes');
select pg_temp.take((select now_job from bound_job));
select pg_temp.release((select now_job from bound_job),'SOURCE_CHANGED');
select is(pg_temp.job((select now_job from bound_job)),'waiting:-:SOURCE_CHANGED:true:true','nine minutes of refusals keep it waiting');
-- Ten minutes on, a source that changed is not going to change back by waiting.
select pg_temp.since((select now_job from bound_job),interval '11 minutes');
select pg_temp.take((select now_job from bound_job));
delete from public.team_catalog_events where material_id='c1770000-0000-4000-8000-000000000042';
select is(pg_temp.release((select now_job from bound_job),'SOURCE_CHANGED'),true,'the next report is accepted');
select is(pg_temp.job((select now_job from bound_job)),'blocked:job_blocked:SOURCE_CHANGED:true:true','and stops the job, with the code that stopped it');
select ok(exists(select 1 from public.team_catalog_events where material_id='c1770000-0000-4000-8000-000000000042' and event_kind='upserted'),'open pages hear that the write stopped');
select is(pg_temp.release((select now_job from bound_job),'SOURCE_CHANGED'),false,'a stopped job is nobody''s to release');

-- 2. «Опублікувати ще раз» gives it a fresh ten minutes.
select set_config('request.jwt.claim.sub','c1770000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"c1770000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select is(public.retry_team_catalog_publication('c1770000-0000-4000-8000-000000000011','c1770000-0000-4000-8000-000000000042',(select now_job from bound_job))->>'outcome','requeued','the person can send it again');
select is(pg_temp.job((select now_job from bound_job)),'retry_wait:-:-:false:true','with its reason and its stamp cleared');
select pg_temp.take((select now_job from bound_job));
select pg_temp.release((select now_job from bound_job),'PERMISSION_DENIED');
select is(pg_temp.job((select now_job from bound_job)),'retry_wait:-:PERMISSION_DENIED:true:true','the first refusal after it starts the time again');
select pg_temp.since((select now_job from bound_job),interval '11 minutes');
select pg_temp.take((select now_job from bound_job));
select pg_temp.release((select now_job from bound_job),'SHARE_NOT_ALLOWED');
select is(pg_temp.job((select now_job from bound_job)),'blocked:job_blocked:SHARE_NOT_ALLOWED:true:true','a refused access or sharing ends the same way');

-- 3. A Drive that is slow or busy keeps its hour — and the hour now ends.
update private.catalog_video_publication_jobs set state='retry_wait',blocked_reason=null,validation_epoch_started_at=null,preparation_error_code=null,preparation_error_at=null where id=(select now_job from bound_job);
select pg_temp.take((select now_job from bound_job));
select pg_temp.release((select now_job from bound_job),'DRIVE_UNAVAILABLE');
select is(pg_temp.job((select now_job from bound_job)),'retry_wait:-:DRIVE_UNAVAILABLE:true:true','a Drive error starts the hour too');
select pg_temp.since((select now_job from bound_job),interval '50 minutes');
select pg_temp.take((select now_job from bound_job));
select pg_temp.release((select now_job from bound_job),'RATE_LIMITED');
select is(pg_temp.job((select now_job from bound_job)),'retry_wait:-:RATE_LIMITED:true:true','fifty minutes of passing trouble do not stop the job');
select pg_temp.since((select now_job from bound_job),interval '61 minutes');
select pg_temp.take((select now_job from bound_job));
select is(public.service_catalog_publication_cells_context((select now_job from bound_job),'c1770000-0000-4000-8000-000000000061')->>'reason','validation_epoch_expired','after the hour the cells function closes it itself');
select is((select state||':'||blocked_reason||':'||preparation_error_code from private.catalog_video_publication_jobs where id=(select now_job from bound_job)),'blocked:target_unavailable:DRIVE_UNAVAILABLE','as Drive not answering for an hour');

-- 4. What must stay as it was.
select pg_temp.take((select later_job from bound_job));
select pg_temp.release((select later_job from bound_job),'SOURCE_CHANGED');
select is(pg_temp.job((select later_job from bound_job)),'waiting:-:SOURCE_CHANGED:false:true','a job that is not due yet starts no clock');
select pg_temp.since((select later_job from bound_job),interval '3 hours');
select pg_temp.take((select later_job from bound_job));
select pg_temp.release((select later_job from bound_job),'SOURCE_CHANGED');
select is((select state from private.catalog_video_publication_jobs where id=(select later_job from bound_job)),'waiting','and is not stopped ahead of its time');
select pg_temp.take((select later_job from bound_job));
select is(pg_temp.release((select later_job from bound_job),null),true,'a preparation that went through is released without a code');
select ok((select preparation_error_code is null and preparation_error_at is null and next_attempt_at<=clock_timestamp() from private.catalog_video_publication_jobs where id=(select later_job from bound_job)),'which clears the last refusal and asks for the next step at once');
-- A job a writer has touched keeps its worker and its state whatever is reported.
update private.catalog_video_publication_jobs set state='retry_wait',blocked_reason=null,validation_epoch_started_at=clock_timestamp()-interval '3 hours',writer_fence=gen_random_uuid(),dispatched_at=clock_timestamp() where id=(select now_job from bound_job);
select pg_temp.take((select now_job from bound_job));
select pg_temp.release((select now_job from bound_job),'SOURCE_CHANGED');
select is(pg_temp.job((select now_job from bound_job)),'retry_wait:-:SOURCE_CHANGED:true:false','a dispatched job is left to its writer');
select is(public.service_release_catalog_publication_preparation((select now_job from bound_job),'c1770000-0000-4000-8000-000000000069','SOURCE_CHANGED'),false,'another worker releases nothing');
select throws_ok($$select pg_temp.release((select now_job from bound_job),'SOMETHING_ELSE')$$,'22023','INVALID_INPUT','only the known codes are recorded');
select ok(has_function_privilege('service_role','public.service_release_catalog_publication_preparation(uuid,uuid,text)','execute') and not has_function_privilege('authenticated','public.service_release_catalog_publication_preparation(uuid,uuid,text)','execute'),'still the worker''s alone');
select * from finish();
rollback;
