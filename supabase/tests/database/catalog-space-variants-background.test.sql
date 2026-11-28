begin;
select plan(33);

-- 057 T106 (20261226260000): the variations of a catalog in an R2 space are finished by the
-- member's delegated agent when no page is open. A variation is leased to one agent at a time;
-- a page then waits; the run is opened and bound under the lease; heartbeats keep it and say when
-- to stop; a lapsed lease's run is failed so the variation gets its next attempt; team-recovery
-- learns the backend of an R2 credential (a Drive receipt is unchanged); the cron lane lists a
-- creation whose variations are all made.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05791060-0000-4000-8000-000000000001','authenticated','authenticated','background-owner@test.invalid','{}','{}'),
 ('05791060-0000-4000-8000-000000000002','authenticated','authenticated','background-editor@test.invalid','{}','{}');
insert into public.storage_r2_pilots(user_id,max_space_bytes) values
 ('05791060-0000-4000-8000-000000000001',100000),('05791060-0000-4000-8000-000000000002',100000);

create temporary table seen(label text, value jsonb);
create function pg_temp.team() returns uuid language sql as $$ select (value->>'teamId')::uuid from seen where label='space' $$;
create function pg_temp.root() returns uuid language sql as $$ select (value->>'rootMaterialId')::uuid from seen where label='space' $$;
create function pg_temp.v(p_label text) returns jsonb language sql as $$ select value from seen where label=p_label order by ctid desc limit 1 $$;
create function pg_temp.owner() returns uuid language sql as $$ select '05791060-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.lease(p_n integer) returns bytea language sql as $$ select decode(lpad(to_hex(p_n), 64, '0'), 'hex') $$;
create function pg_temp.set1() returns uuid language sql as $$ select '05791060-0000-4000-8000-0000000000b1'::uuid $$;
create function pg_temp.upload(p_key text, p_content text, p_bytes bigint, p_name text, p_ingress text, p_parent uuid)
returns jsonb language plpgsql as $$
declare v_session jsonb; v_upload uuid;
begin
  v_session := public.service_admit_space_upload(pg_temp.owner(), jsonb_build_object(
    'teamId', pg_temp.team(), 'parentMaterialId', p_parent, 'name', p_name,
    'contentType', 'video/mp4', 'bytes', p_bytes::text, 'contentId', p_content, 'sha256', null,
    'ingress', p_ingress, 'idempotencyKey', p_key,
    'category', 'video', 'classificationSource', 'mime', 'fileExtension', 'mp4'));
  v_upload := (v_session->>'uploadId')::uuid;
  perform public.service_attach_space_upload(v_upload, pg_temp.owner(), 'r2-upload-' || v_upload::text);
  perform public.service_mark_space_upload_completing(v_upload, pg_temp.team(), pg_temp.owner(), p_content, repeat('e',32)||'-1');
  return public.service_complete_space_upload(v_upload, pg_temp.team(), pg_temp.owner(),
    jsonb_build_object('category','video','classificationSource','mime','fileExtension','mp4'))
    || jsonb_build_object('uploadId', v_upload);
end $$;
-- The run space-storage opens for a claimed variation, bound under its lease.
create function pg_temp.open_job(p_claim jsonb, p_lease bytea) returns uuid language plpgsql as $$
declare v_op uuid;
begin
  select operation_id into v_op from public.service_start_team_operation(pg_temp.team(), pg_temp.owner(), 'process',
    'space-variant:'||(p_claim->>'requestId')||':'||(p_claim->>'attempt'),
    'request:space-variant:'||(p_claim->>'requestId')||':'||(p_claim->>'attempt'),
    (p_claim->>'sourceMaterialId')::uuid, pg_temp.root(), 'clip restitched '||(p_claim->>'index')||' '||(p_claim->>'attempt')||'.mp4',
    now()+interval '30 minutes', 400);
  perform public.service_set_team_operation_intent(v_op, pg_temp.owner(), 'Clip restitched.mp4', 'video/mp4', null, null, null, 'restitch', 2);
  perform public.service_transition_team_operation(v_op, 'running', 'awaiting_agent', 0, null, null, false);
  perform public.service_bind_space_catalog_variant_job(pg_temp.team(), pg_temp.owner(), (p_claim->>'jobId')::uuid,
    p_lease, (p_claim->>'attempt')::integer, v_op);
  return v_op;
