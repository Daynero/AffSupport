-- 1.4.3 on production left three shapes that nothing could ever settle, and one of them
-- kept the per-minute catalog updater awake with nothing to do:
--
--  * fa708f8e: a canceled set whose variant ran under a paired native session. Its
--    operation failed, but the selection executor stayed 'owned' with an open claim, and
--    the session that could acknowledge quiescence expired a day earlier. "A terminal
--    operation is not proof that an enrolled native executor stopped" held it for good.
--  * 52c28131: a variant whose run succeeded, but whose output was never registered and
--    then went missing in Drive. The replay of the confirmation needs an active file, so
--    the variant answered 'unknown' forever, and so did its set and its update round.
--  * A publication job that sat in retry_wait for forty hours. The per-minute starter
--    counted it as due although the scheduler's claim never picks it up.
--
-- What changes:
--  * An executor whose operation ended at least 15 minutes ago, with no native control and
--    no foreground authority still valid for it, is quiesced on its behalf. Its open claims
--    close with the operation's outcome, and the release is recorded.
--  * An output that is gone (missing or trashed, never registered) counts as a run with no
--    output: the variant is retried within the same budget, and a cancellation may settle.
--  * The due checks ask exactly what the publication claim asks; a job that is still not
--    dispatched a day after it was due is closed as blocked with a closed reason.
--  * A minute-independent pass every ten minutes settles these shapes, and the stalled
--    variant rounds they leave behind, one row at a time.
begin;

-- --- executors whose native session can no longer answer -------------------------
create table private.restitch_released_executor_claims(
 root_operation_id uuid not null,
 claim_id uuid not null,
 native_instance_id uuid,
 executor_id uuid,
 epoch bigint,
 operation_state text not null check(operation_state in('succeeded','failed','canceled')),
 reason text not null check(reason in('native_session_expired')),
 released_at timestamptz not null default clock_timestamp(),
 primary key(root_operation_id,claim_id)
);
alter table private.restitch_released_executor_claims enable row level security;
alter table private.restitch_released_executor_claims force row level security;
revoke all on private.restitch_released_executor_claims from public,anon,authenticated,service_role;

-- Quiesces an enrolled executor that can no longer do it itself. Only after the operation
-- has been terminal for 15 minutes, and only while no native control and no foreground
-- authority that could still acknowledge it is valid: a live session keeps the guard.
create function private.release_silent_restitch_executor(p_root uuid) returns boolean
language plpgsql security definer set search_path='' as $fn$
declare o public.team_operations%rowtype;e private.restitch_selection_executors%rowtype;outcome text;
begin
 select * into o from public.team_operations where id=p_root;
 if o.id is null or o.state not in('succeeded','failed','canceled')
  or coalesce(o.finished_at,o.updated_at)>clock_timestamp()-interval '15 minutes' then return false;end if;
 if not exists(select 1 from private.restitch_process_aliases where root_operation_id=p_root) then return false;end if;
 if exists(select 1 from private.restitch_native_controls control where control.root_operation_id=p_root and control.expires_at>clock_timestamp()) then return false;end if;
 if exists(select 1 from private.restitch_process_aliases alias
   join private.catalog_video_foreground_authorities authority on authority.video_set_id=alias.video_set_id
   where alias.root_operation_id=p_root and authority.expires_at>clock_timestamp() and authority.unused_at is null
     and coalesce(authority.execution_native_instance_id,authority.native_instance_id)=alias.native_instance_id) then return false;end if;
 select * into e from private.restitch_selection_executors where root_operation_id=p_root for update;
 if e.root_operation_id is null then return false;end if;
 if e.state='quiescent' and not exists(select 1 from private.restitch_selection_executor_claims c
   where c.root_operation_id=p_root and (c.quiescence_id is null or c.terminal_outcome is null)) then return false;end if;
 -- A transfer still being accounted could be lost: never release over it.
 if exists(select 1 from private.restitch_selection_slots slot cross join lateral jsonb_array_elements(slot.budget->'transfers') transfer
   where slot.root_operation_id=p_root and (transfer->'settlement' is null or transfer->'settlement'='null'::jsonb)) then return false;end if;
 outcome:=case o.state when 'succeeded' then 'delivered' when 'canceled' then 'canceled' else 'failed' end;
 insert into private.restitch_released_executor_claims(root_operation_id,claim_id,native_instance_id,executor_id,epoch,operation_state,reason)
  select c.root_operation_id,c.claim_id,c.native_instance_id,c.executor_id,c.epoch,o.state,'native_session_expired'
  from private.restitch_selection_executor_claims c
  where c.root_operation_id=p_root and (c.quiescence_id is null or c.terminal_outcome is null)
  on conflict do nothing;
 update private.restitch_selection_executor_claims set quiescence_id=coalesce(quiescence_id,gen_random_uuid()),terminal_outcome=coalesce(terminal_outcome,outcome)
  where root_operation_id=p_root and (quiescence_id is null or terminal_outcome is null);
 update private.restitch_selection_executors set state='quiescent',executor_id=null where root_operation_id=p_root and state<>'quiescent';
 return true;
