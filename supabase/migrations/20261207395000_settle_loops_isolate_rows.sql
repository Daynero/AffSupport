-- The per-minute settlement and recovery loops added in 1.4.3 processed each
-- row in the caller's transaction. One row that cannot be written (an actor
-- that no longer resolves, a constraint, a state nobody foresaw) raised out of
-- the loop and rolled back the whole pass. The catalog updater calls the two
-- cancellation settlements before every regular round, so one such row stopped
-- every team's recovery and every scheduled round, every minute, forever:
-- exactly the stuck-forever class 1.4.3 removes.
--
-- Each row now runs in its own subtransaction. A row that raises is recorded
-- with a closed code and backed off (2 minutes, doubling, at most an hour), a
-- warning names the loop, the row and the code (never a payload: request
-- payloads carry secrets), and the loop continues with the next row. A row
-- that later passes clears its record. Locks, ordering and SKIP LOCKED are
-- unchanged.
--
-- Each function below is redefined in full from the body the earlier 1.4.3
-- migrations left; the redefinition refuses to run over any other body, so a
-- patch landed in between is never silently dropped.
begin;

create table private.settle_row_failures(
 scope text not null check(scope ~ '^[a-z][a-z0-9_]{1,63}$'),
 row_id uuid not null,
 attempts integer not null default 1 check(attempts>=1),
 last_code text not null check(last_code ~ '^[A-Z0-9][A-Z0-9_]{0,63}$'),
 retry_after timestamptz not null,
 first_failed_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 primary key(scope,row_id)
);
alter table private.settle_row_failures enable row level security;
alter table private.settle_row_failures force row level security;
revoke all on private.settle_row_failures from public,anon,authenticated,service_role;

-- Whether a loop must skip this row for now.
create function private.settle_row_deferred(p_scope text,p_row uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from private.settle_row_failures f where f.scope=p_scope and f.row_id=p_row and f.retry_after>clock_timestamp())
$$;
revoke all on function private.settle_row_deferred(text,uuid) from public,anon,authenticated,service_role;

-- Records a row that raised. Only a closed code is kept: a message that is not
-- one becomes its SQLSTATE, so no value from a payload is ever stored or logged.
create function private.note_settle_row_failure(p_scope text,p_row uuid,p_sqlstate text,p_message text) returns void language plpgsql security definer set search_path='' as $$
declare code text:=case when p_message ~ '^[A-Z][A-Z0-9_]{1,63}$' then p_message
  when p_sqlstate ~ '^[0-9A-Z]{5}$' then 'SQLSTATE_'||p_sqlstate else 'UNEXPECTED' end;
 tries integer;
begin
 insert into private.settle_row_failures as f(scope,row_id,attempts,last_code,retry_after)
 values(p_scope,p_row,1,code,clock_timestamp()+interval '2 minutes')
 on conflict(scope,row_id) do update set attempts=f.attempts+1,last_code=excluded.last_code,
  retry_after=clock_timestamp()+least(interval '1 hour',interval '2 minutes'*power(2,least(f.attempts,5))::integer),
  updated_at=clock_timestamp()
 returning attempts into tries;
 raise warning 'SETTLE_ROW_FAILED' using detail=p_scope||' '||p_row::text||' '||code||' attempt '||tries::text;
end $$;
revoke all on function private.note_settle_row_failure(text,uuid,text,text) from public,anon,authenticated,service_role;

create function private.clear_settle_row_failure(p_scope text,p_row uuid) returns void language sql security definer set search_path='' as $$
 delete from private.settle_row_failures where scope=p_scope and row_id=p_row
$$;
revoke all on function private.clear_settle_row_failure(text,uuid) from public,anon,authenticated,service_role;

do $base$
declare expected constant jsonb:=jsonb_build_object(
 'public.service_settle_catalog_video_cancellations(integer)','2a2a1c6900d327f6352e3b43dd23d819',
 'public.service_settle_launch_restitch_cancellations(integer)','6c1c2f4ac23877c99fac8aaf007ef79b',
 'public.service_sweep_catalog_updater_rounds(integer)','651a1c4d814c32aa92c8355727a9a467',
 'public.service_claim_uncertain_process_uploads(uuid,integer,uuid)','ebf8e2b301d14e511722734b649f1e95',
 'private.close_unreachable_catalog_rounds()','a4fba4260a27a59c3ee0ece6f5bf8e11');
 fn text;
