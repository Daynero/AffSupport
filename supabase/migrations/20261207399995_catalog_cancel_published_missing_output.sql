-- 52c28131 on production stayed 'cancel_requested' after 20261207399920: its variant 0 ran to
-- 'succeeded', published its output to Drive, and that output then went missing before it was
-- registered. 399920 let a gone output past the result checks, but
-- `private.process_upload_settled` still answers false for any operation that is not failed or
-- canceled, so the cancellation could never become quiescent.
--
-- A published upload whose material is gone has nothing left to clean up: Drive no longer holds
-- an active copy the set would own. The same rule 399920 applies to the result now applies to
-- the upload settlement. Every other guard (executor quiescence, fences, grants, transfers) stays.

do $quiescent$
declare d text;
begin
 select pg_get_functiondef('private.catalog_video_cancel_quiescent(uuid)'::regprocedure) into d;
 if strpos(d,$find$ or (i.provider_result_id is not null and not private.catalog_variant_output_gone(o.id)) or not private.process_upload_settled(o.id)then return false;end if;$find$)=0
 then raise exception 'CANCEL_PUBLISHED_MISSING_PATCH_MISSING';end if;
 d:=replace(d,$find$ or (i.provider_result_id is not null and not private.catalog_variant_output_gone(o.id)) or not private.process_upload_settled(o.id)then return false;end if;$find$,
  $replace$ or (i.provider_result_id is not null and not private.catalog_variant_output_gone(o.id)) or (not private.catalog_variant_output_gone(o.id) and not private.process_upload_settled(o.id))then return false;end if;$replace$);
 execute d;
end $quiescent$;
