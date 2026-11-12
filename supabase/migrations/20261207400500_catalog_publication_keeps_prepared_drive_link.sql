-- Production 2026-11-12 (R2 video enabled at 09:40Z): every deferred catalog
-- publication with «Копіювати відео в R2» on stopped at its due time and was
-- blocked an hour later (DreamTeam: ZA 1_v8, BD 1 Gen_v7; PK 33_v6 the same way
-- between write and readback).
--
-- At creation the copy is not ready yet, so the job records the Drive link of
-- each video. The copy becomes ready while the job waits for its due time. At
-- due time the worker proves every link again, the resolver now answers with the
-- R2 URL, the worker sees a different URL for the same source and refuses with
-- SOURCE_CHANGED every minute, and the one-hour validation rule blocks the job
-- with DRIVE_UNAVAILABLE. The catalog never gets its links.
--
-- A publication job keeps the Drive link it already recorded for the same video
-- version. The switch to R2 is the reconcile job's work after this publication
-- is verified (docs/CATALOG_VIDEO_R2.md), exactly as for an immediate first
-- publication. Jobs that recorded nothing yet, R2 receipts, catalog scopes and
-- pre-creation scopes resolve as before.
--
-- Production was patched with this exact body on 2026-11-12; the guard below
-- makes the migration a no-op there.
begin;

do $keep_drive$
declare d text;
 needle text:=$find$ if v_catalog is null and p_job is not null then select catalog_material_id into v_catalog from private.catalog_video_publication_jobs where id=p_job; end if;$find$;
 marker text:='catalog_publication_keeps_prepared_drive_link';
begin
 select pg_get_functiondef('public.service_catalog_video_r2_resolve(uuid,uuid,text,bigint,text,text,uuid,uuid,boolean)'::regprocedure) into d;
 if strpos(d,marker)>0 then return; end if;
 if strpos(d,needle)=0 then raise exception 'R2_RESOLVE_KEEP_DRIVE_SEAM_CHANGED'; end if;
 d:=replace(d,needle,needle||$add$
 -- catalog_publication_keeps_prepared_drive_link: a job that already recorded the
 -- Drive link for this exact video version keeps it; R2 follows by reconcile.
 if p_job is not null and exists(select 1 from private.catalog_publication_link_receipts r where r.job_id=p_job and r.material_id=p_source_material and r.source_version=p_source_version and r.link_kind='drive') then return jsonb_build_object('enabled',false); end if;$add$);
 execute d;
end $keep_drive$;

commit;
