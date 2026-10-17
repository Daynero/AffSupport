begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(44);
select ok(exists(select 1 from public.team_error_codes where code='UNVERIFIED_UPLOAD'),
 'unverified upload rejection is in the hosted closed code list');

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
('bd370000-0000-4000-8000-000000000001','authenticated','authenticated','orphan-owner@example.test','{}','{}'),
('bd370000-0000-4000-8000-000000000002','authenticated','authenticated','orphan-other@example.test','{}','{}');
insert into public.admin_users(user_id) values ('bd370000-0000-4000-8000-000000000001');
insert into public.teams(id,name,owner_id) values
('bd370000-0000-4000-8000-000000000010','Orphan fixture','bd370000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
('bd370000-0000-4000-8000-000000000010','bd370000-0000-4000-8000-000000000001','admin');
insert into private.google_drive_credentials
  (id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope) values
('bd370000-0000-4000-8000-000000000011','bd370000-0000-4000-8000-000000000001',
 'orphan-test','orphan-owner@example.test',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections
  (id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,initial_sync_state) values
('bd370000-0000-4000-8000-000000000012','bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000011','orphan-root','Orphan root','my_drive','connected','ready');
insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind) values
('bd370000-0000-4000-8000-000000000021','bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000012','orphan-a','A','file'),
('bd370000-0000-4000-8000-000000000022','bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000012','orphan-b','B','file'),
('bd370000-0000-4000-8000-000000000023','bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000012','orphan-c','C','file');
insert into public.team_tasks(id,team_id,created_by,title) values
('bd370000-0000-4000-8000-000000000030','bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000001','Task');
insert into public.team_task_attachments(team_id,task_id,material_id,position,attached_by) values
('bd370000-0000-4000-8000-000000000010','bd370000-0000-4000-8000-000000000030',
 'bd370000-0000-4000-8000-000000000021',0,'bd370000-0000-4000-8000-000000000001'),
('bd370000-0000-4000-8000-000000000010','bd370000-0000-4000-8000-000000000030',
 'bd370000-0000-4000-8000-000000000022',1,'bd370000-0000-4000-8000-000000000001'),
('bd370000-0000-4000-8000-000000000010','bd370000-0000-4000-8000-000000000030',
 'bd370000-0000-4000-8000-000000000023',2,'bd370000-0000-4000-8000-000000000001');
insert into public.team_operations(id,team_id,actor_id,kind,state,result_material_id,
 idempotency_key,request_nonce,finished_at) values
('bd370000-0000-4000-8000-000000000040','bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000001','upload','succeeded',
 'bd370000-0000-4000-8000-000000000021','orphan-upload-key','orphan-upload-nonce',now());

select set_config('request.jwt.claim.sub','bd370000-0000-4000-8000-000000000002',true);
select throws_ok($$select public.mark_team_task_upload(
 'bd370000-0000-4000-8000-000000000010','bd370000-0000-4000-8000-000000000030',
 'bd370000-0000-4000-8000-000000000021','bd370000-0000-4000-8000-000000000040')$$,
 '42501','PERMISSION_DENIED','outsider cannot mark an upload');
select set_config('request.jwt.claim.sub','bd370000-0000-4000-8000-000000000001',true);
select throws_ok($$select public.mark_team_task_upload(
 'bd370000-0000-4000-8000-000000000010','bd370000-0000-4000-8000-000000000030',
 'bd370000-0000-4000-8000-000000000022','bd370000-0000-4000-8000-000000000040')$$,
 '22023','UNVERIFIED_UPLOAD','another material cannot inherit upload provenance');
select ok(public.mark_team_task_upload('bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000030','bd370000-0000-4000-8000-000000000021',
 'bd370000-0000-4000-8000-000000000040'),'exact successful upload marks the attachment');
select ok(public.mark_team_task_upload('bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000030','bd370000-0000-4000-8000-000000000021',
 'bd370000-0000-4000-8000-000000000040'),'mark replay is idempotent');
create temporary table detach_receipt as select public.detach_team_task_material_v2(
 'bd370000-0000-4000-8000-000000000010','bd370000-0000-4000-8000-000000000030',
 'bd370000-0000-4000-8000-000000000021') as result;
select is((select result->>'state' from detach_receipt),'waiting','verified upload gets a waiting intent');
select ok((select (result->>'undoDeadline')::timestamptz - (result->>'detachedAt')::timestamptz
 from detach_receipt) = interval '30 seconds','server gives exactly thirty seconds');
select is(public.detach_team_task_material_v2('bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000030','bd370000-0000-4000-8000-000000000021')->>'state',
 'already_detached','detach replay makes no second intent');
select is(public.detach_team_task_material_v2('bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000030','bd370000-0000-4000-8000-000000000022')->>'state',
 'cleanup_unverified','external material is retained');
select ok(public.detach_team_task_material('bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000030','bd370000-0000-4000-8000-000000000023'),
 'legacy boolean detach still reports success');
select is((select count(*) from private.team_task_orphan_intents where material_id=
 'bd370000-0000-4000-8000-000000000023'),1::bigint,
 'legacy boolean detach also creates a server intent');
update private.team_task_orphan_intents set state='claimed' where material_id=
 'bd370000-0000-4000-8000-000000000021';
select throws_ok($$insert into public.team_task_attachments(team_id,task_id,material_id,position,attached_by) values
('bd370000-0000-4000-8000-000000000010','bd370000-0000-4000-8000-000000000030',
 'bd370000-0000-4000-8000-000000000021',0,'bd370000-0000-4000-8000-000000000001')$$,
 '55000','WRONG_STATE','a new attachment cannot race an in-flight provider trash');
update private.team_task_orphan_intents set state='waiting' where material_id=
 'bd370000-0000-4000-8000-000000000021';
insert into public.team_task_attachments(team_id,task_id,material_id,position,attached_by) values
('bd370000-0000-4000-8000-000000000010','bd370000-0000-4000-8000-000000000030',
 'bd370000-0000-4000-8000-000000000021',0,'bd370000-0000-4000-8000-000000000001');
select is((select state from private.team_task_orphan_intents where material_id=
 'bd370000-0000-4000-8000-000000000021'),'cancelled','reattachment cancels a concurrent claim');
select is((select state from private.team_task_orphan_intents where material_id=
 'bd370000-0000-4000-8000-000000000022'),'cleanup_unverified',
 'unknown provenance stays retained');
select is(private.sweep_task_orphan_uncertainty(),0,
 'worker does not settle an intent before its server deadline');
update private.team_task_orphan_intents set cleanup_not_before=clock_timestamp()-interval '1 second'
 where material_id='bd370000-0000-4000-8000-000000000021';
select is(private.sweep_task_orphan_uncertainty(),0,
 'cancelled Undo stays cancelled after the deadline');
insert into public.team_task_attachments(team_id,task_id,material_id,position,attached_by) values
('bd370000-0000-4000-8000-000000000010','bd370000-0000-4000-8000-000000000030',
 'bd370000-0000-4000-8000-000000000022',1,'bd370000-0000-4000-8000-000000000001');
select public.detach_team_task_material_v2('bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000030','bd370000-0000-4000-8000-000000000021');
update private.team_task_orphan_intents set cleanup_not_before=clock_timestamp()-interval '1 second'
 where material_id='bd370000-0000-4000-8000-000000000021' and state='waiting';
update private.team_task_orphan_intents set state='claimed', lease_until=clock_timestamp()+interval '1 hour'
 where material_id='bd370000-0000-4000-8000-000000000021' and state='waiting';
select is(private.sweep_task_orphan_uncertainty(),0,
 'a live worker claim is not settled before its lease expires');
update private.team_task_orphan_intents set lease_until=null
 where material_id='bd370000-0000-4000-8000-000000000021' and state='claimed';
select private.invoke_catalog_updater_worker();
select is((select state from private.team_task_orphan_intents where material_id=
 'bd370000-0000-4000-8000-000000000021' and state='claimed'),
 'claimed','worker outage preserves a recoverable claim without claiming provider trash');
select is((select reason_code from private.team_task_orphan_intents where material_id=
 'bd370000-0000-4000-8000-000000000021' and state='claimed'),
 null::text,'a missing worker does not invent an uncertainty reason');
update private.team_task_orphan_intents set state='cleanup_unverified',reason_code='TEST_SETUP'
 where material_id='bd370000-0000-4000-8000-000000000021' and state='claimed';
select ok(position('orphan-b' in (select string_agg(row_to_json(r)::text,'') from public.analytics_task_orphan_receipts r
 where actor_id='bd370000-0000-4000-8000-000000000001' and state='cleanup_unverified'))=0,
 'diagnostic receipt contains no file identity');
select ok(not has_table_privilege('authenticated','private.team_task_upload_markers','SELECT')
 and not has_table_privilege('authenticated','private.team_task_orphan_intents','SELECT'),
 'provenance and intents are private');

insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind) values
('bd370000-0000-4000-8000-000000000024','bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000012','orphan-d','D','file'),
('bd370000-0000-4000-8000-000000000025','bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000012','orphan-e','E','file'),
('bd370000-0000-4000-8000-000000000026','bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000012','orphan-f','F','file');
insert into public.team_operations(id,team_id,actor_id,kind,state,result_material_id,
 idempotency_key,request_nonce,finished_at) values
