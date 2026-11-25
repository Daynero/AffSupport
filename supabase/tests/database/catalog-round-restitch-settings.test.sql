begin;
select plan(32);

-- Production 2026-11-25: a re-stitching catalog round in a space without saved re-stitch settings
-- waited «Готуємо відео…» for ever. Re-stitching now works out of the box with Soty's standard
-- pictures (20261224170000); a round whose person turned both screens off says why at once and
-- ends instead (20261224160000).
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('c0700000-0000-4000-8000-000000000001','authenticated','authenticated','restitch-gate-owner@test.invalid','{}','{}');
-- An admin's space is allowed without a tariff.
insert into public.admin_users(user_id) values('c0700000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
 ('c0700000-0000-4000-8000-000000000011','Restitch gate fixture','c0700000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('c0700000-0000-4000-8000-000000000011','c0700000-0000-4000-8000-000000000001','admin')
 on conflict do nothing;
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('c0700000-0000-4000-8000-000000000021','c0700000-0000-4000-8000-000000000001','gate-test','restitch-gate-owner@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('c0700000-0000-4000-8000-000000000031','c0700000-0000-4000-8000-000000000011','c0700000-0000-4000-8000-000000000021','gate-root','Root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version,checksum,lifecycle) values
 ('c0700000-0000-4000-8000-000000000041','c0700000-0000-4000-8000-000000000011','c0700000-0000-4000-8000-000000000031','gate-v1','Alpha.mp4','file','video','video/mp4','1','0123456789abcdef0123456789abcdef','active');
insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version,companion_of,companion_kind,lifecycle) values
 ('c0700000-0000-4000-8000-000000000061','c0700000-0000-4000-8000-000000000011','c0700000-0000-4000-8000-000000000031','gate-s1','Sheet','file','other','application/vnd.google-apps.spreadsheet','1','c0700000-0000-4000-8000-000000000041','product_catalog','active');
insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot)
 values('c0700000-0000-4000-8000-000000000061','c0700000-0000-4000-8000-000000000011','c0700000-0000-4000-8000-000000000041','https://offer.example.invalid/',4,
  'https://docs.google.com/spreadsheets/d/gate/edit','https://drive.google.com/file/d/gate-v1/view','{}');
update public.team_catalog_update_profiles set restitch=true,video_variant_count=2 where catalog_material_id='c0700000-0000-4000-8000-000000000061';

create function pg_temp.open_round() returns uuid language plpgsql as $$
declare id uuid;
begin
 insert into public.team_catalog_updaters(team_id) values('c0700000-0000-4000-8000-000000000011') on conflict (team_id) do nothing;
 insert into public.team_catalog_updater_items(catalog_material_id,team_id,round_due_at,next_attempt_at)
  values('c0700000-0000-4000-8000-000000000061','c0700000-0000-4000-8000-000000000011',clock_timestamp(),clock_timestamp()-interval '1 minute')
  on conflict (catalog_material_id) do update set round_due_at=excluded.round_due_at,next_attempt_at=excluded.next_attempt_at,lease_owner=null,lease_expires_at=null;
 select a.attempt_id into id from public.team_catalog_update_attempts a
  where a.catalog_material_id='c0700000-0000-4000-8000-000000000061' and a.result='running' order by a.started_at desc limit 1;
 return id;
end $$;
create function pg_temp.adopt(p_attempt uuid) returns jsonb language sql as $$
 select public.service_adopt_catalog_variant_round('c0700000-0000-4000-8000-000000000011','c0700000-0000-4000-8000-000000000001','c0700000-0000-4000-8000-000000000061',p_attempt,null);
$$;
create function pg_temp.resume(p_attempt uuid) returns jsonb language sql as $$
 select public.service_resume_catalog_updater_variants('c0700000-0000-4000-8000-000000000011','c0700000-0000-4000-8000-000000000001','c0700000-0000-4000-8000-000000000061',p_attempt);
$$;

-- 0. Out of the box: no saved settings still re-stitch, with the standard pictures.
create function pg_temp.effective() returns jsonb language sql as $$
 select private.effective_restitch_defaults_json('c0700000-0000-4000-8000-000000000011','c0700000-0000-4000-8000-000000000001');
