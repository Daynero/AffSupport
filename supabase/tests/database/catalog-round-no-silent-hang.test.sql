begin;
select plan(46);

-- 072 П1: a catalog manager round whose videos cannot be admitted ends with its code, or waits
-- with a pause and a limit — never «Готуємо відео…» for ever, never holding the service's slots.
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('c0720000-0000-4000-8000-000000000001','authenticated','authenticated','no-silent-hang@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('c0720000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
 ('c0720000-0000-4000-8000-000000000011','No silent hang','c0720000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000001','admin') on conflict do nothing;
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('c0720000-0000-4000-8000-000000000021','c0720000-0000-4000-8000-000000000001','hang-test','no-silent-hang@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('c0720000-0000-4000-8000-000000000031','c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000021','hang-root','Root','my_drive','connected',now());
insert into private.team_recovery_delegations(team_id,actor_id,installation_id,refresh_hash) values
 ('c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000001','c0720000-0000-4000-8000-000000000041',decode(repeat('aa',32),'hex'));
insert into public.team_catalog_updaters(team_id) values('c0720000-0000-4000-8000-000000000011') on conflict (team_id) do nothing;

-- A re-stitching catalog of its own video; answers the catalog id.
create function pg_temp.catalog(p_name text) returns uuid language plpgsql as $$
declare video uuid:=gen_random_uuid();sheet uuid:=gen_random_uuid();
begin
 insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version,checksum,lifecycle) values
  (video,'c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000031','v-'||p_name,p_name||'.mp4','file','video','video/mp4','1','0123456789abcdef0123456789abcdef','active');
 insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version,companion_of,companion_kind,lifecycle) values
  (sheet,'c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000031','s-'||p_name,p_name,'file','other','application/vnd.google-apps.spreadsheet','1',video,'product_catalog','active');
 insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot)
  values(sheet,'c0720000-0000-4000-8000-000000000011',video,'https://offer.example.invalid/',4,'https://docs.google.com/spreadsheets/d/'||p_name||'/edit','https://drive.google.com/file/d/v-'||p_name||'/view','{}');
 update public.team_catalog_update_profiles set restitch=true,video_variant_count=2 where catalog_material_id=sheet;
 return sheet;
end $$;
-- Opens the catalog's round and adopts it the way the worker does: answers the request id.
create function pg_temp.admitted(p_catalog uuid) returns uuid language plpgsql as $$
declare attempt uuid;answer jsonb;
begin
 insert into public.team_catalog_updater_items(catalog_material_id,team_id,round_due_at,next_attempt_at)
  values(p_catalog,'c0720000-0000-4000-8000-000000000011',clock_timestamp(),clock_timestamp()-interval '1 minute')
  on conflict (catalog_material_id) do update set round_due_at=excluded.round_due_at,next_attempt_at=excluded.next_attempt_at,lease_owner=null,lease_expires_at=null;
 select a.attempt_id into attempt from public.team_catalog_update_attempts a where a.catalog_material_id=p_catalog and a.result='running' order by a.started_at desc limit 1;
 answer:=public.service_resume_catalog_updater_variants('c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000001',p_catalog,attempt);
 if answer->>'request_id' is null then raise exception 'NOT_ADMITTED %',answer;end if;
 -- Due now, as the worker sees it a minute later.
 update public.team_catalog_updater_items set next_attempt_at=clock_timestamp()-interval '1 second' where catalog_material_id=p_catalog;
 return attempt;
end $$;
create function pg_temp.fail(p_request uuid,p_code text) returns jsonb language sql as $$
 select public.service_fail_catalog_updater_variant_admission('c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000001',p_request,p_code);
$$;
create function pg_temp.listed(p_request uuid) returns boolean language sql as $$
 select exists(select 1 from jsonb_array_elements(public.service_list_catalog_variant_rounds(3)) e where e->>'attemptId'=p_request::text);
$$;
create function pg_temp.round(p_request uuid) returns text language sql as $$
 select a.result||':'||coalesce(a.failure_code,'-') from public.team_catalog_update_attempts a where a.attempt_id=p_request;
$$;

-- 1. A code that will not pass ends the round at once.
create temporary table c1 as select pg_temp.catalog('denied') id;
create temporary table r1 as select pg_temp.admitted((select id from c1)) id;
select ok(pg_temp.listed((select id from r1)),'an admitted round without its videos is listed for admission');
select is(pg_temp.fail((select id from r1),'PERMISSION_DENIED')->>'closed','true','a refused permission ends the round');
select is(pg_temp.round((select id from r1)),'failed:PERMISSION_DENIED','the attempt fails with the code');
select ok((select canceled_at is not null and failure_code='PERMISSION_DENIED' from private.catalog_updater_variant_requests where request_id=(select id from r1)),'the request is cancelled with the code');
select is((select last_update_error from public.team_product_catalogs where material_id=(select id from c1)),'PERMISSION_DENIED','the catalog keeps the code as its last error');
select ok(not exists(select 1 from public.team_catalog_updater_items where catalog_material_id=(select id from c1) and (round_due_at is not null or lease_owner is not null)),'the catalog is free for its next round');
select ok(not pg_temp.listed((select id from r1)),'the worker does not pick it again');
select is(private.catalog_registry_video_generation('c0720000-0000-4000-8000-000000000011',(select id from c1)),null,'the row no longer says videos are being prepared');
select is(pg_temp.fail((select id from r1),'DRIVE_UNAVAILABLE')->>'failureCode','PERMISSION_DENIED','a late report on an ended round changes nothing');

