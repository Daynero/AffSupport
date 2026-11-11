-- Beta 2026-11-11 (QA round 9): after a killed agent restarted, its own set was
-- refused for about two more minutes (11 × 409 on the local attach) before the
-- run picked itself up, and the launch dialog asked to retry in the meantime.
--
-- A foreground authority belongs to one enrolled agent. A redeem that names a
-- new execution instance for the same enrollment comes from a restart of that
-- very agent: only one agent of an installation runs at a time, so the previous
-- instance is gone and nothing of it can still write. Its variants are released
-- after 75 seconds of silence instead of two minutes (heartbeats come every 30
-- seconds, so a live run is never that quiet). The same instance and every other
-- path keep the two-minute rule.
--
-- The new parameter defaults to null, so the four-argument call of the edge
-- function deployed before this migration keeps the two-minute behavior.
begin;

drop function public.service_release_silent_catalog_video_foreground(uuid,uuid,uuid,bytea);
create function public.service_release_silent_catalog_video_foreground(p_set uuid,p_enrollment uuid,p_native uuid,p_proof_hash bytea,p_execution_native uuid default null) returns integer language plpgsql security definer set search_path='' as $$
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
 return private.release_silent_catalog_video_variants(s.id,
  case when p_execution_native is not null and p_execution_native is distinct from f.execution_native_instance_id
   then interval '75 seconds' else interval '2 minutes' end);
end;$$;
revoke all on function public.service_release_silent_catalog_video_foreground(uuid,uuid,uuid,bytea,uuid) from public,anon,authenticated;
grant execute on function public.service_release_silent_catalog_video_foreground(uuid,uuid,uuid,bytea,uuid) to service_role;

commit;