end $fn$;
revoke all on function private.release_silent_restitch_executor(uuid) from public,anon,authenticated,service_role;

-- --- outputs that are gone --------------------------------------------------------
-- A succeeded run whose output can never be registered: no result at all, or a result
-- that is no longer an active file.
create function private.catalog_variant_output_gone(p_operation uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.team_operations o where o.id=p_operation and o.state='succeeded'
  and not exists(select 1 from public.team_materials m where m.id=o.result_material_id and m.lifecycle='active'))
$$;
revoke all on function private.catalog_variant_output_gone(uuid) from public,anon,authenticated,service_role;

do $quiescent$
declare d text;
begin
 select pg_get_functiondef('private.catalog_video_cancel_quiescent(uuid)'::regprocedure) into d;
 if strpos(d,$find$ or o.result_material_id is not null then return false;end if;$find$)=0
  or strpos(d,$find$ or i.provider_result_id is not null or not private.process_upload_settled(o.id)then return false;end if;$find$)=0
  or strpos(d,$find$  elsif o.state not in('failed','canceled')then return false;end if;$find$)=0
  or strpos(d,$find$  -- A terminal operation is not proof that an enrolled native executor stopped.$find$)=0
 then raise exception 'STUCK_SHAPES_QUIESCENT_PATCH_MISSING';end if;
 d:=replace(d,$find$ or o.result_material_id is not null then return false;end if;$find$,
  $replace$ or (o.result_material_id is not null and not private.catalog_variant_output_gone(o.id)) then return false;end if;$replace$);
 d:=replace(d,$find$ or i.provider_result_id is not null or not private.process_upload_settled(o.id)then return false;end if;$find$,
  $replace$ or (i.provider_result_id is not null and not private.catalog_variant_output_gone(o.id)) or not private.process_upload_settled(o.id)then return false;end if;$replace$);
 d:=replace(d,$find$  elsif o.state not in('failed','canceled')then return false;end if;$find$,
  $replace$  elsif o.state not in('failed','canceled') and not private.catalog_variant_output_gone(o.id) then return false;end if;$replace$);
 d:=replace(d,$find$  -- A terminal operation is not proof that an enrolled native executor stopped.$find$,
  $replace$  -- An executor whose native session expired can no longer acknowledge: quiesce it.
  perform private.release_silent_restitch_executor(o.id);
  -- A terminal operation is not proof that an enrolled native executor stopped.$replace$);
 execute d;
end $quiescent$;

do $retry$
declare d text;
begin
 select pg_get_functiondef('private.retry_failed_catalog_video_variant(uuid,integer)'::regprocedure) into d;
 if strpos(d,$find$  if o.result_material_id is null or not exists(select 1 from public.team_materials m where m.id=o.result_material_id and m.team_id=s.team_id and m.lifecycle='active') then return jsonb_build_object('kind','unknown');end if;$find$)=0
 then raise exception 'STUCK_SHAPES_RETRY_PATCH_MISSING';end if;
 d:=replace(d,$find$  if o.result_material_id is null or not exists(select 1 from public.team_materials m where m.id=o.result_material_id and m.team_id=s.team_id and m.lifecycle='active') then return jsonb_build_object('kind','unknown');end if;$find$,
  $replace$  if o.result_material_id is null or not exists(select 1 from public.team_materials m where m.id=o.result_material_id and m.team_id=s.team_id and m.lifecycle='active') then
   -- The run made an output that was never registered and is gone now: retry it like a
   -- run that failed with no output, within the same budget.
   if not private.catalog_variant_output_gone(o.id) or coalesce(o.finished_at,o.updated_at)>clock_timestamp()-interval '15 minutes' then return jsonb_build_object('kind','unknown');end if;
   if v.retry_count>=2 then return jsonb_build_object('kind','terminal','attempt',v.retry_count,'code','PROCESS_OUTPUT_MISSING');end if;
   fresh:=gen_random_uuid();
   insert into private.catalog_video_variant_attempts(video_set_id,video_variant_index,attempt,team_id,request_id,operation_id,failure_code) values(p_set,p_index,v.retry_count,s.team_id,v.request_id,o.id,'PROCESS_OUTPUT_MISSING');
   delete from private.catalog_video_grant_rounds where video_set_id=p_set and video_variant_index=p_index;
   update private.catalog_video_variants set original_request_id=coalesce(original_request_id,request_id),request_id=fresh,operation_id=null,state='queued',dispatch_credential_hash=null,dispatch_native_instance_id=null,grant_refreshes=0,retry_count=retry_count+1 where video_set_id=p_set and video_variant_index=p_index;
   update private.catalog_video_sets set revision=revision+1,state=case when exists(select 1 from private.catalog_video_variants where video_set_id=p_set and state='unknown') then 'unknown' else 'preparing' end,updated_at=clock_timestamp() where id=p_set;
   return jsonb_build_object('kind','retry','requestId',fresh,'attempt',v.retry_count+1);
  end if;$replace$);
 execute d;
