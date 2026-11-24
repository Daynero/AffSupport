-- Production 2026-11-24: «Готово відео: 0 з 10 · Чекає на комп'ютерний агент» on a computer whose
-- background work was set up and claiming. The person had TWO live delegations — the working one
-- and one left behind by an earlier setup of the same computer — and a catalog round (and a catalog
-- created with videos) went to the background work only when there was exactly one. Two computers
-- of one person hit the same wall for good.
--
-- The executor is now the live delegation that worked most recently (a claim every 30 s while it
-- runs, then probe, rotation and creation), the same for both callers. An explicit executor still
-- has to be one of that person's live delegations.

create function private.recovery_executor_for(p_team uuid, p_actor uuid)
returns uuid language sql stable security definer set search_path='' as $$
 select d.installation_id from private.team_recovery_delegations d
  where d.team_id=p_team and d.actor_id=p_actor and d.revoked_at is null
   and d.expires_at>statement_timestamp()
  order by greatest(coalesce(d.last_claim_at,'-infinity'),coalesce(d.last_probe_at,'-infinity'),
   coalesce(d.last_rotation_at,'-infinity'),d.created_at) desc, d.created_at desc
  limit 1
$$;
revoke all on function private.recovery_executor_for(uuid,uuid) from public,anon,authenticated,service_role;

do $patch$
declare d text;
begin
 select pg_get_functiondef('public.service_adopt_catalog_variant_round(uuid,uuid,uuid,uuid,uuid)'::regprocedure) into d;
 if strpos(d,$find$ if executors<>1 then return private.note_catalog_variant_round_wait(p_attempt,'AGENT_REQUIRED');end if;$find$)=0
 then raise exception 'RECOVERY_EXECUTOR_ADOPT_PATCH_MISSING';end if;
 -- Several live delegations: the one that worked last carries the round.
 d:=replace(d,$find$ if executors<>1 then return private.note_catalog_variant_round_wait(p_attempt,'AGENT_REQUIRED');end if;$find$,
  $replace$ if executors<>1 then host:=private.recovery_executor_for(p_team,p_actor);end if;$replace$);
 execute d;

 select pg_get_functiondef('public.service_initial_catalog_video_context_before_foreground(uuid,uuid,uuid,uuid,boolean)'::regprocedure) into d;
 if strpos(d,$find$select case when count(*)=1 then min(d.installation_id::text)::uuid else null end into executor from private.team_recovery_delegations d where d.team_id=p_team and d.actor_id=p_actor and d.revoked_at is null and d.expires_at>statement_timestamp();$find$)=0
 then raise exception 'RECOVERY_EXECUTOR_CONTEXT_PATCH_MISSING';end if;
 d:=replace(d,$find$select case when count(*)=1 then min(d.installation_id::text)::uuid else null end into executor from private.team_recovery_delegations d where d.team_id=p_team and d.actor_id=p_actor and d.revoked_at is null and d.expires_at>statement_timestamp();$find$,
  $replace$executor:=private.recovery_executor_for(p_team,p_actor);$replace$);
 execute d;
end $patch$;