begin
 for fn in select jsonb_object_keys(expected) loop
  if (select md5(prosrc) from pg_catalog.pg_proc where oid=fn::regprocedure) is distinct from expected->>fn then
   raise exception 'SETTLE_ISOLATION_BASE_CHANGED' using detail=fn;
  end if;
 end loop;
end $base$;

create or replace function public.service_settle_catalog_video_cancellations(p_limit integer default 3) returns jsonb language plpgsql security definer set search_path='' as $function$
declare idx integer;resolved integer:=0;active record;candidate record;s private.catalog_video_sets%rowtype;context private.launch_catalog_video_contexts%rowtype;g public.team_launch_generations%rowtype;n integer:=0;
begin
 if p_limit is null or p_limit not between 1 and 10 then raise exception 'INVALID_INPUT'using errcode='22023';end if;
 for candidate in select id,catalog_intent_id,update_attempt_id from private.catalog_video_sets where (state='cancel_requested'or(state='canceled'and exists(select 1 from private.launch_catalog_video_contexts original join public.team_launch_generations parent on parent.id=original.generation_id and parent.team_id=original.team_id and parent.actor_id=original.actor_id where original.video_set_id=catalog_video_sets.id and original.catalog_intent_id=catalog_video_sets.catalog_intent_id and original.team_id=catalog_video_sets.team_id and original.actor_id=catalog_video_sets.actor_id and parent.state in('cancel_requested','canceled_with_cleanup_pending'))))
  and not private.settle_row_deferred('catalog_video_cancel',catalog_video_sets.id) order by updated_at,id limit p_limit loop
  begin
  select *into context from private.launch_catalog_video_contexts where catalog_intent_id=candidate.catalog_intent_id and video_set_id=candidate.id;
  if context.generation_id is not null then
   perform 1 from public.team_launches where id=(select launch_id from public.team_launch_generations where id=context.generation_id)for update skip locked;if not found then continue;end if;
   select *into g from public.team_launch_generations where id=context.generation_id for update skip locked;if not found then continue;end if;
  end if;
  if candidate.catalog_intent_id is not null then perform 1 from private.catalog_generation_intents where id=candidate.catalog_intent_id for update skip locked;
  else perform 1 from public.team_catalog_update_attempts where attempt_id=candidate.update_attempt_id for update skip locked;end if;
  if not found then continue;end if;
  select *into s from private.catalog_video_sets where id=candidate.id and state in('cancel_requested','canceled')for update skip locked;if not found then continue;end if;
  if private.catalog_video_cancel_quiescent(s.id)is not true then
   -- Observation scheduling only: this timestamp is not physical progress.
   update private.catalog_video_sets set updated_at=clock_timestamp()where id=s.id and state='cancel_requested';
   continue;end if;
  update private.catalog_video_sets set state='canceled',revision=revision+1,updated_at=clock_timestamp()where id=s.id and state='cancel_requested';
  -- Existing cancellation trigger retains publication/cleanup fences, including unknown provider writes.
  if context.generation_id is not null and g.state in('cancel_requested','canceled_with_cleanup_pending')then
   update public.team_launch_generations set state='canceled',stage='canceled',lease_owner=null,lease_expires_at=clock_timestamp(),next_attempt_at=null,state_version=state_version+1,updated_at=clock_timestamp()where id=g.id;
   perform private.launch_signal(g.team_id,g.launch_id,(select aggregate_version from public.team_launches where id=g.launch_id));
  end if;
  perform private.clear_settle_row_failure('catalog_video_cancel',candidate.id);
  n:=n+1;
  exception when others then
   perform private.note_settle_row_failure('catalog_video_cancel',candidate.id,sqlstate,sqlerrm);
  end;
 end loop;
 for active in select silent.id from private.catalog_video_sets silent where silent.state in('accepted','preparing','unknown') and silent.update_attempt_id is null
  and not private.settle_row_deferred('catalog_video_silent_retry',silent.id)
  and exists(select 1 from private.catalog_video_variants v join public.team_operations o on o.team_id=silent.team_id and o.actor_id=silent.actor_id and o.kind='process' and o.idempotency_key='catalog-variant:'||v.request_id::text
   where v.video_set_id=silent.id and v.state in('working','unknown') and o.state in('pending','running') and o.result_material_id is null
   and not exists(select 1 from private.process_upload_ownership w where w.operation_id=o.id)
   and not exists(select 1 from private.team_operation_intents i where i.operation_id=o.id and i.provider_result_id is not null)
   and private.catalog_video_variant_last_life(silent.id,v.video_variant_index,o.id)<=clock_timestamp()-interval '15 minutes')
  order by silent.updated_at,silent.id limit p_limit loop
  begin
  perform 1 from private.catalog_video_sets where id=active.id for update skip locked;if not found then continue;end if;
  for idx in select video_variant_index from private.catalog_video_variants where video_set_id=active.id and state in('working','unknown') order by video_variant_index loop
   perform private.retry_failed_catalog_video_variant(active.id,idx);
  end loop;
  perform private.clear_settle_row_failure('catalog_video_silent_retry',active.id);
  resolved:=resolved+1;
  exception when others then
   perform private.note_settle_row_failure('catalog_video_silent_retry',active.id,sqlstate,sqlerrm);
  end;
 end loop;
 for active in select cleaned.id from private.catalog_video_sets cleaned where cleaned.state in('accepted','preparing','unknown')
  and not private.settle_row_deferred('catalog_video_cleaned_retry',cleaned.id)
  and exists(select 1 from private.catalog_video_variants v join public.team_operations o on o.team_id=cleaned.team_id and o.actor_id=cleaned.actor_id and o.kind='process' and o.idempotency_key='catalog-variant:'||v.request_id::text
   join private.process_upload_ownership w on w.operation_id=o.id
   where v.video_set_id=cleaned.id and v.state in('working','unknown') and v.output_material_id is null and o.state='failed' and o.result_material_id is null
   and w.upload_state<>'published' and (w.cleanup_state in('trashed','not_created','attention') or coalesce(o.finished_at,o.updated_at)<=clock_timestamp()-interval '24 hours'))
  order by cleaned.updated_at,cleaned.id limit p_limit loop
  begin
  perform 1 from private.catalog_video_sets where id=active.id for update skip locked;if not found then continue;end if;
  for idx in select video_variant_index from private.catalog_video_variants where video_set_id=active.id and state in('working','unknown') and output_material_id is null order by video_variant_index loop
   perform private.retry_failed_catalog_video_variant(active.id,idx);
  end loop;
  -- Observation scheduling only: a set whose failure is final keeps its answer
  -- but must not hold the head of this list every minute.
  update private.catalog_video_sets set updated_at=clock_timestamp() where id=active.id;
  perform private.clear_settle_row_failure('catalog_video_cleaned_retry',active.id);
  resolved:=resolved+1;
  exception when others then
   perform private.note_settle_row_failure('catalog_video_cleaned_retry',active.id,sqlstate,sqlerrm);
  end;
 end loop;
 return jsonb_build_object('settled',n,'resolved',resolved);