('bd370000-0000-4000-8000-000000000044','bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000001','upload','succeeded',
 'bd370000-0000-4000-8000-000000000024','orphan-upload-d','orphan-nonce-d',now()),
('bd370000-0000-4000-8000-000000000045','bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000001','upload','succeeded',
 'bd370000-0000-4000-8000-000000000025','orphan-upload-e','orphan-nonce-e',now()),
('bd370000-0000-4000-8000-000000000046','bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000001','upload','succeeded',
 'bd370000-0000-4000-8000-000000000026','orphan-upload-f','orphan-nonce-f',now());
insert into public.team_task_attachments(team_id,task_id,material_id,position,attached_by) values
('bd370000-0000-4000-8000-000000000010','bd370000-0000-4000-8000-000000000030',
 'bd370000-0000-4000-8000-000000000024',3,'bd370000-0000-4000-8000-000000000001'),
('bd370000-0000-4000-8000-000000000010','bd370000-0000-4000-8000-000000000030',
 'bd370000-0000-4000-8000-000000000025',4,'bd370000-0000-4000-8000-000000000001'),
('bd370000-0000-4000-8000-000000000010','bd370000-0000-4000-8000-000000000030',
 'bd370000-0000-4000-8000-000000000026',5,'bd370000-0000-4000-8000-000000000001');
