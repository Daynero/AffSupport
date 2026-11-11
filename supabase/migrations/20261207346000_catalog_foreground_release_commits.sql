-- Beta 2026-11-11 (QA, gateway paused 150 s): the silence takeover inside
-- service_redeem_catalog_video_foreground ran in the same transaction as the
-- redeem's own refusal. A redeem from a new instance released the silent
-- variants and then raised PROCESS_RESULT_UNCERTAIN, which rolled the release
-- back with it, on every attempt. The refusals seen on beta came from two old
-- canceled sets kept in the agent's vault, which the agent kept trying to resume
-- (canceled is not an active state, so the check raised); for a live
-- multi-variant set the same rollback undoes the release of a silent variant
-- whenever another variant is still working.
--
--  * service_release_silent_catalog_video_foreground: the same authority checks
--    as the redeem, then the 2-minute silence release, committed in its own
--    call. drive-ops calls it before every redeem that names an execution
--    instance, so a release no longer depends on the redeem succeeding.
--  * A redeem of a set that is no longer active answers WRONG_STATE (final for
--    the agent) instead of PROCESS_RESULT_UNCERTAIN (which it retries).
begin;

create function public.service_release_silent_catalog_video_foreground(p_set uuid,p_enrollment uuid,p_native uuid,p_proof_hash bytea) returns integer language plpgsql security definer set search_path='' as $$
declare f private.catalog_video_foreground_authorities%rowtype;s private.catalog_video_sets%rowtype;
begin
 select *into s from private.catalog_video_sets where id=p_set for update;
 select *into f from private.catalog_video_foreground_authorities where enrollment_id=p_enrollment;
 if f.enrollment_id is null or f.video_set_id is distinct from p_set or f.native_instance_id is distinct from p_native or f.proof_hash is distinct from p_proof_hash or s.executor_id is distinct from p_enrollment then raise exception 'AUTH_REQUIRED' using errcode='42501';end if;
 perform private.require_restitch_control_session(f.session_id,f.actor_id);
 if f.expires_at<=clock_timestamp() then raise exception 'EXPIRED' using errcode='55000';end if;
 if private.can(f.team_id,'process',f.actor_id) is not true or private.can(f.team_id,'upload',f.actor_id) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 -- Only a set that already ran under this authority can have a silent variant.
 if f.redeemed_at is null or s.state not in('accepted','preparing','unknown') then return 0;end if;
 return private.release_silent_catalog_video_variants(s.id,interval '2 minutes');
end;$$;
revoke all on function public.service_release_silent_catalog_video_foreground(uuid,uuid,uuid,bytea) from public,anon,authenticated;
grant execute on function public.service_release_silent_catalog_video_foreground(uuid,uuid,uuid,bytea) to service_role;

do $redeem$
declare d text;
 needle text:=$find$  if s.state not in('accepted','preparing','unknown')or s.workspace_epoch$find$;
begin
 select pg_get_functiondef('public.service_redeem_catalog_video_foreground(uuid,uuid,uuid,bytea,uuid,uuid)'::regprocedure) into d;
 if strpos(d,needle)=0 then raise exception 'FOREGROUND_RELEASE_SEAM_CHANGED';end if;
 d:=replace(d,needle,$add$  if s.state not in('accepted','preparing','unknown') then raise exception 'WRONG_STATE' using errcode='55000';end if;
$add$||needle);
 execute d;
end $redeem$;

commit;
