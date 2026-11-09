begin;
-- Real Auth-session shape and private native-control binding; no provider I/O.
select plan(27);
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('b1740000-0000-4000-8000-000000000001','authenticated','authenticated','selection-owner@test.invalid','{}','{}'),
 ('b1740000-0000-4000-8000-000000000002','authenticated','authenticated','selection-actor@test.invalid','{}','{}');
insert into public.admin_users(user_id) values('b1740000-0000-4000-8000-000000000001'),('b1740000-0000-4000-8000-000000000002');
insert into public.teams(id,name,owner_id) values('b1740000-0000-4000-8000-000000000011','Synthetic bounded selection','b1740000-0000-4000-8000-000000000001');
insert into public.team_members(team_id,user_id,base_role) values
 ('b1740000-0000-4000-8000-000000000011','b1740000-0000-4000-8000-000000000001','admin'),
 ('b1740000-0000-4000-8000-000000000011','b1740000-0000-4000-8000-000000000002','admin');
insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope)
 values('b1740000-0000-4000-8000-000000000021','b1740000-0000-4000-8000-000000000001','selection-synthetic','selection-owner@test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)
 values('b1740000-0000-4000-8000-000000000031','b1740000-0000-4000-8000-000000000011','b1740000-0000-4000-8000-000000000021','selection-root','Synthetic root','my_drive','connected',now());
insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version) values
 ('b1740000-0000-4000-8000-000000000041','b1740000-0000-4000-8000-000000000011','b1740000-0000-4000-8000-000000000031','selection-video','selection-root','Synthetic.mp4','file','video','video/mp4',4,repeat('c',32),'1'),
 ('b1740000-0000-4000-8000-000000000042','b1740000-0000-4000-8000-000000000011','b1740000-0000-4000-8000-000000000031','selection-image','selection-root','Synthetic.png','file','image','image/png',4,repeat('a',32),'1'),
 ('b1740000-0000-4000-8000-000000000045','b1740000-0000-4000-8000-000000000011','b1740000-0000-4000-8000-000000000031','selection-image-two','selection-root','Synthetic-two.png','file','image','image/png',4,repeat('b',32),'1');

select set_config('request.jwt.claim.sub','b1740000-0000-4000-8000-000000000001',true);
select public.set_restitch_defaults('b1740000-0000-4000-8000-000000000011',
 '{"operation":"restitch","sourceMode":"drive","fitMode":"cover","startEnabled":false,"endEnabled":true,"finalDurationMode":"custom","customFinalDurationSeconds":3}'::jsonb);
select set_config('request.jwt.claim.sub','',true);
insert into public.team_restitch_sources(team_id,slot,material_id,kind,sort_order,added_by)
 values('b1740000-0000-4000-8000-000000000011','end','b1740000-0000-4000-8000-000000000042','file',1,'b1740000-0000-4000-8000-000000000001');
create temp table native_control_context as select
 (public.service_accept_manual_restitch_download('b1740000-0000-4000-8000-000000000011',
 'b1740000-0000-4000-8000-000000000002','b1740000-0000-4000-8000-000000000041',
 'native-control-fixture-key','b1740000-0000-4000-8000-000000000080')->>'operationId')::uuid root;
insert into auth.sessions(id,user_id) values('b1740000-0000-4000-8000-000000000081','b1740000-0000-4000-8000-000000000002');
select is((select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname like 'service_%restitch_native_control%'
 and has_function_privilege('service_role',p.oid,'execute')
 and not has_function_privilege('authenticated',p.oid,'execute')
 and not has_function_privilege('anon',p.oid,'execute')),7::bigint,'seven control RPCs including atomic finish are service-only');
select ok(not has_table_privilege('service_role','private.restitch_native_controls','select,insert,update,delete')
 and not has_table_privilege('authenticated','private.restitch_native_controls','select,insert,update,delete'),'control rows are private even to service role');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='private.restitch_native_controls'::regclass),'control RLS is forced');
select is(public.service_issue_restitch_native_control((select root from native_control_context),
 'b1740000-0000-4000-8000-000000000011','b1740000-0000-4000-8000-000000000002',
 'b1740000-0000-4000-8000-000000000081','b1740000-0000-4000-8000-000000000082',
 'b1740000-0000-4000-8000-000000000083','b1740000-0000-4000-8000-000000000084',
 decode(repeat('11',32),'hex'),decode(repeat('22',32),'hex'))->>'redeemed','false','issuance is not native redemption');
select throws_ok($$select public.service_redeem_restitch_native_control('b1740000-0000-4000-8000-000000000082',decode(repeat('99',32),'hex'))$$,'42501','AUTH_REQUIRED','wrong proof cannot redeem');
select throws_ok($$select public.service_claim_restitch_native_control('b1740000-0000-4000-8000-000000000082',decode(repeat('22',32),'hex'),'b1740000-0000-4000-8000-000000000085',1)$$,'42501','AUTH_REQUIRED','unredeemed control cannot claim');
select is(public.service_redeem_restitch_native_control('b1740000-0000-4000-8000-000000000082',decode(repeat('11',32),'hex'))->>'redeemed','true','native proof redeems original enrollment');
create temp table native_control_claim as select public.service_claim_restitch_native_control(
 'b1740000-0000-4000-8000-000000000082',decode(repeat('22',32),'hex'),'b1740000-0000-4000-8000-000000000085',1) receipt;