select ok(public.mark_team_task_upload('bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000030','bd370000-0000-4000-8000-000000000024',
 'bd370000-0000-4000-8000-000000000044'),'first cleanup candidate has exact upload provenance');
select ok(public.mark_team_task_upload('bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000030','bd370000-0000-4000-8000-000000000025',
 'bd370000-0000-4000-8000-000000000045'),'shared candidate has exact upload provenance');
select ok(public.mark_team_task_upload('bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000030','bd370000-0000-4000-8000-000000000026',
 'bd370000-0000-4000-8000-000000000046'),'retry candidate has exact upload provenance');
select public.detach_team_task_material_v2('bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000030','bd370000-0000-4000-8000-000000000024');
select public.detach_team_task_material_v2('bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000030','bd370000-0000-4000-8000-000000000025');
select public.detach_team_task_material_v2('bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000030','bd370000-0000-4000-8000-000000000026');
insert into public.team_tasks(id,team_id,created_by,title) values
('bd370000-0000-4000-8000-000000000031','bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000001','Other task');
insert into public.team_task_attachments(team_id,task_id,material_id,position,attached_by) values
('bd370000-0000-4000-8000-000000000010','bd370000-0000-4000-8000-000000000031',
 'bd370000-0000-4000-8000-000000000025',0,'bd370000-0000-4000-8000-000000000001');
update private.team_task_orphan_intents set cleanup_not_before=clock_timestamp()-interval '1 second'
 where material_id in ('bd370000-0000-4000-8000-000000000024',
 'bd370000-0000-4000-8000-000000000025','bd370000-0000-4000-8000-000000000026');
create temporary table claimed_task_orphans as select * from public.service_claim_task_orphan_cleanups('worker-one',10,120);
select is((select count(*) from claimed_task_orphans),2::bigint,
 'only unreferenced verified uploads are claimed after the deadline');
select is((select state from private.team_task_orphan_intents where material_id=
 'bd370000-0000-4000-8000-000000000025'),'cancelled',
 'new task reference cancels cleanup instead of reaching Drive');
select throws_ok($$insert into public.team_task_attachments(team_id,task_id,material_id,position,attached_by) values
('bd370000-0000-4000-8000-000000000010','bd370000-0000-4000-8000-000000000031',
 'bd370000-0000-4000-8000-000000000024',1,'bd370000-0000-4000-8000-000000000001')$$,
 '55000','WRONG_STATE','claimed file rejects racing task reference');
select ok(public.service_complete_task_orphan_cleanup((select intent_id from claimed_task_orphans
 where material_id='bd370000-0000-4000-8000-000000000024'),'worker-one',true),
 'provider-confirmed trash finalizes the matching claim');
select is((select lifecycle from public.team_materials where id=
 'bd370000-0000-4000-8000-000000000024'),'trashed',
 'confirmed task orphan has a catalog tombstone');
select ok((select i.updated_at-i.cleanup_not_before < interval '5 minutes'
 from private.team_task_orphan_intents i where i.material_id=
 'bd370000-0000-4000-8000-000000000024' and i.state='confirmed_in_trash'),
 'healthy immediate worker confirmation is inside the five-minute bound');
select ok(not public.service_complete_task_orphan_cleanup((select intent_id from claimed_task_orphans
 where material_id='bd370000-0000-4000-8000-000000000026'),'wrong-worker',true),
 'another worker cannot complete a leased claim');
