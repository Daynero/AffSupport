-- Restitch creation captures its original video through
-- service_capture_catalog_video_source with the Drive version the request read
-- at its start. A metadata-only change (sharing, rename) advances the Drive
-- version and the background sync stores it within seconds; when that landed
-- between the two reads the capture refused with SOURCE_CHANGED and the first
-- create returned 409 (beta 2026-11-11, scenario S4) -- the same race 200000
-- fixed for the no-restitch publication capture.
--
-- A version drift is accepted when the bytes are provably the same: the
-- material's stored checksum and size equal the live observation. A drift of
-- content (checksum or size), or a material never fingerprinted, still refuses.
--
-- The same function's refresh of a stale material row (live version newer than
-- the stored one) could never run: it raised "column reference checksum is
-- ambiguous" and the create failed. It now names the observed value.
begin;
do $capture$
declare d text;
begin
 select pg_get_functiondef('public.service_capture_catalog_video_source(uuid,uuid,uuid,uuid,text,text,jsonb)'::regprocedure) into d;
 if strpos(d,$find$ if m.drive_version is distinct from p_expected_version and (m.drive_version,m.checksum,m.size_bytes,m.mime_type) is distinct from (version,lower(checksum),bytes,mime) then raise exception 'SOURCE_CHANGED'$find$)=0 then raise exception 'VIDEO_SOURCE_VERSION_PATCH_MISSING';end if;
 d:=replace(d,$find$ if m.drive_version is distinct from p_expected_version and (m.drive_version,m.checksum,m.size_bytes,m.mime_type) is distinct from (version,lower(checksum),bytes,mime) then raise exception 'SOURCE_CHANGED'$find$,$replace$ if m.drive_version is distinct from p_expected_version and (m.checksum is null or lower(m.checksum) is distinct from lower(checksum) or m.size_bytes is distinct from bytes) then raise exception 'SOURCE_CHANGED'$replace$);
 -- The refresh below named both the column and the variable checksum: PL/pgSQL
 -- refused it as ambiguous, so any capture whose live tuple differed from the
 -- stored one failed outright instead of refreshing the material.
 if strpos(d,$find$checksum=lower(checksum),size_bytes=bytes$find$)=0 then raise exception 'VIDEO_SOURCE_REFRESH_PATCH_MISSING';end if;
 d:=replace(d,$find$checksum=lower(checksum),size_bytes=bytes$find$,$replace$checksum=lower(p_observed->>'checksum'),size_bytes=bytes$replace$);
 execute d;
end $capture$;
commit;
