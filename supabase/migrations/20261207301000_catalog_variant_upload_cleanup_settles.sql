-- Production 2026-11-11: catalog video set fa708f8e stayed 'cancel_requested'
-- («Скасовуємо…») for good. Its variant was 'working', its operation 'failed',
-- and the operation's upload ownership had ended in cleanup 'attention' after
-- 24 of 24 attempts. The cancellation proof refused ANY upload ownership row,
-- so a failed variant that had once started an upload could never let its set
-- close — even after cleanup had trashed the file, proved it never existed, or
-- recorded it as retained. The variant retry carried the same refusal, so a set
-- that was not being canceled sat 'unknown' the same way.
--
-- An upload ownership no longer blocks once the operation is terminal without
-- output and its cleanup has ended ('trashed', 'not_created', 'attention').
-- Cleanup itself is bounded (24 attempts, backoff of at most 10 minutes); one
-- that has still not ended 24 hours after the operation finished — the worker
-- never reached it, or the row predates the dispatcher — is closed as
-- abandoned: 'attention' with PROCESS_RESULT_UNCERTAIN. Nothing is deleted: a
-- file that may exist stays in Drive and the outcome stays recorded on the row.
-- A running operation that owns an upload keeps blocking exactly as before;
-- the cleanup claimer fails it once its handoff has expired.
begin;

-- Caller holds the operation row lock (same order as cleanup: operation, ownership).
create function private.process_upload_settled(p_operation uuid) returns boolean language plpgsql security definer set search_path='' as $$
declare o public.team_operations%rowtype;u private.process_upload_ownership%rowtype;
begin
 select * into u from private.process_upload_ownership where operation_id=p_operation for update;
 if not found then return true;end if;
 select * into o from public.team_operations where id=p_operation;
 if o.id is null or o.state not in('failed','canceled') or o.result_material_id is not null or u.upload_state='published' then return false;end if;
 if u.cleanup_state in('trashed','not_created','attention') then return true;end if;
 if (u.lease_expires_at is null or u.lease_expires_at<=clock_timestamp())
  and coalesce(o.finished_at,o.updated_at)<=clock_timestamp()-interval '24 hours' then
  update private.process_upload_ownership set cleanup_state='attention',last_code='PROCESS_RESULT_UNCERTAIN',
   lease_owner=null,lease_expires_at=null,next_attempt_at=null,updated_at=clock_timestamp() where operation_id=p_operation;
  return true;
 end if;
 return false;
end $$;
revoke all on function private.process_upload_settled(uuid) from public,anon,authenticated,service_role;

do $quiescent$
declare d text;
 needle text:=$find$or i.provider_result_id is not null or exists(select 1 from private.process_upload_ownership where operation_id=o.id)then return false;end if;$find$;
begin
 select pg_get_functiondef('private.catalog_video_cancel_quiescent(uuid)'::regprocedure) into d;
 if strpos(d,needle)=0 then raise exception 'UPLOAD_CLEANUP_CANCEL_SEAM_CHANGED';end if;
 d:=replace(d,needle,$replace$or i.provider_result_id is not null or not private.process_upload_settled(o.id)then return false;end if;$replace$);
 execute d;
end $quiescent$;

do $retry$
declare d text;
 needle text:=$find$or exists(select 1 from private.process_upload_ownership w where w.operation_id=o.id) then return jsonb_build_object('kind','unknown');end if;$find$;
begin
 select pg_get_functiondef('private.retry_failed_catalog_video_variant(uuid,integer)'::regprocedure) into d;
 if strpos(d,needle)=0 then raise exception 'UPLOAD_CLEANUP_RETRY_SEAM_CHANGED';end if;
 d:=replace(d,needle,$replace$or not private.process_upload_settled(o.id) then return jsonb_build_object('kind','unknown');end if;$replace$);
 execute d;
end $retry$;

-- The per-minute settlement also moves a set that is not being canceled once a
-- failed variant's upload cleanup has ended; before, only the owner's next read
-- or the agent's reconcile asked, and a set nobody opened stayed 'unknown'.
do $settle$
declare d text;
 needle text:=$find$return jsonb_build_object('settled',n,'resolved',resolved);$find$;
begin
 select pg_get_functiondef('public.service_settle_catalog_video_cancellations(integer)'::regprocedure) into d;
 if strpos(d,needle)=0 then raise exception 'UPLOAD_CLEANUP_SETTLE_SEAM_CHANGED';end if;
 d:=replace(d,needle,$replace$for active in select cleaned.id from private.catalog_video_sets cleaned where cleaned.state in('accepted','preparing','unknown')
  and exists(select 1 from private.catalog_video_variants v join public.team_operations o on o.team_id=cleaned.team_id and o.actor_id=cleaned.actor_id and o.kind='process' and o.idempotency_key='catalog-variant:'||v.request_id::text
   join private.process_upload_ownership w on w.operation_id=o.id
   where v.video_set_id=cleaned.id and v.state in('working','unknown') and v.output_material_id is null and o.state='failed' and o.result_material_id is null
   and w.upload_state<>'published' and (w.cleanup_state in('trashed','not_created','attention') or coalesce(o.finished_at,o.updated_at)<=clock_timestamp()-interval '24 hours'))
  order by cleaned.updated_at,cleaned.id limit p_limit loop
  perform 1 from private.catalog_video_sets where id=active.id for update skip locked;if not found then continue;end if;
  for idx in select video_variant_index from private.catalog_video_variants where video_set_id=active.id and state in('working','unknown') and output_material_id is null order by video_variant_index loop
   perform private.retry_failed_catalog_video_variant(active.id,idx);
  end loop;
  -- Observation scheduling only: a set whose failure is final keeps its answer
  -- but must not hold the head of this list every minute.
  update private.catalog_video_sets set updated_at=clock_timestamp() where id=active.id;
  resolved:=resolved+1;
 end loop;
 return jsonb_build_object('settled',n,'resolved',resolved);$replace$);
 execute d;
end $settle$;

commit;
