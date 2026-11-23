-- 062, production 2026-11-23: a launch of several re-stitched creatives never finished. The owner's
-- «TR_16+1» (2 creatives, 1 variation each) had its catalog created and its links published and
-- verified, then sat at «Реєструємо каталог» with PROCESS_RESULT_UNCERTAIN on every retry.
--
-- service_attach_launch_catalog_before_catalog_sub checks the launch's video set against the frozen
-- plan and required the set's requested_count to equal the plan's total videoVariationCount (2). A
-- plan of several creatives gives each creative its own set with its own share (1): the counts never
-- met. The set now matches when its count is the total (one creative) or the variantCount of its own
-- segment in the plan (several).
begin;

do $patch$
declare
  d text := pg_get_functiondef('public.service_attach_launch_catalog_before_catalog_sub(uuid,uuid,uuid,text,text)'::regprocedure);
  anchor constant text := $find$s.requested_count=(x.initial_video_plan#>>'{preferences,videoVariationCount}')::integer$find$;
  replacement constant text := $repl$(s.requested_count=(x.initial_video_plan#>>'{preferences,videoVariationCount}')::integer or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(x.initial_video_plan->'segments')='array' then x.initial_video_plan->'segments' else '[]'::jsonb end) seg where seg->>'setId'=s.id::text and (seg->>'variantCount')::integer=s.requested_count))$repl$;
begin
  if strpos(d, anchor) = 0 then raise exception 'PATCH_ANCHOR_MISSING: service_attach_launch_catalog_before_catalog_sub'; end if;
  if strpos(substr(d, strpos(d, anchor) + length(anchor)), anchor) > 0 then raise exception 'PATCH_ANCHOR_AMBIGUOUS'; end if;
  execute replace(d, anchor, replacement);
end
$patch$;

commit;