end $function$;

create or replace function public.service_settle_launch_restitch_cancellations(p_limit integer default 3) returns integer language plpgsql security definer set search_path='' as $function$
declare candidate record;g public.team_launch_generations%rowtype;l public.team_launches%rowtype;p private.launch_restitch_preparations%rowtype;op record;settled boolean;n integer:=0;
begin
 if p_limit is null or p_limit not between 1 and 10 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 for candidate in select x.id,x.launch_id from public.team_launch_generations x join private.launch_restitch_preparations prep on prep.generation_id=x.id
  where x.state in('cancel_requested','canceled_with_cleanup_pending')
   and (x.next_attempt_at is null or x.next_attempt_at<=clock_timestamp())
   and (x.lease_expires_at is null or x.lease_expires_at<=clock_timestamp())
   and not exists(select 1 from private.catalog_generation_intents i where i.team_id=x.team_id and i.request_key='launch:'||x.id::text||':catalog')
   and not private.settle_row_deferred('launch_restitch_cancel',x.id)
  order by x.updated_at,x.id limit p_limit
 loop
  begin
  select * into l from public.team_launches where id=candidate.launch_id for update skip locked;if not found then continue;end if;
  select * into g from public.team_launch_generations where id=candidate.id for update skip locked;
  if not found or g.state not in('cancel_requested','canceled_with_cleanup_pending')
   or g.next_attempt_at>clock_timestamp() or g.lease_expires_at>clock_timestamp() then continue;end if;
  select * into p from private.launch_restitch_preparations where generation_id=g.id for update;
  settled:=true;
  for op in select o.*,i.expected_size,i.provider_result_id,i.tool_id,i.launch_upload_phase from public.team_operations o
   left join private.team_operation_intents i on i.operation_id=o.id and i.team_id=g.team_id
   where o.team_id=g.team_id and (o.id=p.operation_id or o.idempotency_key=p.process_key or exists(
    select 1 from public.team_launch_generation_steps s where s.generation_id=g.id and s.team_operation_id=o.id))
   for update of o
  loop
   -- The restitch finished and its video is a registered material: retain it.
   if op.actor_id=g.actor_id and op.kind='process' and op.tool_id='restitch' and op.state='succeeded'
    and ((op.result_material_id is not null and exists(select 1 from public.team_materials m where m.id=op.result_material_id and m.team_id=g.team_id))
     or (op.provider_result_id is not null and exists(select 1 from public.team_materials m where m.team_id=g.team_id and m.drive_file_id=op.provider_result_id))) then
    if op.launch_upload_phase is distinct from 'retained' then
     update private.team_operation_intents set launch_upload_phase='retained',launch_upload_quiesced_at=coalesce(launch_upload_quiesced_at,clock_timestamp()),
      updated_at=clock_timestamp() where operation_id=op.id and team_id=g.team_id;
     update public.team_launch_generation_steps set checkpoint=coalesce(checkpoint,'{}'::jsonb)||'{"cleanupOutcome":"retained_catalog_material"}'::jsonb,
      updated_at=clock_timestamp() where generation_id=g.id and team_operation_id=op.id;
    end if;
    continue;
   end if;
   -- An upload nobody could prove or clean within a provider upload session's
   -- lifetime: stop waiting, touch nothing, keep the outcome on the step.
   if op.actor_id=g.actor_id and op.kind='process' and op.tool_id='restitch' and op.state in('failed','canceled')
    and op.launch_upload_phase='started' and op.provider_result_id is null and op.result_material_id is null
    and coalesce(op.finished_at,op.updated_at)<=clock_timestamp()-interval '7 days' then
    update public.team_launch_generation_steps set checkpoint=coalesce(checkpoint,'{}'::jsonb)||'{"cleanupOutcome":"provider_output_unverified"}'::jsonb,
     updated_at=clock_timestamp() where generation_id=g.id and team_operation_id=op.id
     and checkpoint->>'cleanupOutcome' is distinct from 'provider_output_unverified';
    continue;
   end if;
   if op.actor_id is distinct from g.actor_id or op.kind<>'process' or op.tool_id is distinct from 'restitch'
    or op.state not in('failed','canceled') or
    (op.expected_size is not null and op.launch_upload_phase is distinct from 'not_started'
      and op.launch_upload_phase is distinct from 'cleaned' and op.launch_upload_phase is distinct from 'retained')
    or (op.provider_result_id is not null and op.launch_upload_phase is distinct from 'cleaned' and op.launch_upload_phase is distinct from 'retained')
    or op.result_material_id is not null then settled:=false;end if;
  end loop;
  update public.team_launch_generations set state=case when settled then 'canceled' else 'canceled_with_cleanup_pending' end,
   stage=case when settled then 'cancel' else 'cleanup' end,safe_error_code=case when settled then null else 'LAUNCH_RESULT_UNCERTAIN' end,
   state_version=state_version+1,next_attempt_at=case when settled then null else clock_timestamp()+interval '5 minutes' end,
   lease_owner=null,lease_expires_at=null,updated_at=clock_timestamp() where id=g.id;
  if settled then update public.team_launch_generation_steps set state='canceled',updated_at=clock_timestamp() where generation_id=g.id and state in('pending','running');end if;
  perform private.launch_signal(g.team_id,g.launch_id,l.aggregate_version);
  perform private.clear_settle_row_failure('launch_restitch_cancel',candidate.id);
  n:=n+1;
  exception when others then
   perform private.note_settle_row_failure('launch_restitch_cancel',candidate.id,sqlstate,sqlerrm);
  end;
 end loop;
 return n;
