-- Production 2026-11-11: creation intent ce003cbb was canceled, but its video
-- set aab5870c stayed 'cancel_requested' and the window sat at «Готово відео:
-- 0 з 1». The set had one variant, 'unknown', with NO operation: the agent was
-- given the variant and reported it unknown before admitting an operation. The
-- cancellation proof accepted an operation-less variant only while it was
-- 'queued' or an undispatched 'working', so this set could never close.
--
-- Without an operation nothing can produce output, and none can be admitted any
-- more: the cancel admission guard refuses every catalog-variant operation of a
-- canceling set under the same set lock this proof holds. An operation-less
-- variant therefore no longer blocks; one that was dispatched or reported only
-- waits out three minutes without a heartbeat, the silence the rest of the
-- cancellation already uses.
begin;
do $quiescent$
declare d text;
 needle text:=$find$if has_operation or v.operation_id is not null or v.state not in('queued','working')or v.dispatch_credential_hash is not null then return false;end if;$find$;
begin
 select pg_get_functiondef('private.catalog_video_cancel_quiescent(uuid)'::regprocedure) into d;
 if strpos(d,needle)=0 then raise exception 'CANCEL_WITHOUT_OPERATION_SEAM_CHANGED';end if;
 d:=replace(d,needle,$replace$if has_operation or v.operation_id is not null then return false;end if;
   if (v.state<>'queued' or v.dispatch_credential_hash is not null)
    and coalesce(v.heartbeat_at,'-infinity'::timestamptz)>clock_timestamp()-interval '3 minutes' then return false;end if;$replace$);
 execute d;
end $quiescent$;
commit;