end $retry$;

-- --- the due checks ask what the publication claim asks ---------------------------
do $due$
declare d text;
begin
 select pg_get_functiondef('private.launch_catalog_recovery_due()'::regprocedure) into d;
 if strpos(d,$find$or exists(select 1 from private.catalog_video_publication_jobs original where original.state in('applying','verifying','unknown')and original.writer_fence is not null and original.dispatched_at is not null and original.next_attempt_at<=statement_timestamp()and(original.lease_until is null or original.lease_until<=statement_timestamp()))$find$)=0
  or strpos(d,$find$or exists(select 1 from private.catalog_video_publication_jobs j join private.catalog_video_publication_policies p on p.catalog_material_id=j.catalog_material_id and p.revision=j.revision where j.state in('waiting','preparing','retry_wait')and j.dispatched_at is null and j.writer_fence is null and p.mode<>'held'and not p.legacy_delivery_unverified and not exists(select 1 from private.catalog_publication_cell_writes w where w.job_id=j.id))$find$)=0
 then raise exception 'STUCK_SHAPES_RECOVERY_DUE_PATCH_MISSING';end if;
 d:=replace(d,$find$or exists(select 1 from private.catalog_video_publication_jobs original where original.state in('applying','verifying','unknown')and original.writer_fence is not null and original.dispatched_at is not null and original.next_attempt_at<=statement_timestamp()and(original.lease_until is null or original.lease_until<=statement_timestamp()))$find$,
  $replace$or private.catalog_publication_work_due(false)$replace$);
 d:=replace(d,$find$or exists(select 1 from private.catalog_video_publication_jobs j join private.catalog_video_publication_policies p on p.catalog_material_id=j.catalog_material_id and p.revision=j.revision where j.state in('waiting','preparing','retry_wait')and j.dispatched_at is null and j.writer_fence is null and p.mode<>'held'and not p.legacy_delivery_unverified and not exists(select 1 from private.catalog_publication_cell_writes w where w.job_id=j.id))$find$,
  '');
 execute d;

 select pg_get_functiondef('private.launch_catalog_recovery_due_before_variant_rounds()'::regprocedure) into d;
 if strpos(d,$find$ and (p.mode='immediate' or p.due_at<=statement_timestamp()) and private.can(j.team_id,'view',j.actor_id)$find$)=0
 then raise exception 'STUCK_SHAPES_VARIANT_ROUNDS_DUE_PATCH_MISSING';end if;
 d:=replace(d,$find$ and (p.mode='immediate' or p.due_at<=statement_timestamp()) and private.can(j.team_id,'view',j.actor_id)$find$,
  $replace$ and (p.mode='immediate' or p.due_at<=statement_timestamp()) and j.next_attempt_at<=statement_timestamp() and (j.lease_until is null or j.lease_until<=statement_timestamp()) and private.catalog_connection_usable(j.catalog_material_id) and private.can(j.team_id,'view',j.actor_id)$replace$);
 execute d;
end $due$;