end $function$;

create or replace function public.service_sweep_catalog_updater_rounds(p_limit integer default 10) returns jsonb language plpgsql security definer set search_path='' as $function$
declare r record;n integer;answer jsonb;variant_sets integer:=0;orphans integer:=0;released integer:=0;code text;changed integer;
begin
 if p_limit is null or p_limit not between 1 and 50 then raise exception 'INVALID_INPUT' using errcode='22023';end if;

 -- (2) Variant rounds whose children ended: resolve each stuck child.
 for r in
  select req.request_id,req.team_id,req.catalog_material_id,req.set_id,req.attempt_id
  from private.catalog_updater_variant_requests req
  join public.team_catalog_update_attempts a on a.attempt_id=req.attempt_id and a.team_id=req.team_id and a.result='running'
  join private.catalog_video_sets s on s.id=req.set_id and s.team_id=req.team_id and s.state in('accepted','preparing','unknown')
  where req.canceled_at is null
    and exists(select 1 from private.catalog_video_variants v where v.video_set_id=req.set_id and v.state in('working','unknown'))
    and not private.settle_row_deferred('catalog_round_variant_sweep',req.request_id)
  order by req.created_at limit p_limit
 loop
  begin
  code:=null;
  for n in select video_variant_index from private.catalog_video_variants where video_set_id=r.set_id and state in('working','unknown') order by video_variant_index loop
   answer:=private.retry_failed_catalog_video_variant(r.set_id,n);
   if answer->>'kind'='terminal' then code:=coalesce(code,answer->>'code');end if;
  end loop;
  if code is not null then
   -- A child that can no longer succeed: the round ends, the catalog is free.
   -- A publication already dispatched for this round keeps it open (the
   -- hold raises); the next pass tries again.
   begin
    perform private.cancel_catalog_updater_variant_round(r.team_id,r.catalog_material_id,r.request_id);
    update public.team_catalog_update_attempts set result='failed',failure_code=code,ended_at=coalesce(ended_at,clock_timestamp())
     where attempt_id=r.attempt_id and result in('running','cancelled');
   exception when others then null;
   end;
  end if;
  insert into public.team_catalog_events(team_id,material_id,event_kind) values(r.team_id,r.catalog_material_id,'sync_state');
  perform private.clear_settle_row_failure('catalog_round_variant_sweep',r.request_id);
  variant_sets:=variant_sets+1;
  exception when others then
   perform private.note_settle_row_failure('catalog_round_variant_sweep',r.request_id,sqlstate,sqlerrm);
  end;
 end loop;

 -- (3a) Attempts whose round the item no longer owns can never progress.
 with lost as (
  select a.attempt_id from public.team_catalog_update_attempts a
  where a.result='running' and a.started_at<clock_timestamp()-interval '6 hours'
    and not exists(select 1 from public.team_catalog_updater_items i
      where i.catalog_material_id=a.catalog_material_id and i.team_id=a.team_id and i.round_due_at=a.round_due_at)
    and not exists(select 1 from private.catalog_updater_variant_requests req where req.attempt_id=a.attempt_id and req.canceled_at is null)
  order by a.started_at limit p_limit for update of a skip locked
 )
 update public.team_catalog_update_attempts a set result='cancelled',ended_at=clock_timestamp()
  from lost where a.attempt_id=lost.attempt_id;
 get diagnostics changed=row_count;orphans:=orphans+changed;

 -- (3b) A round the item owns but nobody has claimed for six hours.
 with idle as (
  select i.catalog_material_id,i.team_id,i.round_due_at from public.team_catalog_updater_items i
  where i.round_due_at is not null and not i.reconciliation_required
    and i.tariff_pause_id is null and i.next_attempt_at<clock_timestamp()-interval '6 hours'
    and (i.lease_owner is null or (i.lease_expires_at is not null and i.lease_expires_at<=clock_timestamp()))
    and exists(select 1 from public.team_catalog_update_attempts a where a.catalog_material_id=i.catalog_material_id and a.team_id=i.team_id
      and a.round_due_at=i.round_due_at and a.result='running' and coalesce(jsonb_array_length(a.stage_history),0)=0)
    and not exists(select 1 from private.catalog_updater_variant_requests req
      join public.team_catalog_update_attempts a on a.attempt_id=req.attempt_id
      where a.catalog_material_id=i.catalog_material_id and a.round_due_at=i.round_due_at and req.canceled_at is null)
    and not exists(select 1 from private.catalog_update_reconciliations rec where rec.catalog_material_id=i.catalog_material_id)
  order by i.next_attempt_at limit p_limit for update of i skip locked
 ), closed as (
  update public.team_catalog_update_attempts a set result='failed',failure_code='PROCESS_FAILED',ended_at=clock_timestamp()
  from idle where a.catalog_material_id=idle.catalog_material_id and a.team_id=idle.team_id and a.round_due_at=idle.round_due_at and a.result='running'
  returning a.catalog_material_id
 )
 update public.team_catalog_updater_items i set round_due_at=null,attempts=0,lease_owner=null,lease_expires_at=null,next_attempt_at=clock_timestamp()
  from idle where i.catalog_material_id=idle.catalog_material_id and i.team_id=idle.team_id and i.round_due_at=idle.round_due_at;
 get diagnostics changed=row_count;orphans:=orphans+changed;

 -- (4) Quarantined for review with nothing to reconcile and nothing running.
 with stranded as (
  select i.catalog_material_id,i.team_id from public.team_catalog_updater_items i
  where i.reconciliation_required
    and (i.lease_owner is null or (i.lease_expires_at is not null and i.lease_expires_at<=clock_timestamp()))
    and not exists(select 1 from private.catalog_update_reconciliations rec where rec.catalog_material_id=i.catalog_material_id)
    and not exists(select 1 from public.team_catalog_update_attempts a where a.catalog_material_id=i.catalog_material_id and a.team_id=i.team_id and a.result in('running','unknown'))
  limit p_limit for update of i skip locked
 ), freed as (
  update public.team_catalog_updater_items i set reconciliation_required=false,round_due_at=null,attempts=0,lease_owner=null,lease_expires_at=null,next_attempt_at=clock_timestamp()
  from stranded where i.catalog_material_id=stranded.catalog_material_id and i.team_id=stranded.team_id
  returning i.catalog_material_id,i.team_id
 ), cleared as (
  update public.team_product_catalogs c set last_update_error=null,last_update_error_at=null
  from freed where c.material_id=freed.catalog_material_id and c.last_update_error='CATALOG_ATTEMPT_STATE_INCONSISTENT'
  returning c.material_id
 )
 select count(*) into released from freed;

 return jsonb_build_object('variantSets',variant_sets,'orphans',orphans,'released',released);
