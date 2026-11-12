-- Production after 20261207399995 (2026-11-12) still held five catalog video sets in 'unknown'
-- since 2026-11-10/11 (d1da2bc7, d9582efd, a02a6442, 373c1a58, 53a1aede). Each was created
-- from the explorer, and one of its variants failed for good: PERMISSION_DENIED or
-- SOURCE_CHANGED, codes `private.retry_failed_catalog_video_variant` answers 'terminal' for.
-- The creation that drove the set saw that answer and stopped; the set itself was never
-- asked to cancel, so it stayed 'unknown' with queued siblings nothing will ever run.
--
-- `private.settle_catalog_stuck_shapes` only replayed variants whose output was gone. It
-- now also takes a variant whose run failed, when neither the run nor the set has moved for
-- twelve hours and no variant of the set has a live heartbeat, and only when the failure is
-- one the retry would refuse anyway: the pass never requeues work somebody abandoned. The
-- terminal answer is handled exactly as for a missing output: an open update round is
-- canceled and failed, otherwise the set is asked to cancel, and the cancellation pass
-- settles it once its executor is quiescent.

do $settle$
declare d text;
begin
 select pg_get_functiondef('private.settle_catalog_stuck_shapes(integer)'::regprocedure) into d;
 if strpos(d,$find$declare r record;answer jsonb;retried integer:=0;closed_rounds integer:=0;blocked integer:=0;round_request uuid;$find$)=0
  or strpos(d,$find$ return jsonb_build_object('retried',retried,'blocked',blocked,'closedRounds',closed_rounds);$find$)=0
 then raise exception 'FAILED_IDLE_SET_PATCH_MISSING';end if;
 d:=replace(d,$find$declare r record;answer jsonb;retried integer:=0;closed_rounds integer:=0;blocked integer:=0;round_request uuid;$find$,
  $replace$declare r record;answer jsonb;retried integer:=0;closed_rounds integer:=0;blocked integer:=0;round_request uuid;failed_sets integer:=0;$replace$);
 d:=replace(d,$find$ return jsonb_build_object('retried',retried,'blocked',blocked,'closedRounds',closed_rounds);$find$,
  $replace$ -- (4) Variants whose run failed for good while nothing drives their set any more.
 for r in
  select v.video_set_id,v.video_variant_index,s.team_id,s.catalog_material_id
  from private.catalog_video_variants v
  join private.catalog_video_sets s on s.id=v.video_set_id and s.state in('accepted','preparing','unknown')
  join public.team_operations o on o.team_id=s.team_id and o.actor_id=s.actor_id and o.kind='process' and o.idempotency_key='catalog-variant:'||v.request_id::text
  where v.state in('working','unknown') and v.output_material_id is null and o.state='failed' and o.result_material_id is null
    -- Only what the retry refuses: requeueing abandoned work would start it on somebody's computer.
    and (v.retry_count>=2 or o.error_code is null or o.error_code like 'STITCH_PLAN_%' or o.error_code in('SOURCE_CHANGED','PERMISSION_DENIED','RESTITCH_SOURCE_FORBIDDEN','UNSUPPORTED_MEDIA','TOO_LARGE','RESTITCH_INVALID','RESTITCH_NO_SCREENS','RESTITCH_SCREEN_CANDIDATES_EXHAUSTED','RESTITCH_SCREEN_SELECTION_LIMIT','STITCH_PATH_INVALID'))
    and coalesce(o.finished_at,o.updated_at)<=clock_timestamp()-interval '12 hours'
    and s.updated_at<=clock_timestamp()-interval '12 hours'
    and not exists(select 1 from private.catalog_video_variants live where live.video_set_id=s.id
      and coalesce(live.heartbeat_at,'-infinity'::timestamptz)>clock_timestamp()-interval '15 minutes')
    and not private.settle_row_deferred('catalog_variant_failed_idle',v.video_set_id)
  order by v.video_set_id,v.video_variant_index limit p_limit
 loop
  begin
   answer:=private.retry_failed_catalog_video_variant(r.video_set_id,r.video_variant_index);
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
    failed_sets:=failed_sets+1;
   end if;
   perform private.clear_settle_row_failure('catalog_variant_failed_idle',r.video_set_id);
  exception when others then
   perform private.note_settle_row_failure('catalog_variant_failed_idle',r.video_set_id,sqlstate,sqlerrm);
  end;
 end loop;

 return jsonb_build_object('retried',retried,'blocked',blocked,'closedRounds',closed_rounds,'failedSets',failed_sets);$replace$);
 execute d;
end $settle$;

-- Settle what production already holds; the cancellation pass finishes them.
select private.settle_catalog_stuck_shapes(100);
