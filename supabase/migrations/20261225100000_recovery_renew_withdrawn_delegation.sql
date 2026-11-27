-- Production 2026-11-27 (1.6.3 → 1.7.2): after a rotation the server refused a desktop's handle
-- (AUTH_REQUIRED). The desktop now renews such a delegation by name, as it already did for an
-- expired or lost one. But a refused delegation is often withdrawn by then — the person signed out
-- to «fix» it, and signing out revokes this computer's delegation — and naming a WITHDRAWN
-- delegation was refused with PERMISSION_DENIED, which the page does not retry: background work
-- stayed off for good, and every «Оновити зараз» of a re-stitching catalog said AGENT_REQUIRED.
--
-- A named delegation of the same person, space and computer that is already revoked is no longer
-- in anyone's way: the setup proceeds as a fresh one. A delegation that is not this computer's
-- (another person, another space, another computer, or none) is still refused, and every OTHER
-- live delegation of this computer still refuses automatic setup (AUTH_REQUIRED), so a replaced
-- delegation still cannot be named to displace the live one that replaced it.

do $patch$
declare d text;
begin
 select pg_get_functiondef('public.service_team_recovery(text,bytea,jsonb)'::regprocedure) into d;
 if strpos(d,$find$     and d.team_id=team and d.installation_id=installation
     and d.revoked_at is null
  ) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;$find$)=0
 then raise exception 'RECOVERY_RENEW_WITHDRAWN_PATCH_MISSING';end if;
 d:=replace(d,$find$     and d.team_id=team and d.installation_id=installation
     and d.revoked_at is null
  ) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;$find$,
  $replace$     and d.team_id=team and d.installation_id=installation
  ) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;$replace$);
 execute d;
end $patch$;
