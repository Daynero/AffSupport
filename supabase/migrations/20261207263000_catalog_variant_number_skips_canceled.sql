-- The catalog name preview shows max(existing catalog variant)+1, but a new
-- intent took max over catalogs AND every intent ever begun for the video,
-- canceled ones included. Each canceled creation consumed a number for good,
-- so the preview said "_v10_catalog" and the catalog was created as v13 (beta
-- 2026-11-11, scenario S5); people copy that name into Meta.
--
-- A canceled intent never registers a catalog, so its number is free again:
-- allocation and the reserved-number uniqueness both ignore canceled intents,
-- and the preview counts the same live intents the allocation counts, so the
-- preview equals the name that is created. Allocation still runs under the
-- per-video advisory lock, so concurrent creations get distinct numbers.
begin;
drop index if exists private.catalog_generation_reserved_variant;
create unique index catalog_generation_reserved_variant on private.catalog_generation_intents(team_id,video_material_id,variant) where replaces_material_id is null and state<>'canceled';

do $allocate$
declare d text;
begin
 select pg_get_functiondef('private.catalog_image_begin_intent_legacy(uuid,uuid,uuid,text,jsonb,uuid)'::regprocedure) into d;
 if strpos(d,$find$union all select variant from private.catalog_generation_intents where team_id=p_team and video_material_id=p_video and replaces_material_id is null) variants$find$)=0 then raise exception 'CATALOG_VARIANT_ALLOCATION_PATCH_MISSING';end if;
 d:=replace(d,$find$union all select variant from private.catalog_generation_intents where team_id=p_team and video_material_id=p_video and replaces_material_id is null) variants$find$,$replace$union all select variant from private.catalog_generation_intents where team_id=p_team and video_material_id=p_video and replaces_material_id is null and state<>'canceled') variants$replace$);
 execute d;
end $allocate$;

create or replace function public.service_next_product_catalog_variant(p_team uuid, p_video uuid)
returns integer
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce(max(v), 0) + 1 from (
    select coalesce(record.variant, 1) v
    from public.team_product_catalogs as record
    where record.team_id = p_team and record.video_material_id = p_video
    union all
    select intent.variant
    from private.catalog_generation_intents as intent
    where intent.team_id = p_team and intent.video_material_id = p_video
      and intent.replaces_material_id is null and intent.state <> 'canceled'
  ) numbers;
$$;
commit;
