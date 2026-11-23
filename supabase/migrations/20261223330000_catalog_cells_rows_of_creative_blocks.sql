-- 062, production 2026-11-23: a catalog of several videos without re-stitching never got its video
-- links. The publication job of «Prostalis GR f18 vid7-8-9» (4 videos, 400 products, links
-- scheduled for 00:05) and of another space (3 videos) failed every 30 seconds with SOURCE_CHANGED.
--
-- service_prepare_catalog_publication_cells checks each product's link against the receipt of its
-- source, and took the source by the product's row number: context.sources[row]. A 'creatives'
-- target without re-stitched sets has one source per creative block, not per row, so every row
-- past the fourth had no source and the check failed. The worker (publicationRowLinks) already
-- reads blocks by their row ranges; the check now does the same: one source per row when there is
-- one per row, the single source of a source-only target, otherwise the block whose rows hold it.
begin;

do $patch$
declare
  d text := pg_get_functiondef('public.service_prepare_catalog_publication_cells(uuid,uuid,jsonb)'::regprocedure);
  anchor constant text := $find$receipt.material_id=(case when context->>'sourceOnly'='true'then context#>>'{sources,0,materialId}'else context->'sources'->((product.ordinality-1)::integer)->>'materialId'end)::uuid$find$;
  replacement constant text := $repl$receipt.material_id=(case when context->>'sourceOnly'='true'then context#>>'{sources,0,materialId}' when jsonb_array_length(context->'sources')=(context->>'productCount')::integer then context->'sources'->((product.ordinality-1)::integer)->>'materialId' else (select block.value->>'materialId' from jsonb_array_elements(case when jsonb_typeof(context->'segments')='array' then context->'segments' else '[]'::jsonb end) block(value) where product.ordinality-1 >= (block.value->>'rowStart')::integer and product.ordinality-1 < (block.value->>'rowStart')::integer+(block.value->>'rowCount')::integer limit 1) end)::uuid$repl$;
begin
  if strpos(d, anchor) = 0 then raise exception 'PATCH_ANCHOR_MISSING: service_prepare_catalog_publication_cells'; end if;
  if strpos(substr(d, strpos(d, anchor) + length(anchor)), anchor) > 0 then raise exception 'PATCH_ANCHOR_AMBIGUOUS'; end if;
  execute replace(d, anchor, replacement);
end
$patch$;

commit;
