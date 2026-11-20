-- 062: a catalog Launch can be made of images.
--
-- The catalog of images is generated exactly like a catalog with white
-- pictures; only image_link (H) carries the creative. It has no video, so the
-- invariants that assumed one are opened for that case only:
--   * team_product_catalogs.video_link is nullable when the snapshot says
--     _catalogCreativeKind = 'image' (still https when present);
--   * catalog_generation_intents.video_material_id stays not null and means
--     "the primary creative" (the first one) of either kind;
--   * the intent, the initial context and the catalog companion accept an
--     image as the primary creative of an image catalog;
--   * Launch acceptance checks that the frozen creative list in the request
--     payload is the admitted config's list;
--   * a creative list of up to 400 entries fits the frozen request payload.
-- Old catalogs and video catalogs are unaffected.
begin;

create function private.patch_function_062(p_function regprocedure, p_find text, p_replace text)
returns void language plpgsql set search_path = '' as $$
declare d text;
begin
  d := pg_catalog.pg_get_functiondef(p_function);
  if pg_catalog.strpos(d, p_find) = 0 then raise exception 'PATCH_062_ANCHOR_MISSING: %', p_function; end if;
  if pg_catalog.strpos(pg_catalog.substr(d, pg_catalog.strpos(d, p_find) + pg_catalog.length(p_find)), p_find) > 0 then
    raise exception 'PATCH_062_ANCHOR_AMBIGUOUS: %', p_function;
  end if;
  execute pg_catalog.replace(d, p_find, p_replace);
end $$;
revoke all on function private.patch_function_062(regprocedure, text, text) from public, anon, authenticated, service_role;

-- A catalog of images has no video link.
alter table public.team_product_catalogs alter column video_link drop not null;
alter table public.team_product_catalogs drop constraint team_product_catalogs_video_link_check;
alter table public.team_product_catalogs add constraint team_product_catalogs_video_link_check
  check (coalesce(video_link ~ '^https://[^[:space:]]+$', false)
         or coalesce(video_link is null and settings_snapshot->>'_catalogCreativeKind' = 'image', false));

-- The frozen Launch request may carry up to 400 creatives.
alter table private.launch_catalog_video_contexts drop constraint launch_catalog_video_contexts_request_payload_check;
alter table private.launch_catalog_video_contexts add constraint launch_catalog_video_contexts_request_payload_check
  check (jsonb_typeof(request_payload) = 'object' and octet_length(request_payload::text) <= 262144);
select private.patch_function_062('private.catalog_image_begin_intent_legacy(uuid,uuid,uuid,text,jsonb,uuid)'::regprocedure,
  $find$octet_length(p_payload::text)>32768$find$,
  $repl$octet_length(p_payload::text)>(case when p_payload ? 'creatives' then 262144 else 32768 end)$repl$);

-- The primary creative of an image catalog is an image.
select private.patch_function_062('private.catalog_image_begin_intent_legacy(uuid,uuid,uuid,text,jsonb,uuid)'::regprocedure,
  $find$ if not exists(select 1 from public.team_materials where team_id=p_team and id=p_video and category='video' and lifecycle='active') then$find$,
  $repl$ if not exists(select 1 from public.team_materials where team_id=p_team and id=p_video and category=case when p_payload->>'creativeKind'='image' then 'image' else 'video' end and lifecycle='active') then$repl$);

-- Without restitch the initial context only proves the source: an image qualifies.
select private.patch_function_062('public.service_initial_catalog_video_context_before_foreground(uuid,uuid,uuid,uuid,boolean)'::regprocedure,
  $find$ select * into m from public.team_materials where id=p_source and team_id=p_team and lifecycle='active' and category='video';$find$,
  $repl$ select * into m from public.team_materials where id=p_source and team_id=p_team and lifecycle='active' and (category='video' or (p_require_executor is false and category='image'));$repl$);

-- The catalog companion of an image catalog: no video link, an image as the primary creative.
select private.patch_function_062('public.service_link_product_catalog_companion(uuid,uuid,uuid,uuid,jsonb)'::regprocedure,
  $find$     or v_video_link is null
$find$,
  $repl$     or (v_video_link is null and v_snapshot->>'_catalogCreativeKind' is distinct from 'image')
$repl$);
select private.patch_function_062('public.service_link_product_catalog_companion(uuid,uuid,uuid,uuid,jsonb)'::regprocedure,
  $find$     or video_row.category is distinct from 'video'
$find$,
  $repl$     or video_row.category is distinct from (case when v_snapshot->>'_catalogCreativeKind'='image' then 'image' else 'video' end)
$repl$);

-- Launch acceptance: the creative list frozen into the request is the admitted one.
select private.patch_function_062('public.service_accept_launch_catalog_video_generation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure,
  $find$  or jsonb_typeof(plan->'childRequestIds') is distinct from 'array' then raise exception 'INVALID_INPUT' using errcode='22023';end if;$find$,
  $repl$  or jsonb_typeof(plan->'childRequestIds') is distinct from 'array'
  or (p_config ? 'creatives' and (preferences->'creativeKind' is distinct from p_config->'creativeKind'
      or preferences->'creatives' is distinct from (select jsonb_agg(jsonb_build_object('materialId',c->'materialId','alias',to_jsonb(private.launch_normalize_sub(c->'alias')),'copies',c->'copies') order by o) from jsonb_array_elements(p_config->'creatives') with ordinality x(c,o))))
  or (not (p_config ? 'creatives') and (preferences ? 'creatives' or preferences ? 'creativeKind')) then raise exception 'INVALID_INPUT' using errcode='22023';end if;$repl$);

drop function private.patch_function_062(regprocedure, text, text);

commit;
