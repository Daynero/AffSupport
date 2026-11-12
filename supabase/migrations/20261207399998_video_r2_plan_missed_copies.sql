-- A launch with "copy video to R2" ticked on production (2026-11-12, MY_1_v5_catalog) published
-- its re-stitched variant with a Drive link and never got a copy of it: the option was written
-- before the first publication, so the only copy planned was of the source video, and the
-- planning that follows a verified publication did not happen (the trigger swallows its
-- errors, so why is not recorded). The minute sweep saw the catalog every minute and, by
-- design, never planned a copy, so the catalog stayed on Drive for good.
--
-- The sweep now plans a copy for a video in the published cells only when nothing was ever
-- attempted for it: no copy row in any state but deleted, and no refusal (quota, format, size)
-- recorded for that catalog and video. A refused copy is still never retried by a timer.

create function private.catalog_video_r2_cells_unplanned(p_catalog uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(
  select 1
  from private.catalog_video_r2_preferences pref
  join private.catalog_video_publication_policies p on p.catalog_material_id=pref.catalog_material_id
  join private.catalog_video_publication_jobs j on j.catalog_material_id=p.catalog_material_id
   and j.target_id=p.target_id and j.revision=p.revision and j.state='published'
  cross join lateral private.catalog_video_r2_cell_sources(j.id) cs
  join public.team_materials m on m.id=cs.material_id and m.team_id=pref.team_id and m.lifecycle='active'
  where pref.catalog_material_id=p_catalog and pref.enabled
   and p.mode<>'held' and not p.legacy_delivery_unverified
   and cs.source_version is not null and cs.link_kind<>'r2'
   and not exists(select 1 from private.catalog_video_r2_copies c
    where c.team_id=pref.team_id and c.source_version=cs.source_version and c.state<>'deleted')
   and not exists(select 1 from private.catalog_video_r2_journal jr
    where jr.catalog_material_id=p_catalog and jr.source_material_id=cs.material_id and jr.stage='failed'))
$$;
revoke all on function private.catalog_video_r2_cells_unplanned(uuid) from public,anon,authenticated,service_role;

do $sweep$
declare d text;
begin
 select pg_get_functiondef('public.service_catalog_video_r2_reconcile_pending(integer)'::regprocedure) into d;
 if strpos(d,$find$outcome:=private.catalog_video_r2_reconcile(cat,stale);$find$)=0
 then raise exception 'VIDEO_R2_MISSED_COPIES_PATCH_MISSING';end if;
 d:=replace(d,$find$outcome:=private.catalog_video_r2_reconcile(cat,stale);$find$,
  $replace$outcome:=private.catalog_video_r2_reconcile(cat,stale or private.catalog_video_r2_cells_unplanned(cat));$replace$);
 execute d;
end $sweep$;
