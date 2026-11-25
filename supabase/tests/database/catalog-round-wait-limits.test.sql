begin;
select plan(37);

-- 072 П2: a run that cannot run is refused where it was pressed; a round that waits for a
-- computer waits with a growing pause and ends with its code; sets nobody takes up end too.
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('c0721000-0000-4000-8000-000000000001','authenticated','authenticated','wait-limits@test.invalid','{}','{}'),
 ('c0721000-0000-4000-8000-000000000002','authenticated','authenticated','wait-limits-stranger@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('c0721000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
 ('c0721000-0000-4000-8000-000000000011','Wait limits','c0721000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('c0721000-0000-4000-8000-000000000011','c0721000-0000-4000-8000-000000000001','admin') on conflict do nothing;
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
 ('c0721000-0000-4000-8000-000000000021','c0721000-0000-4000-8000-000000000001','wait-limits','wait-limits@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values
 ('c0721000-0000-4000-8000-000000000031','c0721000-0000-4000-8000-000000000011','c0721000-0000-4000-8000-000000000021','wait-root','Root','my_drive','connected',now());
insert into public.team_catalog_updaters(team_id) values('c0721000-0000-4000-8000-000000000011') on conflict (team_id) do nothing;

create function pg_temp.catalog(p_name text,p_restitch boolean) returns uuid language plpgsql as $$
declare video uuid:=gen_random_uuid();sheet uuid:=gen_random_uuid();
begin
 insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version,checksum,lifecycle) values
  (video,'c0721000-0000-4000-8000-000000000011','c0721000-0000-4000-8000-000000000031','v-'||p_name,p_name||'.mp4','file','video','video/mp4','1','0123456789abcdef0123456789abcdef','active');
 insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version,companion_of,companion_kind,lifecycle) values
  (sheet,'c0721000-0000-4000-8000-000000000011','c0721000-0000-4000-8000-000000000031','s-'||p_name,p_name,'file','other','application/vnd.google-apps.spreadsheet','1',video,'product_catalog','active');
 insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot)
  values(sheet,'c0721000-0000-4000-8000-000000000011',video,'https://offer.example.invalid/',4,'https://docs.google.com/spreadsheets/d/'||p_name||'/edit','https://drive.google.com/file/d/v-'||p_name||'/view','{}');
 update public.team_catalog_update_profiles set restitch=p_restitch,video_variant_count=case when p_restitch then 2 else 1 end where catalog_material_id=sheet;
 return sheet;
end $$;
create function pg_temp.open_round(p_catalog uuid) returns uuid language plpgsql as $$
declare attempt uuid;
begin
 insert into public.team_catalog_updater_items(catalog_material_id,team_id,round_due_at,next_attempt_at)
  values(p_catalog,'c0721000-0000-4000-8000-000000000011',clock_timestamp(),clock_timestamp()-interval '1 minute')
  on conflict (catalog_material_id) do update set round_due_at=excluded.round_due_at,next_attempt_at=excluded.next_attempt_at,lease_owner=null,lease_expires_at=null;
 select a.attempt_id into attempt from public.team_catalog_update_attempts a where a.catalog_material_id=p_catalog and a.result='running' order by a.started_at desc limit 1;
 return attempt;
end $$;
create function pg_temp.adopt(p_catalog uuid,p_attempt uuid) returns jsonb language sql as $$
 select public.service_resume_catalog_updater_variants('c0721000-0000-4000-8000-000000000011','c0721000-0000-4000-8000-000000000001',p_catalog,p_attempt);
$$;
create function pg_temp.round(p_attempt uuid) returns text language sql as $$
 select a.result||':'||coalesce(a.failure_code,'-') from public.team_catalog_update_attempts a where a.attempt_id=p_attempt;
$$;

create temporary table restitching as select pg_temp.catalog('restitching',true) id;
create temporary table plain as select pg_temp.catalog('plain',false) id;
create temporary table ids as select (select id from restitching) r,(select id from plain) p;
grant select on ids to authenticated;

-- 1. A run that cannot run is refused before anything opens.
select set_config('request.jwt.claim.sub','c0721000-0000-4000-8000-000000000001',true);
select throws_ok($$select public.run_team_catalog_update_now('c0721000-0000-4000-8000-000000000011',array[(select r from ids)])$$,
 '55000','AGENT_REQUIRED','a re-stitching run without background work is refused');
select throws_ok($$select public.request_team_catalog_update_command('c0721000-0000-4000-8000-000000000011','c0721000-0000-4000-8000-0000000000c1',array[(select r from ids)],'c0721000-0000-4000-8000-000000000001')$$,
 '55000','AGENT_REQUIRED','the run command is refused the same way');
