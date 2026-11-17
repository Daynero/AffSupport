-- next QA 2026-11-17: a catalog launch that stopped after its catalog was created could never
-- be resumed — «Повторити» answered «У поточному стані це неможливо» (WRONG_STATE) every time.
--
-- A launch whose SUB3 carries the catalog name binds the advertising link before creation
-- (launchSubBinding, 20261206142000): the catalog row stores that bound link (sub_3=ID_2_v2_
-- catalog), while the intent's request still holds the editor's link (sub_3=000). The resume
-- asks service_reconcile_catalog_result whether its catalog already exists, and it matched
-- only the request link, so it answered «no», the creation ran again, and the existing catalog
-- refused it.
--
-- The catalog now also matches the intent's bound advertising link; every other condition
-- (material, video, variant, product count, active) is unchanged.
begin;

do $do$
declare
  d text := pg_get_functiondef('public.service_reconcile_catalog_result(uuid,uuid,uuid)'::regprocedure);
  seam constant text := 'c.source_link=r.request_payload->>''sourceLink''';
begin
  if position(seam in d) = 0 then
    raise exception 'CATALOG_RECONCILE_SEAM_MISSING';
  end if;
  execute replace(
    d,
    seam,
    'c.source_link in(r.request_payload->>''sourceLink'',r.checkpoint#>>''{launchSubBinding,advertisingUrl}'')'
  );
end
$do$;

commit;