end $function$;

create or replace function public.service_claim_uncertain_process_uploads(p_owner uuid,p_limit integer default 3,p_operation uuid default null) returns jsonb language plpgsql security definer set search_path='' as $function$
declare candidate record;o public.team_operations%rowtype;u private.process_upload_ownership%rowtype;plans jsonb:='[]';
begin
 if p_owner is null or p_limit is null or p_limit not between 1 and 3 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 for candidate in
  select q.operation_id,variant.set_id,variant.variant_index from private.process_upload_ownership q
   join public.team_operations op on op.id=q.operation_id
   cross join lateral private.catalog_variant_of_operation(q.operation_id) variant
  where (p_operation is null or q.operation_id=p_operation)
   and op.kind='process' and op.state in('pending','running') and q.cleanup_state='not_needed' and q.upload_state in('prepared','started')
   and not private.settle_row_deferred('uncertain_process_upload',q.operation_id)
  order by q.reconcile_requested_at nulls last,q.updated_at,q.operation_id limit 20
 loop
  exit when jsonb_array_length(plans)>=p_limit;
  begin
  -- Lock order of every ownership path: the set, the operation, the ownership.
  perform 1 from private.catalog_video_sets where id=candidate.set_id for update skip locked;
  if not found then continue;end if;
  select * into o from public.team_operations where id=candidate.operation_id for update skip locked;
  if not found then continue;end if;
  select * into u from private.process_upload_ownership where operation_id=o.id for update skip locked;
  if not found or not private.uncertain_process_upload_due(o,u,candidate.set_id,candidate.variant_index) then continue;end if;
  if u.upload_state='prepared' then
   -- The provider was never asked: no file can exist. The fence records not_created.
   perform private.fail_uncertain_process_upload(o.id);
   perform private.retry_failed_catalog_video_variant(candidate.set_id,candidate.variant_index);
   perform private.clear_settle_row_failure('uncertain_process_upload',candidate.operation_id);
   continue;
  end if;
  update private.team_transfer_grants set revoked_at=coalesce(revoked_at,clock_timestamp()) where operation_id=o.id and purpose='finalize';
  update private.process_upload_ownership set reconcile_attempts=least(8,reconcile_attempts+1),fence=fence+1,lease_owner=p_owner,
   lease_expires_at=clock_timestamp()+interval '90 seconds',updated_at=clock_timestamp() where operation_id=o.id returning * into u;
  perform private.clear_settle_row_failure('uncertain_process_upload',candidate.operation_id);
  -- Last statement of the row: a plan is only ever added for a row that held.
  plans:=plans||jsonb_build_array(private.process_upload_binding(u)||jsonb_build_object('fence',u.fence::text,'actorId',o.actor_id,
   'setId',candidate.set_id,'variantIndex',candidate.variant_index,'attempt',u.reconcile_attempts));
  exception when others then
   perform private.note_settle_row_failure('uncertain_process_upload',candidate.operation_id,sqlstate,sqlerrm);
  end;
 end loop;
 return plans;