-- 2. The other codes that never pass by themselves.
create temporary table c2 as select pg_temp.catalog('changed') id;
create temporary table r2 as select pg_temp.admitted((select id from c2)) id;
select is(pg_temp.fail((select id from r2),'SOURCE_CHANGED')->>'failureCode','SOURCE_CHANGED','a changed or deleted source ends the round');
select is(pg_temp.round((select id from r2)),'failed:SOURCE_CHANGED','with its own code');
create temporary table r2b as select pg_temp.admitted((select id from c2)) id;
select is(pg_temp.fail((select id from r2b),'SHARE_NOT_ALLOWED')->>'failureCode','SHARE_NOT_ALLOWED','a file that may not be shared ends the round');
create temporary table r2c as select pg_temp.admitted((select id from c2)) id;
-- As frozen by a round opened before Soty's standard pictures (20261224170000).
update private.catalog_updater_variant_requests set settings_snapshot=settings_snapshot-'builtin'-'startEnabled' where request_id=(select id from r2c);
select is(pg_temp.fail((select id from r2c),'RESTITCH_POOL_EMPTY')->>'outcome','retry','a re-stitch refusal on settings frozen before the standard pictures is tried once with today''s');
select ok((select settings_snapshot=private.effective_restitch_defaults_json(team_id,actor_id) and failure_code is null from private.catalog_updater_variant_requests where request_id=(select id from r2c)),'the request takes the effective settings');
select is(pg_temp.fail((select id from r2c),'RESTITCH_POOL_EMPTY')->>'failureCode','RESTITCH_POOL_EMPTY','the same refusal on today''s settings ends the round');
select is(pg_temp.round((select id from r2c)),'failed:RESTITCH_POOL_EMPTY','with the re-stitch code');

-- 3. A revoked Drive ends the round and marks the connection, as every Drive caller does.
create temporary table r3 as select pg_temp.admitted((select id from c2)) id;
select is(pg_temp.fail((select id from r3),'NEEDS_REAUTH')->>'failureCode','NEEDS_REAUTH','a revoked Drive ends the round');
select is((select state from public.team_drive_connections where id='c0720000-0000-4000-8000-000000000031'),'needs_reauth','and asks for the Drive to be connected again');
update public.team_drive_connections set state='connected',last_error_code=null where id='c0720000-0000-4000-8000-000000000031';

-- 4. A passing failure pauses the round instead of retrying every minute, and ends it once it lasts.
create temporary table c4 as select pg_temp.catalog('drive-down') id;
create temporary table r4 as select pg_temp.admitted((select id from c4)) id;
select is(pg_temp.fail((select id from r4),'DRIVE_UNAVAILABLE')->>'outcome','retry','an unavailable Drive is tried again');
select ok((select retry_at>clock_timestamp() and first_error_at is not null from private.catalog_updater_variant_requests where request_id=(select id from r4)),'after a pause');
select ok((select next_attempt_at>clock_timestamp() from public.team_catalog_updater_items where catalog_material_id=(select id from c4)),'the item waits as long');
select ok(not pg_temp.listed((select id from r4)),'a paused round is not listed');
select is(private.catalog_registry_video_generation('c0720000-0000-4000-8000-000000000011',(select id from c4))->>'waitReason','PROCESS_RESULT_UNCERTAIN','the row says it is waiting, in a reason every web knows');
select is(private.catalog_registry_video_generation('c0720000-0000-4000-8000-000000000011',(select id from c4))->>'waitCode','DRIVE_UNAVAILABLE','and names the code');
select is(pg_temp.round((select id from r4)),'running:-','the round itself goes on');
update private.catalog_updater_variant_requests set retry_at=clock_timestamp()-interval '1 second',first_error_at=clock_timestamp()-interval '10 minutes' where request_id=(select id from r4);
update public.team_catalog_updater_items set next_attempt_at=clock_timestamp()-interval '1 second' where catalog_material_id=(select id from c4);
select ok(pg_temp.listed((select id from r4)),'after the pause it is listed again');
select is(pg_temp.fail((select id from r4),'RATE_LIMITED')->>'outcome','retry','still within its limit, another pause');
select ok((select retry_at>=clock_timestamp()+interval '4 minutes' and first_error_at<clock_timestamp()-interval '9 minutes' from private.catalog_updater_variant_requests where request_id=(select id from r4)),'a longer pause, counted from the first failure');
update private.catalog_updater_variant_requests set retry_at=clock_timestamp()-interval '1 second',first_error_at=clock_timestamp()-interval '31 minutes' where request_id=(select id from r4);
select is(pg_temp.fail((select id from r4),'DRIVE_UNAVAILABLE')->>'closed','true','a failure that lasts half an hour ends the round');
select is(pg_temp.round((select id from r4)),'failed:DRIVE_UNAVAILABLE','with the code it lasted with');
create temporary table r4b as select pg_temp.admitted((select id from c4)) id;
select is(pg_temp.fail((select id from r4b),'SOMETHING_NEW')->>'failureCode','PROCESS_RESULT_UNCERTAIN','an unknown code is an uncertain result that passes');

