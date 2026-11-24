-- Production 2026-11-24 (Windows, 1.6.2): «Готово відео: 0 з 10 · Soty не бере це завдання» and a
-- restart did not help. The desktop's stored recovery handle could no longer be read after the
-- computer went down mid-session, so its background work never asked the server for anything
-- again, while the server still held the delegation as live for another month.
--
-- A desktop that knows its handle is lost now names that delegation as `renewalDelegationId` when
-- the page sets it up again automatically. Renewal used to be accepted only for an EXPIRED
-- delegation, and automatic setup refused to replace any live one — so the one computer that had
-- lost its handle could never be set up again without someone revoking it by hand. The named
-- delegation of the same person, space and computer may now be live; every OTHER live delegation
-- still refuses automatic setup (another tab or an older process whose ownership is not known).
-- The replaced delegation is revoked by the setup itself (the existing delegate path).

do $patch$
declare d text;
begin
 select pg_get_functiondef('public.service_team_recovery(text,bytea,jsonb)'::regprocedure) into d;
 if strpos(d,$find$     and d.revoked_at is null and d.expires_at<=clock_timestamp()
  ) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;$find$)=0
  or strpos(d,$find$     and d.revoked_at is null and d.expires_at>clock_timestamp()
     and d.enrollment_hash is distinct from p_hash$find$)=0
 then raise exception 'RECOVERY_RENEW_LIVE_PATCH_MISSING';end if;
 -- The renewed delegation may be expired or live; it must still be this computer's and unrevoked.
 d:=replace(d,$find$     and d.revoked_at is null and d.expires_at<=clock_timestamp()
  ) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;$find$,
  $replace$     and d.revoked_at is null
  ) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;$replace$);
 -- Only the delegation the desktop declared lost may be replaced while live.
 d:=replace(d,$find$     and d.revoked_at is null and d.expires_at>clock_timestamp()
     and d.enrollment_hash is distinct from p_hash$find$,
  $replace$     and d.revoked_at is null and d.expires_at>clock_timestamp()
     and d.enrollment_hash is distinct from p_hash
     and (not p_input ? 'renewalDelegationId' or d.id<>(p_input->>'renewalDelegationId')::uuid)$replace$);
 execute d;
end $patch$;
