begin;
select plan(30);

-- 057 T112 (20261226290000): a variation run of an R2 space whose agent went silent is closed by
-- the sweep, so the variation gets its next attempt; a run that shows life, a live lease and a
-- finished run are left alone; the third silent run leaves the variation failed; the dialog's
-- read says which; the sweep runs on pg_cron.

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('05791120-0000-4000-8000-000000000001','authenticated','authenticated','stalled-owner@test.invalid','{}','{}');
insert into public.storage_r2_pilots(user_id,max_space_bytes) values ('05791120-0000-4000-8000-000000000001',100000);

create temporary table seen(label text, value jsonb);
create function pg_temp.team() returns uuid language sql as $$ select (value->>'teamId')::uuid from seen where label='space' $$;
create function pg_temp.root() returns uuid language sql as $$ select (value->>'rootMaterialId')::uuid from seen where label='space' $$;
create function pg_temp.v(p_label text) returns jsonb language sql as $$ select value from seen where label=p_label order by ctid desc limit 1 $$;
create function pg_temp.owner() returns uuid language sql as $$ select '05791120-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.lease(p_n integer) returns bytea language sql as $$ select decode(lpad(to_hex(p_n), 64, '0'), 'hex') $$;
create function pg_temp.set1() returns uuid language sql as $$ select '05791120-0000-4000-8000-0000000000b1'::uuid $$;
create function pg_temp.key() returns text language sql as $$ select 'product-catalog:05791120-0000-4000-8000-0000000000a1'::text $$;
create function pg_temp.admit(p_key text, p_content text, p_bytes bigint, p_name text, p_ingress text) returns jsonb
language sql as $$
  select public.service_admit_space_upload(pg_temp.owner(), jsonb_build_object(
    'teamId', pg_temp.team(), 'parentMaterialId', pg_temp.root(), 'name', p_name,
    'contentType', 'video/mp4', 'bytes', p_bytes::text, 'contentId', p_content, 'sha256', null,
    'ingress', p_ingress, 'idempotencyKey', p_key,
    'category', 'video', 'classificationSource', 'mime', 'fileExtension', 'mp4'));
$$;
create function pg_temp.upload(p_key text, p_content text, p_bytes bigint, p_name text, p_ingress text)
returns jsonb language plpgsql as $$
declare v_upload uuid;
begin
  v_upload := (pg_temp.admit(p_key, p_content, p_bytes, p_name, p_ingress)->>'uploadId')::uuid;
  perform public.service_attach_space_upload(v_upload, pg_temp.owner(), 'r2-upload-' || v_upload::text);
  perform public.service_mark_space_upload_completing(v_upload, pg_temp.team(), pg_temp.owner(), p_content, repeat('e',32)||'-1');
  return public.service_complete_space_upload(v_upload, pg_temp.team(), pg_temp.owner(),
    jsonb_build_object('category','video','classificationSource','mime','fileExtension','mp4'))
    || jsonb_build_object('uploadId', v_upload);
end $$;
-- What `/catalog-variants/run` does for a page: the hand-out, the run, the binding, the tickets.
create function pg_temp.page_run(p_index integer) returns uuid language plpgsql as $$
declare v_answer jsonb; v_op uuid;
begin
  v_answer := public.service_space_catalog_variant_run(pg_temp.team(), pg_temp.owner(), pg_temp.set1(), p_index);
  if v_answer->>'state' <> 'open' then raise exception 'not open: %', v_answer; end if;
  select operation_id into v_op from public.service_start_team_operation(pg_temp.team(), pg_temp.owner(), 'process',
    'space-variant:'||(v_answer->>'requestId')||':'||(v_answer->>'attempt'),
    'request:space-variant:'||(v_answer->>'requestId')||':'||(v_answer->>'attempt'),
    (v_answer->>'sourceMaterialId')::uuid, pg_temp.root(), 'clip restitched '||p_index||' '||(v_answer->>'attempt')||'.mp4',
    now()+interval '30 minutes', 400);
  perform public.service_set_team_operation_intent(v_op, pg_temp.owner(), 'Clip restitched.mp4', 'video/mp4', null, null, null, 'restitch', 2);
  perform public.service_transition_team_operation(v_op, 'running', 'awaiting_agent', 0, null, null, false);
  perform public.service_bind_space_catalog_variant_run(pg_temp.team(), pg_temp.owner(), pg_temp.set1(), p_index,
    (v_answer->>'attempt')::integer, v_op);
  perform public.issue_team_transfer_grant(p_token_hash => decode(md5(v_op::text)||md5(v_op::text), 'hex'),
    p_operation => v_op, p_team => pg_temp.team(), p_actor => pg_temp.owner(), p_purpose => 'finalize',
    p_material => (v_answer->>'sourceMaterialId')::uuid, p_destination => pg_temp.root(), p_tool => 'restitch',
    p_max_range_bytes => 1048576, p_expires_at => now() + interval '6 hours', p_max_uses => 240);
  return v_op;