-- 5. Paused rounds do not starve the service: the fresh one is served first.
create temporary table c5 as select pg_temp.catalog('fresh') id;
update private.catalog_updater_variant_requests set retry_at=clock_timestamp()-interval '1 second' where request_id=(select id from r4b);
update public.team_catalog_updater_items set next_attempt_at=clock_timestamp()-interval '1 second' where catalog_material_id=(select id from c4);
create temporary table r5 as select pg_temp.admitted((select id from c5)) id;
update public.team_catalog_updater_items set next_attempt_at=clock_timestamp()-interval '1 hour' where catalog_material_id=(select id from c5);
select is((public.service_list_catalog_variant_rounds(1)->0->>'attemptId')::uuid,(select id from r5),'the round due the longest is served first');
select ok(not exists(select 1 from jsonb_array_elements(public.service_list_catalog_variant_rounds(3)) e where e->>'attemptId' in(select id::text from r1 union select id::text from r2 union select id::text from r3)),'ended rounds hold no slot');

-- 6. A ready set whose links cannot be attached: same rules, a longer limit.
select is(public.service_fail_catalog_updater_variant_target('c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000001',(select id from r5),'RATE_LIMITED')->>'outcome','retry','a passing link failure pauses');
select ok((select retry_at>clock_timestamp() from private.catalog_updater_variant_requests where request_id=(select id from r5)),'the ready listing waits it out');
update private.catalog_updater_variant_requests set first_error_at=clock_timestamp()-interval '119 minutes' where request_id=(select id from r5);
select is(public.service_fail_catalog_updater_variant_target('c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000001',(select id from r5),'DRIVE_UNAVAILABLE')->>'outcome','retry','under two hours it still waits');
update private.catalog_updater_variant_requests set first_error_at=clock_timestamp()-interval '121 minutes' where request_id=(select id from r5);
select is(public.service_fail_catalog_updater_variant_target('c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000001',(select id from r5),'DRIVE_UNAVAILABLE')->>'closed','true','after two hours the round ends');
select is(pg_temp.round((select id from r5)),'failed:DRIVE_UNAVAILABLE','with the code');

-- 7. The note: a source proven halfway keeps the clock, the sets admitted reset it.
create temporary table r7 as select pg_temp.admitted((select id from c5)) id;
select is(pg_temp.fail((select id from r7),'RATE_LIMITED')->>'outcome','retry','a passing failure starts the clock');
select public.service_note_catalog_updater_variant_admission('c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000001',(select id from r7),'source_proven');
select ok((select first_error_at is not null from private.catalog_updater_variant_requests where request_id=(select id from r7)),'one proven source does not reset it');
select public.service_note_catalog_updater_variant_admission('c0720000-0000-4000-8000-000000000011','c0720000-0000-4000-8000-000000000001',(select id from r7),'set_admitted');
select ok((select first_error_at is null and retry_at is null from private.catalog_updater_variant_requests where request_id=(select id from r7)),'all sets admitted reset it');

-- 8. Every five minutes: a round whose catalog went to the trash, and one whose Drive was revoked.
create temporary table c8 as select pg_temp.catalog('trashed') id;
create temporary table r8 as select pg_temp.admitted((select id from c8)) id;
update public.team_catalog_update_attempts set started_at=clock_timestamp()-interval '1 hour' where attempt_id=(select id from r8);
update public.team_materials set lifecycle='trashed',trashed_at=clock_timestamp() where id=(select id from c8);
select is((private.settle_catalog_round_limits(100)->>'orphans')::integer>=1,true,'the sweep takes a round whose catalog is in the trash');
select ok((select canceled_at is not null from private.catalog_updater_variant_requests where request_id=(select id from r8)),'its request is cancelled');
select isnt(pg_temp.round((select id from r8)),'running:-','its attempt no longer runs');
update public.team_drive_connections set state='needs_reauth' where id='c0720000-0000-4000-8000-000000000031';
select is((private.settle_catalog_round_limits(100)->>'unreachable')::integer>=1,true,'the sweep takes rounds whose Drive was revoked');
select is(pg_temp.round((select id from r7)),'failed:NEEDS_REAUTH','they end asking for the Drive');

select * from finish();
rollback;
