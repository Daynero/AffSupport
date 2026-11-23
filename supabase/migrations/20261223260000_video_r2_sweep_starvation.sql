-- Production 2026-11-22: catalogs created with "copy video to R2" ticked stayed on Drive links
-- for good (NUTRA (RKS), Ksander Alee, work place, DreamTeam). The minute sweep is the only thing
-- that plans the copies a first publication missed (20261207399998), but it took the 50 OLDEST
-- candidates by preference time, and 55 of the 66 candidates were trashed or missing catalogs.
-- For those `private.catalog_video_r2_reconcile` returns 'none' at once (it only touches an
-- active catalog), so they never left the candidate list and filled every slot every minute;
-- no catalog created after 2026-11-19 was ever visited.
--
-- The sweep now selects only what reconcile can act on (an active catalog whose policy is not
-- held and not awaiting legacy verification) and visits the candidates in random order, so a
-- catalog that reconcile cannot settle for some other reason can no longer starve the rest.

do $sweep$
declare d text;
begin
 select pg_get_functiondef('public.service_catalog_video_r2_reconcile_pending(integer)'::regprocedure) into d;
 if strpos(d,$find$  where exists(select 1 from private.catalog_video_publication_policies p where p.catalog_material_id=pref.catalog_material_id)
$find$)=0
  or strpos(d,$find$order by pref.updated_at limit p_limit$find$)=0
 then raise exception 'VIDEO_R2_SWEEP_STARVATION_PATCH_MISSING';end if;
 d:=replace(d,$find$  where exists(select 1 from private.catalog_video_publication_policies p where p.catalog_material_id=pref.catalog_material_id)
$find$,
  $replace$  where exists(select 1 from private.catalog_video_publication_policies p where p.catalog_material_id=pref.catalog_material_id
    and p.mode<>'held' and not p.legacy_delivery_unverified)
   -- Reconcile settles only an active catalog: a trashed or missing one would hold a slot forever.
   and exists(select 1 from public.team_materials m where m.id=pref.catalog_material_id and m.lifecycle='active')
$replace$);
 d:=replace(d,$find$order by pref.updated_at limit p_limit$find$,
  -- Random, not oldest first: a candidate reconcile cannot settle must not starve the rest.
  $replace$order by random() limit p_limit$replace$);
 execute d;
end $sweep$;