end $$;
create function pg_temp.op(p_label text) returns public.team_operations language sql as $$
  select * from public.team_operations where id = (pg_temp.v(p_label)#>>'{}')::uuid $$;
create function pg_temp.variant(p_index integer) returns private.space_catalog_variants language sql as $$
  select * from private.space_catalog_variants where set_id = pg_temp.set1() and ordinal = p_index $$;
create function pg_temp.read() returns jsonb language sql as $$
  select public.service_read_space_catalog_variants(pg_temp.team(), pg_temp.owner(), pg_temp.key()) $$;

insert into seen select 'space', public.service_create_r2_space(pg_temp.owner(),'Stalled space','stalled-space-key-1');
insert into seen select 'source', pg_temp.upload('stalled-source-01', repeat('a',64), 400, 'Clip.mp4', 'explorer');
insert into private.catalog_generation_intents(id,team_id,video_material_id,actor_id,request_key,request_digest,request_payload,variant,state) values
 ('05791120-0000-4000-8000-0000000000a1',pg_temp.team(),(pg_temp.v('source')->>'id')::uuid,pg_temp.owner(),
  pg_temp.key(),'d1','{"catalogVideoProtocolVersion":1,"restitchEnabled":true}',1,'interrupted');
select public.service_admit_space_catalog_variants(pg_temp.team(), pg_temp.owner(),
 '05791120-0000-4000-8000-0000000000a1', pg_temp.set1(), (pg_temp.v('source')->>'id')::uuid,
 array['05791120-0000-4000-8000-0000000000c0','05791120-0000-4000-8000-0000000000c1']::uuid[],
 public.service_space_catalog_variant_defaults(pg_temp.team(), pg_temp.owner()), repeat('d',64));

-- 1. A page's run that shows life is left alone ------------------------------------------------
insert into seen select 'op0', to_jsonb(pg_temp.page_run(0)::text);
insert into seen select 'out0', pg_temp.admit('process_output_'||(pg_temp.v('op0')#>>'{}'), repeat('b',64), 150, 'Clip restitched.mp4', 'agent_output');
select is(private.sweep_space_catalog_variant_runs(), 0, 'a run with fresh signs of life is not swept');
select is((pg_temp.op('op0')).state, 'running', 'and stays with its agent');
select ok(private.space_catalog_variant_run_life((pg_temp.v('op0')#>>'{}')::uuid) >= (pg_temp.op('op0')).updated_at,
 'its last sign of life is at least its last transition');
select throws_ok($$select private.sweep_space_catalog_variant_runs(interval '-1 second')$$, 'INVALID_INPUT', 'a negative window is refused');
select throws_ok($$select private.sweep_space_catalog_variant_runs(p_limit => 0)$$, 'INVALID_INPUT', 'so is an empty limit');

-- 2. The same run silent past the window ------------------------------------------------------
select is(private.sweep_space_catalog_variant_runs(interval '0 seconds'), 1, 'a silent run is swept');
select is((pg_temp.op('op0')).state||':'||(pg_temp.op('op0')).error_code||':'||(pg_temp.op('op0')).retryable,
 'failed:AGENT_STALLED:true', 'failed as a stalled agent, retryable');
select ok((pg_temp.op('op0')).reservation_released_at is not null, 'its name reservation is released');
select is((select count(*)::integer from private.team_transfer_grants where operation_id=(pg_temp.v('op0')#>>'{}')::uuid and revoked_at is null),
 0, 'its tickets are revoked');
select is((select state from public.space_uploads where id=(pg_temp.v('out0')->>'uploadId')::uuid), 'expired',
 'its open output upload expires');
select is((select r.state from public.space_storage_reservations r join public.space_uploads u on u.reservation_id=r.id
  where u.id=(pg_temp.v('out0')->>'uploadId')::uuid), 'released', 'and gives back the space it reserved');
select is(private.space_catalog_variant_state(pg_temp.variant(0)), 'pending', 'the variation waits for its next attempt');
select is(pg_temp.read()->>'waitReason', 'AGENT_STALLED', 'the dialog is told Soty stopped answering');
select is(pg_temp.read()->'retry', '{"attempt":2,"of":3}'::jsonb, 'and which attempt comes next');
select is(pg_temp.read()->>'state', 'preparing', 'the creation is still preparing');
select is(private.sweep_space_catalog_variant_runs(interval '0 seconds'), 0, 'a closed run is not swept twice');

-- 3. The next attempt: the agent's claim takes it -----------------------------------------------
insert into seen select 'claim0', public.service_claim_space_catalog_variant(pg_temp.team(), pg_temp.owner(), pg_temp.lease(1), 120);
select is(pg_temp.v('claim0')->>'index'||':'||(pg_temp.v('claim0')->>'attempt'), '0:2', 'the background claim takes the swept variation for attempt 2');
select is(public.service_space_catalog_variant_run(pg_temp.team(), pg_temp.owner(), pg_temp.set1(), 1)->>'state', 'open',
 'the other variation is still the page''s to hand over');
insert into seen select 'op1', to_jsonb(pg_temp.page_run(1)::text);
select public.service_bind_space_catalog_variant_job(pg_temp.team(), pg_temp.owner(), (pg_temp.v('claim0')->>'jobId')::uuid,
  pg_temp.lease(1), 2, (select operation_id from public.service_start_team_operation(pg_temp.team(), pg_temp.owner(), 'process',
    'space-variant:05791120-0000-4000-8000-0000000000c0:2', 'request:space-variant:05791120-0000-4000-8000-0000000000c0:2',
    (pg_temp.v('source')->>'id')::uuid, pg_temp.root(), 'clip restitched 0 2.mp4', now()+interval '30 minutes', 400)));
insert into seen select 'op0b', to_jsonb((pg_temp.variant(0)).operation_id::text);
select public.service_transition_team_operation((pg_temp.v('op0b')#>>'{}')::uuid, 'running', 'awaiting_agent', 0, null, null, false);
select is(private.sweep_space_catalog_variant_runs(interval '0 seconds', interval '0 seconds'), 1,
 'a run held by a live lease is not swept, the page''s silent one is');
select is((pg_temp.op('op0b')).state, 'running', 'the leased run goes on');
select is((pg_temp.op('op1')).state, 'failed', 'the silent page run of the other variation is closed');

-- 4. A lapsed lease ----------------------------------------------------------------------------
update private.space_catalog_variants set lease_expires_at = now() - interval '1 minute' where set_id=pg_temp.set1() and ordinal=0;
select is(private.sweep_space_catalog_variant_runs(), 0, 'a lease lapsed a minute ago is still given its ten minutes');
select is(private.sweep_space_catalog_variant_runs(interval '2 hours', interval '0 seconds'), 1, 'past them, its run is swept');
select ok((pg_temp.variant(0)).job_id is null and (pg_temp.variant(0)).lease_expires_at is null, 'and the lapsed lease is cleared');

-- 5. The third silent run ----------------------------------------------------------------------
insert into seen select 'op0c', to_jsonb(pg_temp.page_run(0)::text);
select is((pg_temp.variant(0)).attempt, 3, 'the page hands over the third attempt');
select is(private.sweep_space_catalog_variant_runs(interval '0 seconds'), 1, 'which is swept as well');
select is(private.space_catalog_variant_state(pg_temp.variant(0)), 'failed', 'three silent runs leave the variation failed');
select is(pg_temp.read() - 'catalogIntentId' - 'videoSetId' - 'outcome' - 'requestedCount' - 'registeredCount',
 '{"state":"unknown","variantsFailed":true}'::jsonb, 'the dialog is told a variation used its attempts, not that it retries');

-- 6. Finished runs and the schedule ------------------------------------------------------------
select is((select count(*)::integer from public.team_operations o join private.space_catalog_variants v on v.operation_id=o.id
  where v.set_id=pg_temp.set1() and o.state in ('pending','running')), 0, 'no run of the set is left open');
select ok(exists (select 1 from cron.job where jobname='soty-space-catalog-variant-stalled-runs'
  and command='select private.sweep_space_catalog_variant_runs()' and schedule='*/5 * * * *'), 'the sweep runs every five minutes');

select * from finish();
rollback;