$$;
select ok((select e->>'configured'='true' and e->'builtin'='{"version":1,"start":true,"end":true}'::jsonb from (select pg_temp.effective() e) x),'a space that never saved settings re-stitches with both standard pictures');
select ok((select e->>'startEnabled'='false' and e->>'endEnabled'='true' and e->>'automaticEndFrame'='true' and e->>'sourceMode'='drive' from (select pg_temp.effective() e) x),'agents without the pictures get the video''s own end frame and no start');
insert into public.team_restitch_defaults(team_id,operation,fit_mode,final_duration_mode,configured,source_mode,start_enabled,end_enabled,start_image_ids)
 values('c0700000-0000-4000-8000-000000000011','restitch','cover','custom',true,'legacy',true,true,array['c0700000-0000-4000-8000-0000000000a1'::uuid]);
select ok((select e->'builtin'='{"version":1,"start":false,"end":true}'::jsonb and e->>'startEnabled'='true' and e->>'endEnabled'='false' and e->>'sourceMode'='legacy' from (select pg_temp.effective() e) x),'own start pictures are kept and the empty end waits for the standard picture');
update public.team_restitch_defaults set start_image_ids='{}',source_mode='drive',configured=false where team_id='c0700000-0000-4000-8000-000000000011';
select ok((select e->>'configured'='true' and e->'builtin'='{"version":1,"start":true,"end":true}'::jsonb from (select pg_temp.effective() e) x),'a saved row whose pictures were all removed still re-stitches');
update public.team_restitch_defaults set operation='unstitch',start_enabled=false,end_enabled=false where team_id='c0700000-0000-4000-8000-000000000011';
select is(pg_temp.effective()->>'configured','true','removing the screens needs no picture');
update public.team_restitch_defaults set operation='restitch' where team_id='c0700000-0000-4000-8000-000000000011';
select is(pg_temp.effective(),null,'both screens turned off is the one case without re-stitching');
select ok(not has_function_privilege('authenticated','private.effective_restitch_defaults_json(uuid,uuid)','execute'),'the effective settings stay private');

-- 1. Both screens off: the round says so the moment it opens.
create temporary table first_round as select pg_temp.open_round() id;
select is((select failure_code from private.catalog_variant_round_snapshots where attempt_id=(select id from first_round)),'RESTITCH_INVALID','a round without settings is marked at once');
select is((select failure_code||':'||result from public.team_catalog_update_attempts where attempt_id=(select id from first_round)),'RESTITCH_INVALID:running','the attempt carries the reason while the worker has not seen it');
select is(private.catalog_registry_video_generation('c0700000-0000-4000-8000-000000000011','c0700000-0000-4000-8000-000000000061')->>'waitReason','RESTITCH_INVALID','the manager row reads the reason, not «preparing»');

-- 2. Adoption ends it: no request, a failed attempt, a free catalog.
create temporary table first_answer as select pg_temp.adopt((select id from first_round)) value;
select is((select value->>'outcome'||':'||(value->>'failureCode') from first_answer),'blocked:RESTITCH_INVALID','adoption refuses with the code the web knows');
select ok(not exists(select 1 from private.catalog_updater_variant_requests where attempt_id=(select id from first_round)),'no variant request is created');
select is((select result||':'||failure_code from public.team_catalog_update_attempts where attempt_id=(select id from first_round)),'failed:RESTITCH_INVALID','the attempt ends as failed');
select ok((select ended_at is not null from public.team_catalog_update_attempts where attempt_id=(select id from first_round)),'the attempt has an end');
select is((select last_update_error from public.team_product_catalogs where material_id='c0700000-0000-4000-8000-000000000061'),'RESTITCH_INVALID','the catalog''s last error names the missing settings');
select ok(not exists(select 1 from public.team_catalog_updater_items where catalog_material_id='c0700000-0000-4000-8000-000000000061' and round_due_at is not null),'the catalog no longer holds a round');
select ok(not exists(select 1 from jsonb_array_elements(public.service_list_catalog_variant_rounds(3)) e where e->>'attemptId'=(select id from first_round)::text),'the worker does not pick the round again');
select is(public.service_read_catalog_updater_variants('c0700000-0000-4000-8000-000000000011','c0700000-0000-4000-8000-000000000001','c0700000-0000-4000-8000-000000000061',(select id from first_round))->>'state','canceled','the ended round reads as ended');
select is(public.service_read_catalog_updater_variants('c0700000-0000-4000-8000-000000000011','c0700000-0000-4000-8000-000000000001','c0700000-0000-4000-8000-000000000061',(select id from first_round))->>'failureCode','RESTITCH_INVALID','and says why');
select is(private.catalog_registry_video_generation('c0700000-0000-4000-8000-000000000011','c0700000-0000-4000-8000-000000000061'),null,'the row no longer shows videos being prepared');
select throws_ok($$select pg_temp.adopt((select id from first_round))$$,'55000','WRONG_STATE','the ended round cannot be adopted again');

