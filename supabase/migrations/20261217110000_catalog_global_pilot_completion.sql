-- 052 pilot on next (2026-11-17): a catalog update in a pilot space wrote its sheet and
-- then could never be completed. Completion and Drive reconciliation validate the
-- snapshot's picture images through service_catalog_image_validate_rows_v2, which knows
-- only a space's own R2 rows ("kind":"r2") and answers INVALID_RESPONSE to every shared
-- pool row ("kind":"global"). The round ended unknown, and its reconciliation failed the
-- same way every five minutes, so the catalog stayed «Результат невідомий» with a new
-- run blocked. The edge functions already route pool rows to the pool validator; the
-- SQL completion paths did not.
--
-- The row validator now routes by kind: pool rows to service_catalog_global_validate_rows
-- (pilot-aware since 20261216100000), a space's own rows to the unchanged R2 check. A
-- snapshot without pool rows takes exactly the old path, so every space outside the
-- pilot, and production, behaves as before. Reconciliation also validates and finalises
-- through the v3 image-use functions, which confirm a pool recipe and fall back to v2
-- for everything else; v2 alone left a delivered pool recipe unconfirmed.
begin;

alter function public.service_catalog_image_validate_rows_v2(uuid, jsonb) set schema private;
alter function private.service_catalog_image_validate_rows_v2(uuid, jsonb)
  rename to catalog_image_validate_rows_r2;
revoke all on function private.catalog_image_validate_rows_r2(uuid, jsonb)
  from public, anon, authenticated, service_role;

create function public.service_catalog_image_validate_rows_v2(p_team uuid, p_images jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  pool_rows jsonb;
  own_rows jsonb;
begin
  if p_team is null or jsonb_typeof(p_images) is distinct from 'array' then
    raise exception 'INVALID_RESPONSE';
  end if;
  select coalesce(jsonb_agg(value) filter (where value->>'kind' = 'global'), '[]'::jsonb),
         coalesce(jsonb_agg(value) filter (where value->>'kind' is distinct from 'global'), '[]'::jsonb)
    into pool_rows, own_rows
    from jsonb_array_elements(p_images);
  if jsonb_array_length(pool_rows) = 0 then
    perform private.catalog_image_validate_rows_r2(p_team, p_images);
    return;
  end if;
  perform public.service_catalog_global_validate_rows(p_team, pool_rows);
  if jsonb_array_length(own_rows) > 0 then
    perform private.catalog_image_validate_rows_r2(p_team, own_rows);
  end if;
end $$;
revoke all on function public.service_catalog_image_validate_rows_v2(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.service_catalog_image_validate_rows_v2(uuid, jsonb) to service_role;

do $resolve$
declare
  d text;
begin
  select pg_get_functiondef(
    'private.publication_legacy_resolve_catalog_reconciliation(uuid,uuid,text,text)'::regprocedure) into d;
  if strpos(d, 'public.service_catalog_image_validate_uses_v2(') = 0
     or strpos(d, 'public.service_catalog_image_finalize_uses_v2(') = 0 then
    raise exception 'CATALOG_GLOBAL_PILOT_RESOLVE_SEAM_MISSING';
  end if;
  d := replace(d, 'public.service_catalog_image_validate_uses_v2(', 'public.service_catalog_image_validate_uses_v3(');
  d := replace(d, 'public.service_catalog_image_finalize_uses_v2(', 'public.service_catalog_image_finalize_uses_v3(');
  execute d;
end $resolve$;

commit;