select throws_ok($$insert into public.team_launches(team_id,created_by,draft_config) values
('bd370000-0000-4000-8000-000000000010','bd370000-0000-4000-8000-000000000001',
 '{"materialId":"bd370000-0000-4000-8000-000000000026"}'::jsonb)$$,
 '55000','WRONG_STATE','launch cannot acquire a material during in-flight cleanup');
select ok(not public.service_complete_task_orphan_cleanup((select intent_id from claimed_task_orphans
 where material_id='bd370000-0000-4000-8000-000000000026'),'worker-one',false),
 'provider failure leaves the file active and schedules retry');
select is((select state from private.team_task_orphan_intents where material_id=
 'bd370000-0000-4000-8000-000000000026'),'waiting',
 'failed provider attempt remains retryable');
update private.team_task_orphan_intents set cleanup_not_before=clock_timestamp()-interval '1 second'
 where material_id='bd370000-0000-4000-8000-000000000026';
create temporary table recovered_task_orphan as select * from public.service_claim_task_orphan_cleanups('worker-two',1,120);
select is((select count(*) from recovered_task_orphan),1::bigint,
 'a worker restart reclaims a due failed provider attempt');
select ok(not public.service_complete_task_orphan_cleanup((select intent_id from recovered_task_orphan),
 'worker-one',true),'old worker cannot finalize a recovered lease');
select ok(not public.service_complete_task_orphan_cleanup((select intent_id from recovered_task_orphan),
 'worker-two',false),'recovered worker can schedule another bounded retry');
select ok((select cleanup_not_before>clock_timestamp() from private.team_task_orphan_intents
 where material_id='bd370000-0000-4000-8000-000000000026'),
 'retry waits for bounded backoff instead of hot-looping');
update private.team_task_orphan_intents set state='claimed',attempt_count=20,
 lease_owner='lost-worker',lease_until=clock_timestamp()-interval '1 second'
 where material_id='bd370000-0000-4000-8000-000000000026';
select private.invoke_catalog_updater_worker();
select is((select state from private.team_task_orphan_intents where material_id=
 'bd370000-0000-4000-8000-000000000026'),'failed',
 'minute cron settles an exhausted lost lease');
select is((select reason_code from private.team_task_orphan_intents where material_id=
 'bd370000-0000-4000-8000-000000000026'),'RETRY_EXHAUSTED',
 'exhausted lost lease has an agent-readable reason');
insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind) values
('bd370000-0000-4000-8000-000000000027','bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000012','orphan-g','G','file');
insert into public.team_operations(id,team_id,actor_id,kind,state,result_material_id,
 idempotency_key,request_nonce,finished_at) values
('bd370000-0000-4000-8000-000000000047','bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000001','upload','succeeded',
 'bd370000-0000-4000-8000-000000000027','orphan-upload-g','orphan-nonce-g',now());
insert into public.team_task_attachments(team_id,task_id,material_id,position,attached_by) values
('bd370000-0000-4000-8000-000000000010','bd370000-0000-4000-8000-000000000030',
 'bd370000-0000-4000-8000-000000000027',6,'bd370000-0000-4000-8000-000000000001');
select ok(public.mark_team_task_upload('bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000030','bd370000-0000-4000-8000-000000000027',
 'bd370000-0000-4000-8000-000000000047'),'launch-source candidate has exact provenance');
insert into public.team_launches(team_id,created_by,draft_config) values
('bd370000-0000-4000-8000-000000000010','bd370000-0000-4000-8000-000000000001',
 '{"materialId":"bd370000-0000-4000-8000-000000000027"}'::jsonb);
select public.detach_team_task_material_v2('bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000030','bd370000-0000-4000-8000-000000000027');
update private.team_task_orphan_intents set cleanup_not_before=clock_timestamp()-interval '1 second'
 where material_id='bd370000-0000-4000-8000-000000000027';
select public.service_claim_task_orphan_cleanups('worker-one',10,120);
select is((select reason_code from private.team_task_orphan_intents where material_id=
 'bd370000-0000-4000-8000-000000000027'),'MATERIAL_REFERENCED',
 'existing launch source retains the file before any provider call');
select is((select lifecycle from public.team_materials where id=
 'bd370000-0000-4000-8000-000000000027'),'active',
 'referenced launch source remains available');
create table private.spec037_unknown_reference(material_id uuid);
select is(private.task_orphan_reference_reason('bd370000-0000-4000-8000-000000000010',
 'bd370000-0000-4000-8000-000000000027'), 'REFERENCE_INVENTORY_UNVERIFIED',
 'a new material-shaped column fails closed until inventory and fence are reviewed');
drop table private.spec037_unknown_reference;
select * from finish();
rollback;
