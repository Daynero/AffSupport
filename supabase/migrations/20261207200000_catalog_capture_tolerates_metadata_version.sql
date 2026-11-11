-- A no-restitch catalog captures its original video as the publication target
-- right after the sheet is created. The capture compared the material's stored
-- Drive version with the version the request read at its start. Creating the
-- catalog shares the original (an "anyone" reader permission), which advances
-- the Drive version without touching the bytes, and the background sync writes
-- that new version into team_materials within seconds. When the sync landed
-- between the two reads the capture raised SOURCE_CHANGED (HTTP 409), the
-- create returned an error, and the catalog was later registered without its
-- publication policy (production, 2026-11-10 19:55 UTC).
--
-- A version drift is now accepted when the live bytes are the ones this catalog
-- was built from: the observed checksum equals the checksum the intent proved
-- for this source during creation. Any other drift still refuses.
begin;
do $capture$
declare d text;
begin
 select pg_get_functiondef('public.service_capture_initial_catalog_publication_source(uuid,uuid,uuid,uuid,uuid,text,text,jsonb)'::regprocedure) into d;
 if strpos(d,$find$ or m.drive_version is distinct from p_expected_version or $find$)=0 then raise exception 'CAPTURE_VERSION_PATCH_MISSING';end if;
 d:=replace(d,$find$ or m.drive_version is distinct from p_expected_version or $find$,$replace$ or (m.drive_version is distinct from p_expected_version and (lower(i.checkpoint->('source_'||p_source::text)->>'checksum') is null or lower(i.checkpoint->('source_'||p_source::text)->>'checksum') is distinct from lower(p_observed->>'checksum'))) or $replace$);
 execute d;
end $capture$;
commit;