select ok(not exists(select 1 from private.team_catalog_update_commands where id='c0721000-0000-4000-8000-0000000000c1'),'and records nothing, so asking again after the fix is a new command');
select ok(not exists(select 1 from public.team_catalog_update_attempts where catalog_material_id=(select r from ids)),'no round was opened');
select is(public.run_team_catalog_update_now('c0721000-0000-4000-8000-000000000011',array[(select p from ids)]),1,'a catalog that does not re-stitch still runs without background work');
update public.team_drive_connections set state='needs_reauth' where id='c0721000-0000-4000-8000-000000000031';
select throws_ok($$select public.run_team_catalog_update_now('c0721000-0000-4000-8000-000000000011',array[(select r from ids)])$$,
 '22023','NEEDS_REAUTH','a run over a revoked Drive asks for the Drive first');
update public.team_drive_connections set state='root_missing' where id='c0721000-0000-4000-8000-000000000031';
select throws_ok($$select public.run_team_catalog_update_now('c0721000-0000-4000-8000-000000000011',array[(select r from ids)])$$,
 '22023','ROOT_MISSING','a run whose Drive folder is gone says so');
update public.team_drive_connections set state='connected' where id='c0721000-0000-4000-8000-000000000031';
delete from public.admin_users where user_id='c0721000-0000-4000-8000-000000000001';
select is(private.team_workspace_allowed('c0721000-0000-4000-8000-000000000011'),false,'(the space is paused: no tariff, no admin)');
select throws_ok($$select public.run_team_catalog_update_now('c0721000-0000-4000-8000-000000000011',array[(select p from ids)])$$,
 '42501','SPACE_BLOCKED','a run in a paused space says the space is paused, not «no permission»');
select throws_ok($$select public.request_team_catalog_update_command('c0721000-0000-4000-8000-000000000011','c0721000-0000-4000-8000-0000000000c2',array[(select p from ids)],'c0721000-0000-4000-8000-000000000001')$$,
 '42501','SPACE_BLOCKED','so does the run command');
select throws_ok($$select public.retry_team_catalog_update('c0721000-0000-4000-8000-000000000011',(select p from ids),gen_random_uuid())$$,
 '42501','SPACE_BLOCKED','and a retry');
insert into public.admin_users(user_id) values('c0721000-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.sub','c0721000-0000-4000-8000-000000000002',true);
select throws_ok($$select public.run_team_catalog_update_now('c0721000-0000-4000-8000-000000000011',array[(select p from ids)])$$,
 '42501','PERMISSION_DENIED','a stranger is still refused as before');
select set_config('request.jwt.claim.sub','',true);

-- 2. A round waiting for a computer waits with a growing pause, then ends.
create temporary table w as select pg_temp.open_round((select r from ids)) id;
select is(pg_temp.adopt((select r from ids),(select id from w))->>'failureCode','AGENT_REQUIRED','a round without background work waits for it');
select is(pg_temp.round((select id from w)),'running:AGENT_REQUIRED','still running, with the reason');
select ok((select next_attempt_at between clock_timestamp()+interval '50 seconds' and clock_timestamp()+interval '70 seconds' from public.team_catalog_updater_items where catalog_material_id=(select r from ids)),'asked again in a minute at first');
update public.team_catalog_update_attempts set started_at=clock_timestamp()-interval '90 minutes' where attempt_id=(select id from w);
update public.team_catalog_updater_items set next_attempt_at=clock_timestamp()-interval '1 second' where catalog_material_id=(select r from ids);
select is(pg_temp.adopt((select r from ids),(select id from w))->>'failureCode','AGENT_REQUIRED','an hour and a half on it still waits');
select ok((select next_attempt_at>clock_timestamp()+interval '14 minutes' from public.team_catalog_updater_items where catalog_material_id=(select r from ids)),'but is asked only every fifteen minutes');
update public.team_catalog_update_attempts set started_at=clock_timestamp()-interval '2 hours 1 minute' where attempt_id=(select id from w);
update public.team_catalog_updater_items set next_attempt_at=clock_timestamp()-interval '1 second' where catalog_material_id=(select r from ids);
select is(pg_temp.adopt((select r from ids),(select id from w))->>'failureCode','AGENT_REQUIRED','after two hours');
select is(pg_temp.round((select id from w)),'failed:AGENT_REQUIRED','the round ends with AGENT_REQUIRED');
select is((select last_update_error from public.team_product_catalogs where material_id=(select r from ids)),'AGENT_REQUIRED','and the catalog says what to set up');
select ok(not exists(select 1 from public.team_catalog_updater_items where catalog_material_id=(select r from ids) and round_due_at is not null),'the catalog is free');