end $$;
create function pg_temp.finish_run(p_op uuid, p_content text) returns jsonb language plpgsql as $$
declare v_output jsonb;
begin
  v_output := pg_temp.upload('process_output_'||p_op::text, p_content, 150, 'Clip restitched.mp4', 'agent_output', pg_temp.root());
  return public.service_finalize_space_process_output(p_op, pg_temp.owner(), (v_output->>'uploadId')::uuid);
end $$;

insert into seen select 'space', public.service_create_r2_space(pg_temp.owner(),'Background space','background-space-key-1');
insert into public.team_members(team_id,user_id,base_role) values (pg_temp.team(),'05791060-0000-4000-8000-000000000002','editor');
insert into seen select 'source', pg_temp.upload('background-source-01', repeat('a',64), 400, 'Clip.mp4', 'explorer', pg_temp.root());
insert into private.catalog_generation_intents(id,team_id,video_material_id,actor_id,request_key,request_digest,request_payload,variant,state) values
 ('05791060-0000-4000-8000-0000000000a1',pg_temp.team(),(pg_temp.v('source')->>'id')::uuid,pg_temp.owner(),
  'product-catalog:05791060-0000-4000-8000-0000000000a1','d1','{"catalogVideoProtocolVersion":1,"restitchEnabled":true}',1,'interrupted');
insert into seen select 'defaults', public.service_space_catalog_variant_defaults(pg_temp.team(), pg_temp.owner());
select public.service_admit_space_catalog_variants(pg_temp.team(), pg_temp.owner(),
 '05791060-0000-4000-8000-0000000000a1', pg_temp.set1(), (pg_temp.v('source')->>'id')::uuid,
 array['05791060-0000-4000-8000-0000000000c0','05791060-0000-4000-8000-0000000000c1']::uuid[],
 pg_temp.v('defaults'), repeat('d',64));

-- 1. Claiming --------------------------------------------------------------------------------
select throws_ok($$select public.service_claim_space_catalog_variant(pg_temp.team(), pg_temp.owner(), '\x01'::bytea, 120)$$,
 'INVALID_INPUT','a lease hash is 32 bytes');
insert into seen select 'claim0', public.service_claim_space_catalog_variant(pg_temp.team(), pg_temp.owner(), pg_temp.lease(1), 120);
select is(pg_temp.v('claim0')->>'index'||':'||(pg_temp.v('claim0')->>'attempt')||':'||(pg_temp.v('claim0')->>'requestId'),
 '0:1:05791060-0000-4000-8000-0000000000c0','the first variation is leased for its first run');
select is(pg_temp.v('claim0')->'settings', pg_temp.v('defaults'),'with the settings the set froze');
select is(public.service_space_catalog_variant_run(pg_temp.team(), pg_temp.owner(), pg_temp.set1(), 0)->>'state',
 'background','a page is told the agent holds it');
insert into seen select 'claim1', public.service_claim_space_catalog_variant(pg_temp.team(), pg_temp.owner(), pg_temp.lease(2), 120);
select is((pg_temp.v('claim1')->>'index')::integer, 1,'another claim takes the next variation');
select is(public.service_claim_space_catalog_variant(pg_temp.team(), pg_temp.owner(), pg_temp.lease(3), 120), null,
 'nothing is left to lease');
select is(public.service_claim_space_catalog_variant(pg_temp.team(), '05791060-0000-4000-8000-000000000002', pg_temp.lease(4), 120), null,
 'another member''s agent never takes these');