end $function$;

create or replace function private.close_unreachable_catalog_rounds() returns integer language plpgsql security definer set search_path='' as $function$
declare closed integer:=0; stuck record; code text;
begin
 for stuck in
  select item.catalog_material_id, item.team_id, item.round_due_at, connection.state
  from public.team_catalog_updater_items item
  join public.team_materials sheet on sheet.id=item.catalog_material_id and sheet.team_id=item.team_id
  join public.team_drive_connections connection
    on connection.id=sheet.connection_id and connection.team_id=sheet.team_id
  where item.round_due_at is not null
    and item.tariff_pause_id is null
    and not item.reconciliation_required
    and connection.state not in('connected','unavailable')
    and not exists(select 1 from private.catalog_update_reconciliations pending
      where pending.catalog_material_id=item.catalog_material_id)
    and (item.lease_owner is null or item.lease_expires_at is null
      or item.lease_expires_at<=clock_timestamp())
    and not private.settle_row_deferred('catalog_unreachable_round',item.catalog_material_id)
  for update of item skip locked
 loop
  begin
  code:=case stuck.state when 'root_missing' then 'ROOT_MISSING'
                         when 'pending' then 'DRIVE_UNAVAILABLE'
                         else 'NEEDS_REAUTH' end;
  update public.team_catalog_update_attempts
     set result='failed', failure_code=code, ended_at=clock_timestamp()
   where catalog_material_id=stuck.catalog_material_id and round_due_at=stuck.round_due_at
     and result in('running','unknown');
  update public.team_product_catalogs
     set last_update_error=code, last_update_error_at=clock_timestamp()
   where material_id=stuck.catalog_material_id;
  update public.team_catalog_updater_items
     set round_due_at=null, attempts=0, lease_owner=null, lease_expires_at=null,
         next_attempt_at=clock_timestamp()
   where catalog_material_id=stuck.catalog_material_id;
  insert into public.team_catalog_events(team_id,material_id,event_kind)
  values(stuck.team_id,stuck.catalog_material_id,'upserted');
  perform private.sync_catalog_updater(stuck.team_id);
  perform private.clear_settle_row_failure('catalog_unreachable_round',stuck.catalog_material_id);
  closed:=closed+1;
  exception when others then
   perform private.note_settle_row_failure('catalog_unreachable_round',stuck.catalog_material_id,sqlstate,sqlerrm);
  end;
 end loop;
 return closed;
end $function$;

-- A set that closes as canceled kept a variant 'working' with no operation
-- (beta 2026-11-11, set 95a121a2): nothing can run it any more, yet progress
-- views counted it as work in progress. Variants have no canceled state; a
-- variant that never got an operation returns to 'queued', which nothing
-- admits for a canceled set. Every path to 'canceled' goes through this
-- trigger; sets already canceled are repaired once below.
create function private.catalog_video_set_canceled_closes_variants() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update private.catalog_video_variants set state='queued',heartbeat_at=null,silence_observed_at=null
  where video_set_id=new.id and state='working' and operation_id is null and output_material_id is null;
 return null;
end $$;
revoke all on function private.catalog_video_set_canceled_closes_variants() from public,anon,authenticated,service_role;
create trigger catalog_video_set_canceled_closes_variants after update of state on private.catalog_video_sets
 for each row when (new.state='canceled' and old.state is distinct from 'canceled')
 execute function private.catalog_video_set_canceled_closes_variants();

update private.catalog_video_variants v set state='queued',heartbeat_at=null,silence_observed_at=null
 from private.catalog_video_sets s
 where s.id=v.video_set_id and s.state='canceled' and v.state='working' and v.operation_id is null and v.output_material_id is null;

commit;