-- 3. Codes that do not pass end the round at once.
create temporary table d1 as select pg_temp.open_round((select r from ids)) id;
select is(private.note_catalog_variant_round_wait((select id from d1),'SOURCE_CHANGED')->>'failureCode','SOURCE_CHANGED','a changed source');
select is(pg_temp.round((select id from d1)),'failed:SOURCE_CHANGED','ends the round');
create temporary table d2 as select pg_temp.open_round((select r from ids)) id;
select is(private.note_catalog_variant_round_wait((select id from d2),'PERMISSION_DENIED')->>'failureCode','PERMISSION_DENIED','a refused permission');
select is(pg_temp.round((select id from d2)),'failed:PERMISSION_DENIED','ends the round');
create temporary table d3 as select pg_temp.open_round((select r from ids)) id;
delete from public.admin_users where user_id='c0721000-0000-4000-8000-000000000001';
select is(private.note_catalog_variant_round_wait((select id from d3),'PERMISSION_DENIED')->>'failureCode','SPACE_BLOCKED','in a paused space it is the pause');
select is(pg_temp.round((select id from d3)),'failed:SPACE_BLOCKED','and the round ends saying so');
insert into public.admin_users(user_id) values('c0721000-0000-4000-8000-000000000001');
create temporary table d4 as select pg_temp.open_round((select r from ids)) id;
select is(private.note_catalog_variant_round_wait((select id from d4),'PROCESS_RESULT_UNCERTAIN')->>'failureCode','PROCESS_RESULT_UNCERTAIN','an uncertain result waits');
select is(pg_temp.round((select id from d4)),'running:PROCESS_RESULT_UNCERTAIN','for now');
update public.team_catalog_update_attempts set started_at=clock_timestamp()-interval '31 minutes' where attempt_id=(select id from d4);
select is(private.note_catalog_variant_round_wait((select id from d4),'PROCESS_RESULT_UNCERTAIN')->>'failureCode','PROCESS_RESULT_UNCERTAIN','after half an hour');
select is(pg_temp.round((select id from d4)),'failed:PROCESS_RESULT_UNCERTAIN','it ends');

-- 4. Sets that no computer takes up.
insert into private.team_recovery_delegations(team_id,actor_id,installation_id,refresh_hash) values
 ('c0721000-0000-4000-8000-000000000011','c0721000-0000-4000-8000-000000000001','c0721000-0000-4000-8000-000000000041',decode(repeat('ab',32),'hex'));
create temporary table s1 as select pg_temp.open_round((select r from ids)) id;
select pg_temp.adopt((select r from ids),(select id from s1));
-- Inserted the way the server admits it (legacy pictures keep the fixture off Drive).
insert into private.catalog_video_sets(id,team_id,actor_id,update_attempt_id,source_material_id,source_version,settings_snapshot,settings_digest,requested_count,product_count,recipe_revision,assignment_seed,assignment_version,executor_id,epoch)
 select q.set_id,q.team_id,q.actor_id,q.attempt_id,q.source_material_id,'1',q.settings_snapshot||'{"sourceMode":"legacy"}',repeat('b',64),q.requested_count,q.product_count,1,repeat('c',64),1,q.executor_id,1
 from private.catalog_updater_variant_requests q where q.request_id=(select id from s1);
update private.catalog_video_sets set created_at=clock_timestamp()-interval '5 hours' where update_attempt_id=(select id from s1);
select is((private.settle_catalog_round_limits(100)->>'unclaimed')::integer,0,'five hours untaken is not yet the limit');
update private.catalog_video_sets set created_at=clock_timestamp()-interval '6 hours 1 minute' where update_attempt_id=(select id from s1);
select is((private.settle_catalog_round_limits(100)->>'unclaimed')::integer,1,'six hours untaken is');
select is(pg_temp.round((select id from s1)),'failed:AGENT_STALLED','with background work that never ran it, the round ends AGENT_STALLED');

-- The computer said its background work stopped (20261224190000): an hour later the round ends with that code.
create temporary table s2 as select pg_temp.open_round((select r from ids)) id;
select pg_temp.adopt((select r from ids),(select id from s2));
insert into private.catalog_video_sets(id,team_id,actor_id,update_attempt_id,source_material_id,source_version,settings_snapshot,settings_digest,requested_count,product_count,recipe_revision,assignment_seed,assignment_version,executor_id,epoch)
 select q.set_id,q.team_id,q.actor_id,q.attempt_id,q.source_material_id,'1',q.settings_snapshot||'{"sourceMode":"legacy"}',repeat('b',64),q.requested_count,q.product_count,1,repeat('c',64),1,q.executor_id,1
 from private.catalog_updater_variant_requests q where q.request_id=(select id from s2);
update private.catalog_video_sets set created_at=clock_timestamp()-interval '2 hours' where update_attempt_id=(select id from s2);
update private.team_recovery_delegations set agent_block_reason='retry_exhausted',agent_block_code='DRIVE_STORAGE_FULL',agent_block_at=clock_timestamp()-interval '30 minutes'
 where installation_id='c0721000-0000-4000-8000-000000000041';
select is((private.settle_catalog_round_limits(100)->>'unclaimed')::integer,0,'a stop reported half an hour ago is not yet the limit');
update private.team_recovery_delegations set agent_block_at=clock_timestamp()-interval '61 minutes' where installation_id='c0721000-0000-4000-8000-000000000041';
select is((private.settle_catalog_round_limits(100)->>'unclaimed')::integer,1,'an hour after the computer reported it stopped');
select is(pg_temp.round((select id from s2)),'failed:DRIVE_STORAGE_FULL','the round ends with the computer''s own reason');

select * from finish();
rollback;