-- 2. Binding and keeping ---------------------------------------------------------------------
select is(public.service_defer_space_catalog_variant_job(pg_temp.owner(), (pg_temp.v('claim1')->>'jobId')::uuid, pg_temp.lease(2), 3600)->>'deferred',
 'true','a lease without a run can be held for an hour');
select ok((select lease_expires_at > now() + interval '50 minutes' from private.space_catalog_variants where set_id=pg_temp.set1() and ordinal=1),
 'the deferred lease holds the variation');
select is(public.service_defer_space_catalog_variant_job(pg_temp.owner(), (pg_temp.v('claim1')->>'jobId')::uuid, pg_temp.lease(9), 3600)->>'deferred',
 'false','another lease defers nothing');
select throws_ok($$select public.service_bind_space_catalog_variant_job(pg_temp.team(), pg_temp.owner(),
 (pg_temp.v('claim0')->>'jobId')::uuid, pg_temp.lease(9), 1, gen_random_uuid())$$,'WRONG_STATE','a lease that is not this one binds nothing');
insert into seen select 'op0', to_jsonb(pg_temp.open_job(pg_temp.v('claim0'), pg_temp.lease(1))::text);
select is((select operation_id from private.space_catalog_variants where set_id=pg_temp.set1() and ordinal=0),
 (pg_temp.v('op0')#>>'{}')::uuid,'the run opened under the lease is bound to the variation');
select is(public.service_space_catalog_variant_run(pg_temp.team(), pg_temp.owner(), pg_temp.set1(), 0)->>'state',
 'background','while the lease lives a page still waits');
select is(public.service_heartbeat_space_catalog_variant_job(pg_temp.owner(), (pg_temp.v('claim0')->>'jobId')::uuid, pg_temp.lease(1), 120)->>'cancel',
 'false','a heartbeat keeps the lease');
select is(public.service_heartbeat_space_catalog_variant_job(pg_temp.owner(), (pg_temp.v('claim0')->>'jobId')::uuid, pg_temp.lease(7), 120)->>'cancel',
 'true','a heartbeat with another lease is told to stop');

-- 3. The output, and what team-recovery reads --------------------------------------------------
select is(private.space_recovery_receipt('authorize_execute', jsonb_build_object('teamId', pg_temp.team(),
 'operationId', pg_temp.v('op0')#>>'{}', 'outputRecorded', false))->>'outputRecorded','false','no output is recorded before finalize');
select is(pg_temp.finish_run((pg_temp.v('op0')#>>'{}')::uuid, repeat('b',64))->>'state','succeeded','the agent''s run finalizes');
select is(private.space_recovery_receipt('authorize_execute', jsonb_build_object('teamId', pg_temp.team(),
 'operationId', pg_temp.v('op0')#>>'{}', 'outputRecorded', false)),
 jsonb_build_object('teamId', pg_temp.team(), 'operationId', pg_temp.v('op0')#>>'{}', 'outputRecorded', true, 'storageBackend', 'r2'),
 'an R2 receipt names its backend and the variation''s recorded output');
select is(private.space_recovery_receipt('authorize_execute', '{"teamId":"05791060-0000-4000-8000-0000000000ff","operationId":null,"outputRecorded":false}'::jsonb),
 '{"teamId":"05791060-0000-4000-8000-0000000000ff","operationId":null,"outputRecorded":false}'::jsonb,'a receipt of any other space is unchanged');
select is(private.space_recovery_receipt('heartbeat', jsonb_build_object('teamId', pg_temp.team())),
 jsonb_build_object('teamId', pg_temp.team()),'only claim and authorize receipts are touched');
select is(private.space_recovery_receipt('claim', '{"pending":true}'::jsonb), '{"pending":true}'::jsonb,'a pending or replayed claim is unchanged');
select is(public.service_complete_space_catalog_variant_job(pg_temp.owner(), (pg_temp.v('claim0')->>'jobId')::uuid, pg_temp.lease(1))->>'recorded',
 'true','complete releases the lease');
select is(public.service_complete_space_catalog_variant_job(pg_temp.owner(), (pg_temp.v('claim0')->>'jobId')::uuid, pg_temp.lease(1))->>'recorded',
 'false','a second complete finds no lease');
select is(public.service_space_catalog_variant_run(pg_temp.team(), pg_temp.owner(), pg_temp.set1(), 0)->>'state',
 'registered','the page sees the variation made');

-- 4. A lapsed lease ---------------------------------------------------------------------------
insert into seen select 'op1', to_jsonb(pg_temp.open_job(pg_temp.v('claim1'), pg_temp.lease(2))::text);
update private.space_catalog_variants set lease_expires_at = now() - interval '1 second' where set_id=pg_temp.set1() and ordinal=1;
select is(public.service_space_catalog_variant_run(pg_temp.team(), pg_temp.owner(), pg_temp.set1(), 1)->>'state',
 'running','a lapsed lease no longer holds a page back');
select is(public.service_list_space_catalog_completions(3), '[]'::jsonb,'a creation with a variation still owed is not listed');
insert into seen select 'claim1b', public.service_claim_space_catalog_variant(pg_temp.team(), pg_temp.owner(), pg_temp.lease(5), 120);
select is((select state from public.team_operations where id=(pg_temp.v('op1')#>>'{}')::uuid),'failed',
 'the next claim fails the run the lapsed lease left open');
select is(pg_temp.v('claim1b')->>'index'||':'||(pg_temp.v('claim1b')->>'attempt'),'1:2','and leases the variation for its next attempt');
insert into seen select 'op1b', to_jsonb(pg_temp.open_job(pg_temp.v('claim1b'), pg_temp.lease(5))::text);
select is(pg_temp.finish_run((pg_temp.v('op1b')#>>'{}')::uuid, repeat('c',64))->>'state','succeeded','the second attempt finalizes');
select public.service_complete_space_catalog_variant_job(pg_temp.owner(), (pg_temp.v('claim1b')->>'jobId')::uuid, pg_temp.lease(5));

-- 5. The cron lane -----------------------------------------------------------------------------
select is(public.service_list_space_catalog_completions(3),
 jsonb_build_array(jsonb_build_object('teamId', pg_temp.team(), 'actorId', pg_temp.owner(),
   'idempotencyKey', 'product-catalog:05791060-0000-4000-8000-0000000000a1')),
 'a creation whose variations are all made is listed for the cron lane');
update private.catalog_generation_intents set next_attempt_at = now() + interval '5 minutes' where id='05791060-0000-4000-8000-0000000000a1';
select is(public.service_list_space_catalog_completions(3), '[]'::jsonb,'a deferred creation waits its turn');

-- 6. Cancel -------------------------------------------------------------------------------------
update private.space_catalog_variant_sets set state='canceled' where id=pg_temp.set1();
update private.space_catalog_variants set job_id=gen_random_uuid(), lease_hash=pg_temp.lease(6), lease_expires_at=now()+interval '1 minute'
 where set_id=pg_temp.set1() and ordinal=1;
select is(public.service_heartbeat_space_catalog_variant_job(pg_temp.owner(),
 (select job_id from private.space_catalog_variants where set_id=pg_temp.set1() and ordinal=1), pg_temp.lease(6), 120)->>'cancel',
 'true','a canceled creation tells the agent to stop');
select ok(strpos(pg_get_functiondef('public.service_team_recovery(text,bytea,jsonb)'::regprocedure),
 'return private.space_recovery_receipt(p_action,private.service_team_recovery_before_automatic(p_action,p_hash,p_input));') > 0,
 'service_team_recovery passes every receipt through the backend note');

select * from finish();
rollback;