-- --- the pass that settles them ----------------------------------------------------
create function private.settle_catalog_stuck_shapes(p_limit integer default 20) returns jsonb
language plpgsql security definer set search_path='' as $fn$
declare r record;answer jsonb;retried integer:=0;closed_rounds integer:=0;blocked integer:=0;round_request uuid;
begin
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'INVALID_INPUT' using errcode='22023';end if;

 -- (1) Variants whose run succeeded but whose output is gone.
 for r in
  select v.video_set_id,v.video_variant_index,s.team_id,s.catalog_material_id
  from private.catalog_video_variants v
  join private.catalog_video_sets s on s.id=v.video_set_id and s.state in('accepted','preparing','unknown')
  join public.team_operations o on o.team_id=s.team_id and o.actor_id=s.actor_id and o.kind='process' and o.idempotency_key='catalog-variant:'||v.request_id::text
  where v.state in('working','unknown') and v.output_material_id is null
    and private.catalog_variant_output_gone(o.id) and coalesce(o.finished_at,o.updated_at)<=clock_timestamp()-interval '15 minutes'
    and not private.settle_row_deferred('catalog_variant_output_missing',v.video_set_id)
  order by v.video_set_id,v.video_variant_index limit p_limit
 loop
  begin
   answer:=private.retry_failed_catalog_video_variant(r.video_set_id,r.video_variant_index);
   if answer->>'kind'='retry' then retried:=retried+1;end if;
   if answer->>'kind'='terminal' then
    round_request:=null;
    select req.request_id into round_request from private.catalog_updater_variant_requests req
     join public.team_catalog_update_attempts a on a.attempt_id=req.attempt_id and a.result='running'
     where req.set_id=r.video_set_id and req.canceled_at is null limit 1;
    if round_request is not null then
     perform private.cancel_catalog_updater_variant_round(r.team_id,r.catalog_material_id,round_request);
     update public.team_catalog_update_attempts set result='failed',failure_code=answer->>'code',ended_at=coalesce(ended_at,clock_timestamp())
      where attempt_id=(select attempt_id from private.catalog_updater_variant_requests where request_id=round_request) and result in('running','cancelled');
    else
     update private.catalog_video_sets set state='cancel_requested',revision=revision+1,updated_at=clock_timestamp()
      where id=r.video_set_id and state in('accepted','preparing','unknown');
    end if;
   end if;
   perform private.clear_settle_row_failure('catalog_variant_output_missing',r.video_set_id);
  exception when others then
   perform private.note_settle_row_failure('catalog_variant_output_missing',r.video_set_id,sqlstate,sqlerrm);
  end;
 end loop;

 -- (2) Publication jobs still not dispatched a day after they were due.
 for r in
  select j.id,j.catalog_material_id
  from private.catalog_video_publication_jobs j
  join private.catalog_video_publication_policies p on p.catalog_material_id=j.catalog_material_id and p.revision=j.revision
  where j.state in('waiting','preparing','retry_wait') and j.dispatched_at is null and j.writer_fence is null
    and (p.mode='immediate' or (p.mode='scheduled' and p.due_at<=clock_timestamp()))
    and greatest(coalesce(p.due_at,j.created_at),j.created_at)<clock_timestamp()-interval '24 hours'
    and (j.lease_until is null or j.lease_until<=clock_timestamp())
    and not exists(select 1 from private.catalog_publication_cell_writes w where w.job_id=j.id)
    and not private.settle_row_deferred('catalog_publication_stale',j.id)
  order by j.created_at limit p_limit
 loop
  begin
   update private.catalog_video_publication_jobs
    set state='blocked',
     blocked_reason=case when private.catalog_connection_usable(r.catalog_material_id) then 'stale_job' else 'target_unavailable' end,
     worker_id=null,lease_until=null
    where id=r.id and state in('waiting','preparing','retry_wait') and dispatched_at is null;
   if found then blocked:=blocked+1;end if;
   perform private.clear_settle_row_failure('catalog_publication_stale',r.id);
  exception when others then
   perform private.note_settle_row_failure('catalog_publication_stale',r.id,sqlstate,sqlerrm);
  end;
 end loop;

 -- (3) Variant rounds open for a day whose set has not moved for twelve hours.
 for r in
  select req.request_id,req.team_id,req.catalog_material_id,req.attempt_id
  from private.catalog_updater_variant_requests req
  join public.team_catalog_update_attempts a on a.attempt_id=req.attempt_id and a.team_id=req.team_id and a.result='running'
  join private.catalog_video_sets s on s.id=req.set_id and s.state in('accepted','preparing','unknown')
  where req.canceled_at is null
    and a.started_at<clock_timestamp()-interval '24 hours'
    and s.updated_at<clock_timestamp()-interval '12 hours'
    and not exists(select 1 from private.catalog_video_variants live where live.video_set_id=s.id
      and coalesce(live.heartbeat_at,'-infinity'::timestamptz)>clock_timestamp()-interval '15 minutes')
    and not private.settle_row_deferred('catalog_round_stalled',req.request_id)
  order by a.started_at limit p_limit
 loop
  begin
   perform private.cancel_catalog_updater_variant_round(r.team_id,r.catalog_material_id,r.request_id);
   update public.team_catalog_update_attempts set result='failed',failure_code='PROCESS_RESULT_UNCERTAIN',ended_at=coalesce(ended_at,clock_timestamp())
    where attempt_id=r.attempt_id and result in('running','cancelled');
   closed_rounds:=closed_rounds+1;
   perform private.clear_settle_row_failure('catalog_round_stalled',r.request_id);
  exception when others then
   perform private.note_settle_row_failure('catalog_round_stalled',r.request_id,sqlstate,sqlerrm);
  end;
 end loop;

 return jsonb_build_object('retried',retried,'blocked',blocked,'closedRounds',closed_rounds);
end $fn$;
revoke all on function private.settle_catalog_stuck_shapes(integer) from public,anon,authenticated,service_role;

select cron.schedule('soty-catalog-stuck-shapes','*/10 * * * *',$cron$select private.settle_catalog_stuck_shapes()$cron$);

-- Settle what production already holds.
select private.settle_catalog_stuck_shapes(100);

commit;
