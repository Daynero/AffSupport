-- 062, production 2026-11-23: a second publication of a several-creative catalog never finished.
-- The owner's launch «TR_16+1_v54» (2 re-stitched videos, links copied to R2) stopped at
-- «Реєструємо каталог»: the R2 publication job stayed 'unknown' and the launch waited for it.
--
-- The worker verifies the written cells, then calls service_confirm_catalog_creative_links before it
-- reports «verified» — and only that report makes the job verified. The function refused any job
-- not yet verified (WRONG_STATE), so a 'creatives' job could never verify: every retry wrote,
-- verified, was refused and reported unknown. The first publication passed only because it goes
-- through the initial-publication lane.
--
-- A job the worker has dispatched (its cells written) may now be confirmed while it is verified;
-- one never dispatched is still refused.
begin;

do $patch$
declare
  d text := pg_get_functiondef('public.service_confirm_catalog_creative_links(uuid)'::regprocedure);
  anchor constant text := $find$if j.verified_at is null and j.state <> 'published' then raise exception 'WRONG_STATE' using errcode = '55000'; end if;$find$;
  replacement constant text := $repl$if j.verified_at is null and j.state <> 'published' and j.dispatched_at is null then raise exception 'WRONG_STATE' using errcode = '55000'; end if;$repl$;
begin
  if strpos(d, anchor) = 0 then raise exception 'PATCH_ANCHOR_MISSING: service_confirm_catalog_creative_links'; end if;
  if strpos(substr(d, strpos(d, anchor) + length(anchor)), anchor) > 0 then raise exception 'PATCH_ANCHOR_AMBIGUOUS'; end if;
  execute replace(d, anchor, replacement);
end
$patch$;

commit;