-- 3. A screen turned back on after the round opened: adoption goes on with the standard picture.
create temporary table second_round as select pg_temp.open_round() id;
select is((select failure_code from private.catalog_variant_round_snapshots where attempt_id=(select id from second_round)),'RESTITCH_INVALID','the second round also opens without settings');
update public.team_restitch_defaults set end_enabled=true where team_id='c0700000-0000-4000-8000-000000000011';
select is(pg_temp.adopt((select id from second_round))->>'failureCode','AGENT_REQUIRED','with settings saved the round passes the settings check');
select is((select settings_snapshot->>'configured' from private.catalog_variant_round_snapshots where attempt_id=(select id from second_round)),'true','the round takes the saved settings');
select is((select settings_snapshot#>>'{builtin,end}' from private.catalog_variant_round_snapshots where attempt_id=(select id from second_round)),'true','and marks the standard end picture');
select is((select result from public.team_catalog_update_attempts where attempt_id=(select id from second_round)),'running','the round keeps running');

-- 4. A request admitted before the fix with empty settings is settled on resume.
update public.team_catalog_update_attempts set result='cancelled',ended_at=clock_timestamp() where attempt_id=(select id from second_round);
update public.team_catalog_updater_items set round_due_at=null where catalog_material_id='c0700000-0000-4000-8000-000000000061';
create temporary table legacy_round as select pg_temp.open_round() id;
insert into private.catalog_updater_variant_requests(request_id,team_id,actor_id,catalog_material_id,attempt_id,source_material_id,requested_count,product_count,profile_version,executor_id,settings_snapshot,provider_context,recipe_row_ids,child_request_ids,assignment_seed)
 select n.attempt_id,n.team_id,n.actor_id,n.catalog_material_id,n.attempt_id,n.source_material_id,n.requested_count,n.product_count,n.profile_version,gen_random_uuid(),'{}'::jsonb,'{}'::jsonb,n.recipe_row_ids,n.child_request_ids,n.assignment_seed
 from private.catalog_variant_round_snapshots n where n.attempt_id=(select id from legacy_round);
update private.catalog_updater_variant_requests set failure_code='RESTITCH_INVALID' where request_id=(select id from legacy_round);
update public.team_catalog_updater_items set lease_owner='catalog-variants:'||(select id from legacy_round)::text,lease_expires_at='infinity'
 where catalog_material_id='c0700000-0000-4000-8000-000000000061';
-- Saved settings: resume repairs the request instead of failing it again.
select is(pg_temp.resume((select id from legacy_round))#>>'{settings_snapshot,configured}','true','a stuck request takes settings saved since');
select is((select failure_code from private.catalog_updater_variant_requests where request_id=(select id from legacy_round)),null,'and forgets the old refusal');
-- Both screens off again: the stuck request ends instead of waiting for ever.
update private.catalog_updater_variant_requests set settings_snapshot='{}'::jsonb where request_id=(select id from legacy_round);
update public.team_restitch_defaults set end_enabled=false where team_id='c0700000-0000-4000-8000-000000000011';
select is(pg_temp.resume((select id from legacy_round))->>'failureCode','RESTITCH_INVALID','a stuck request without settings is refused on resume');
select ok((select canceled_at is not null and failure_code='RESTITCH_INVALID' from private.catalog_updater_variant_requests where request_id=(select id from legacy_round)),'the stuck request is closed with the code');
select is((select result||':'||failure_code from public.team_catalog_update_attempts where attempt_id=(select id from legacy_round)),'failed:RESTITCH_INVALID','its attempt ends as failed');
select ok(not exists(select 1 from public.team_catalog_updater_items where catalog_material_id='c0700000-0000-4000-8000-000000000061' and (round_due_at is not null or lease_owner is not null)),'the catalog is free again');

select * from finish();
rollback;