select is((select receipt->>'active' from native_control_claim),'true','claim binds one active executor');
select is(public.service_claim_restitch_native_control('b1740000-0000-4000-8000-000000000082',decode(repeat('22',32),'hex'),'b1740000-0000-4000-8000-000000000085',1),(select receipt from native_control_claim),'same claim reads original owner');
select throws_ok($$select public.service_claim_restitch_native_control('b1740000-0000-4000-8000-000000000082',decode(repeat('22',32),'hex'),'b1740000-0000-4000-8000-000000000086',1)$$,'55000','REQUEST_REUSE_CONFLICT','grant cannot change its claim');
select is(public.service_authorize_restitch_native_control('b1740000-0000-4000-8000-000000000082',decode(repeat('22',32),'hex'))->>'executorId',(select receipt->>'executorId' from native_control_claim),'new I/O uses current bound executor');
select public.service_issue_restitch_native_control((select root from native_control_context),
 'b1740000-0000-4000-8000-000000000011','b1740000-0000-4000-8000-000000000002',
 'b1740000-0000-4000-8000-000000000081','b1740000-0000-4000-8000-000000000092',
 'b1740000-0000-4000-8000-000000000093','b1740000-0000-4000-8000-000000000084',
 decode(repeat('33',32),'hex'),decode(repeat('44',32),'hex'));
select public.service_redeem_restitch_native_control('b1740000-0000-4000-8000-000000000092',decode(repeat('33',32),'hex'));
select throws_ok($$select public.service_claim_restitch_native_control('b1740000-0000-4000-8000-000000000092',decode(repeat('44',32),'hex'),'b1740000-0000-4000-8000-000000000085',1)$$,'55000','REQUEST_REUSE_CONFLICT','another grant cannot adopt a leaked claim UUID');
select throws_ok($$select public.service_quiesce_restitch_native_control('b1740000-0000-4000-8000-000000000092',decode(repeat('44',32),'hex'),'b1740000-0000-4000-8000-000000000085','b1740000-0000-4000-8000-000000000087')$$,'55000','REQUEST_REUSE_CONFLICT','another grant cannot close the original owner');
delete from auth.sessions where id='b1740000-0000-4000-8000-000000000081';
select throws_ok($$select public.service_authorize_restitch_native_control('b1740000-0000-4000-8000-000000000082',decode(repeat('22',32),'hex'))$$,'42501','AUTH_REQUIRED','logout blocks new I/O');
select is(public.service_read_restitch_native_control_claim('b1740000-0000-4000-8000-000000000082',decode(repeat('22',32),'hex'),'b1740000-0000-4000-8000-000000000085')->>'active','true','logout preserves original bookkeeping');
select ok(public.service_quiesce_restitch_native_control('b1740000-0000-4000-8000-000000000082',decode(repeat('22',32),'hex'),'b1740000-0000-4000-8000-000000000085','b1740000-0000-4000-8000-000000000087'),'exact late closure allowed after logout');
select ok(public.service_quiesce_restitch_native_control('b1740000-0000-4000-8000-000000000082',decode(repeat('22',32),'hex'),'b1740000-0000-4000-8000-000000000085','b1740000-0000-4000-8000-000000000087'),'same historical nonce is idempotent');
select throws_ok($$select public.service_quiesce_restitch_native_control('b1740000-0000-4000-8000-000000000082',decode(repeat('22',32),'hex'),'b1740000-0000-4000-8000-000000000085','b1740000-0000-4000-8000-000000000088')$$,'55000','REQUEST_REUSE_CONFLICT','historical closure nonce cannot change');
select is(public.service_read_restitch_native_control_claim('b1740000-0000-4000-8000-000000000082',decode(repeat('22',32),'hex'),'b1740000-0000-4000-8000-000000000085')->>'active','false','closed receipt stays inactive');
select is((select count(*) from private.restitch_native_controls where root_operation_id=(select root from native_control_context)),2::bigint,'logout does not erase control evidence');
-- 449: late logical completion is atomic with the original already joined owner.
select is((select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in('service_read_restitch_control_selection','service_cas_restitch_control_selection','service_finish_restitch_native_control')
 and has_function_privilege('service_role',p.oid,'execute') and not has_function_privilege('authenticated',p.oid,'execute')
 and not has_function_privilege('anon',p.oid,'execute')),3::bigint,'selection and finish adapters are service-only');
select ok(public.service_finish_restitch_native_control('b1740000-0000-4000-8000-000000000082',decode(repeat('22',32),'hex'),'b1740000-0000-4000-8000-000000000085','b1740000-0000-4000-8000-000000000087','failed'),'exact failed finish works after logout and joined closure');
select ok(public.service_finish_restitch_native_control('b1740000-0000-4000-8000-000000000082',decode(repeat('22',32),'hex'),'b1740000-0000-4000-8000-000000000085','b1740000-0000-4000-8000-000000000087','failed'),'same outcome and nonce replay without another operation');
select is((select state from public.team_operations where id=(select root from native_control_context)),'failed','logical root receives the failed terminal');
select is((select terminal_outcome from private.restitch_selection_executor_claims where claim_id='b1740000-0000-4000-8000-000000000085'),'failed','native outcome is retained');
select throws_ok($$select public.service_finish_restitch_native_control('b1740000-0000-4000-8000-000000000082',decode(repeat('22',32),'hex'),'b1740000-0000-4000-8000-000000000085','b1740000-0000-4000-8000-000000000087','delivered')$$,'55000','REQUEST_REUSE_CONFLICT','replay cannot substitute delivery for failure');
select throws_ok($$select public.service_finish_restitch_native_control('b1740000-0000-4000-8000-000000000082',decode(repeat('22',32),'hex'),'b1740000-0000-4000-8000-000000000085','b1740000-0000-4000-8000-000000000088','failed')$$,'55000','REQUEST_REUSE_CONFLICT','replay cannot replace the joined nonce');
select * from finish();
rollback;
