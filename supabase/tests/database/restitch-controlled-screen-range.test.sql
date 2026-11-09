begin;
-- Real Auth-session shape and private native-control binding; no provider I/O.
select plan(12);
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('b1770000-0000-4000-8000-000000000001','authenticated','authenticated','selection-owner@test.invalid','{}','{}'),
 ('b1770000-0000-4000-8000-000000000002','authenticated','authenticated','selection-actor@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('b1770000-0000-4000-8000-000000000001'),('b1770000-0000-4000-8000-000000000002');
insert into public.teams(id,name,owner_id) values('b1770000-0000-4000-8000-000000000011','Synthetic bounded selection','b1770000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('b1770000-0000-4000-8000-000000000011','b1770000-0000-4000-8000-000000000001','admin'),
 ('b1770000-0000-4000-8000-000000000011','b1770000-0000-4000-8000-000000000002','admin');
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope)
 values('b1770000-0000-4000-8000-000000000021','b1770000-0000-4000-8000-000000000001','selection-synthetic','selection-owner@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)
 values('b1770000-0000-4000-8000-000000000031','b1770000-0000-4000-8000-000000000011','b1770000-0000-4000-8000-000000000021','selection-root','Synthetic root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version) values
 ('b1770000-0000-4000-8000-000000000041','b1770000-0000-4000-8000-000000000011','b1770000-0000-4000-8000-000000000031','selection-video','selection-root','Synthetic.mp4','file','video','video/mp4',4,repeat('c',32),'1'),
 ('b1770000-0000-4000-8000-000000000042','b1770000-0000-4000-8000-000000000011','b1770000-0000-4000-8000-000000000031','selection-image','selection-root','Synthetic.png','file','image','image/png',4,repeat('a',32),'1'),
 ('b1770000-0000-4000-8000-000000000045','b1770000-0000-4000-8000-000000000011','b1770000-0000-4000-8000-000000000031','selection-image-two','selection-root','Synthetic-two.png','file','image','image/png',4,repeat('b',32),'1');

select set_config('request.jwt.claim.sub','b1770000-0000-4000-8000-000000000001',true);
select public.set_restitch_defaults('b1770000-0000-4000-8000-000000000011',
 '{"operation":"restitch","sourceMode":"drive","fitMode":"cover","startEnabled":false,"endEnabled":true,"finalDurationMode":"custom","customFinalDurationSeconds":3}'::jsonb);
select set_config('request.jwt.claim.sub','',true);
insert into public.team_restitch_sources(team_id,slot,material_id,kind,sort_order,added_by)
 values('b1770000-0000-4000-8000-000000000011','end','b1770000-0000-4000-8000-000000000042','file',1,'b1770000-0000-4000-8000-000000000001');
create temp table native_control_context as select
 (public.service_accept_manual_restitch_download('b1770000-0000-4000-8000-000000000011',
 'b1770000-0000-4000-8000-000000000002','b1770000-0000-4000-8000-000000000041',
 'native-control-fixture-key','b1770000-0000-4000-8000-000000000080')->>'operationId')::uuid root;
insert into auth.sessions(id,user_id) values('b1770000-0000-4000-8000-000000000081','b1770000-0000-4000-8000-000000000002');

select public.service_issue_restitch_native_control((select root from native_control_context),
 'b1770000-0000-4000-8000-000000000011','b1770000-0000-4000-8000-000000000002',
 'b1770000-0000-4000-8000-000000000081','b1770000-0000-4000-8000-000000000082',
 'b1770000-0000-4000-8000-000000000083','b1770000-0000-4000-8000-000000000084',decode(repeat('11',32),'hex'),decode(repeat('22',32),'hex'));
select public.service_redeem_restitch_native_control('b1770000-0000-4000-8000-000000000082',decode(repeat('11',32),'hex'));
create temp table controlled_range_owner as select public.service_claim_restitch_native_control(
 'b1770000-0000-4000-8000-000000000082',decode(repeat('22',32),'hex'),'b1770000-0000-4000-8000-000000000085',1) receipt;
create temp table controlled_range_vectors as select s.budget original,c.version_id version,
 jsonb_build_object('schemaVersion',1,'revision',1,'candidates',jsonb_build_array(jsonb_build_object(
 'versionId',c.version_id,'sizeBytes',4,'acquisition',0,'validatedAcquisition',null,'rejected',false)),
 'transfers','[]'::jsonb,'refreshes','[]'::jsonb,'acceptedVersionId',null) selected
 from private.restitch_selection_slots s join private.restitch_selection_candidates c using(root_operation_id,slot)
 where s.root_operation_id=(select root from native_control_context) and s.slot='end' order by c.ordinal limit 1;
select public.service_cas_restitch_selection_slot_owned((select root from native_control_context),
 'b1770000-0000-4000-8000-000000000011','b1770000-0000-4000-8000-000000000002','end',
 (select original from controlled_range_vectors),(select selected from controlled_range_vectors),
 (select (receipt->>'executorId')::uuid from controlled_range_owner),(select (receipt->>'epoch')::bigint from controlled_range_owner));
alter table controlled_range_vectors add column reserved jsonb;
update controlled_range_vectors set reserved=jsonb_set(jsonb_set(selected,'{revision}','2'::jsonb),'{transfers}',
 jsonb_build_array(jsonb_build_object('requestId','b1770000-0000-4000-8000-000000000101','candidateVersionId',version,
 'acquisition',0,'offset',0,'bytesReserved',4,'ioMsReserved',120000,'retry',false,'settlement',null)));
select is((select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in('service_issue_restitch_control_screen_range','service_read_restitch_control_screen_range_issue',
 'service_consume_restitch_control_screen_range','service_read_restitch_control_screen_range_consumption',
 'service_check_restitch_control_screen_range','service_abandon_restitch_control_screen_range','service_refresh_restitch_control_screen_range')
 and has_function_privilege('service_role',p.oid,'execute') and not has_function_privilege('authenticated',p.oid,'execute')
 and not has_function_privilege('anon',p.oid,'execute')),7::bigint,'all controlled range RPCs are service-only');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='private.restitch_control_screen_ranges'::regclass)
 and not has_table_privilege('service_role','private.restitch_control_screen_ranges','select,insert,update,delete'),'binding table is forced-RLS and private');
create temp table controlled_range_issue as select public.service_issue_restitch_control_screen_range(
 'b1770000-0000-4000-8000-000000000082',decode(repeat('22',32),'hex'),'end',(select version from controlled_range_vectors),0,
 'b1770000-0000-4000-8000-000000000101',(select selected from controlled_range_vectors),(select reserved from controlled_range_vectors),
 'b1770000-0000-4000-8000-000000000102',decode(repeat('55',32),'hex')) receipt;
select is((select receipt->>'grantId' from controlled_range_issue),'b1770000-0000-4000-8000-000000000102','leaf is issued under original control');
select is((select control_grant_id::text from private.restitch_control_screen_ranges where range_grant_id='b1770000-0000-4000-8000-000000000102'),'b1770000-0000-4000-8000-000000000082','binding commits with reservation');
select is(public.service_issue_restitch_control_screen_range('b1770000-0000-4000-8000-000000000082',decode(repeat('22',32),'hex'),
 'end',(select version from controlled_range_vectors),0,'b1770000-0000-4000-8000-000000000101',
 (select selected from controlled_range_vectors),(select reserved from controlled_range_vectors),'b1770000-0000-4000-8000-000000000102',decode(repeat('55',32),'hex')),
 (select receipt from controlled_range_issue),'same original issuance does not reserve again');
select throws_ok($$select public.service_consume_restitch_control_screen_range(decode(repeat('55',32),'hex'),'b1770000-0000-4000-8000-000000000103','restitch_source_range_v1')$$,'42501','PERMISSION_DENIED','source purpose cannot consume a screen leaf');
select is(public.service_consume_restitch_control_screen_range(decode(repeat('55',32),'hex'),'b1770000-0000-4000-8000-000000000103','restitch_screen_range_v1')->>'dispatch','true','original server invocation may dispatch');
select is(public.service_consume_restitch_control_screen_range(decode(repeat('55',32),'hex'),'b1770000-0000-4000-8000-000000000104','restitch_screen_range_v1')->>'dispatch','false','another invocation cannot dispatch');
select throws_ok($$select public.service_check_restitch_control_screen_range(decode(repeat('55',32),'hex'),'b1770000-0000-4000-8000-000000000104')$$,'42501','PERMISSION_DENIED','authority check binds original invocation');
delete from auth.sessions where id='b1770000-0000-4000-8000-000000000081';
select is(public.service_read_restitch_control_screen_range_consumption(decode(repeat('55',32),'hex'),'b1770000-0000-4000-8000-000000000103')->>'consumedByInvocation','true','logout retains exact bookkeeping');
select throws_ok($$select public.service_check_restitch_control_screen_range(decode(repeat('55',32),'hex'),'b1770000-0000-4000-8000-000000000103')$$,'42501','AUTH_REQUIRED','logout blocks upstream authority after consumption');
select ok(not public.service_abandon_restitch_control_screen_range('b1770000-0000-4000-8000-000000000082',decode(repeat('22',32),'hex'),
 'end','b1770000-0000-4000-8000-000000000101','b1770000-0000-4000-8000-000000000102'),'consumed cost is not abandoned as zero after logout');
select * from finish();
rollback;
