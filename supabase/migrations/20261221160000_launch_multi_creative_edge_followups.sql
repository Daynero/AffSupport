-- 062: what the edge needs beyond the first cut.
--   * the initial publication source of a catalog may be any video segment of
--     its intent, not only the primary creative;
--   * service_confirm_catalog_creative_links(p_job): after a verified write on a
--     'creatives' target, the catalog snapshot learns each block's current
--     link (_catalogCreatives[i].link/linkKind/imageId/linkRevision) from the
--     job's link receipts, and the R2 images it points at become its uses.
begin;

do $capture$
declare d text;
  anchor constant text := $find$ and video_material_id=p_source and request_payload->>'catalogVideoProtocolVersion'='1'$find$;
begin
  d := pg_get_functiondef('public.service_capture_initial_catalog_publication_source(uuid,uuid,uuid,uuid,uuid,text,text,jsonb)'::regprocedure);
  if strpos(d, anchor) = 0 then raise exception 'PATCH_062_ANCHOR_MISSING: service_capture_initial_catalog_publication_source'; end if;
  d := replace(d, anchor, $repl$ and (video_material_id=p_source or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(checkpoint#>'{initialVideoPlan,segments}')='array' then checkpoint#>'{initialVideoPlan,segments}' else '[]'::jsonb end) seg where seg->>'kind'='video' and lower(seg->>'materialId')=p_source::text)) and request_payload->>'catalogVideoProtocolVersion'='1'$repl$);
  execute d;
end $capture$;

-- Returns {catalogId, updated, imageIds}.
create function public.service_confirm_catalog_creative_links(p_job uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j private.catalog_video_publication_jobs%rowtype; c public.team_product_catalogs%rowtype; g record;
  snapshot jsonb; entry jsonb; images uuid[] := '{}'; image uuid; updated integer := 0;
begin
  select * into j from private.catalog_video_publication_jobs where id = p_job;
  if j.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if j.verified_at is null and j.state <> 'published' then raise exception 'WRONG_STATE' using errcode = '55000'; end if;
  if not exists (select 1 from private.catalog_publication_targets t where t.id = j.target_id and t.kind = 'creatives') then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;
  select * into c from public.team_product_catalogs where material_id = j.catalog_material_id and team_id = j.team_id for update;
  if c.material_id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  snapshot := c.settings_snapshot;
  if jsonb_typeof(snapshot->'_catalogCreatives') is distinct from 'array' then raise exception 'WRONG_STATE' using errcode = '55000'; end if;
  for g in
    select s.ordinal, s.kind, r.url, coalesce(r.link_kind, 'drive') link_kind
      from private.catalog_publication_target_segments s
      join private.catalog_publication_link_receipts r on r.job_id = p_job and r.material_id = s.source_material_id
     where s.target_id = j.target_id and s.video_set_id is null and r.url is not null
     order by s.ordinal
  loop
    entry := snapshot->'_catalogCreatives'->g.ordinal;
    if entry is null then continue; end if;
    image := null;
    if g.kind = 'image' and g.link_kind = 'r2' then
      select i.id into image from private.launch_creative_images i
       where i.team_id = j.team_id and i.url = g.url and i.state in ('ready', 'retiring');
      if image is null then raise exception 'SOURCE_CHANGED' using errcode = '55000'; end if;
      images := images || image;
    end if;
    if entry->>'link' is distinct from g.url or entry->>'linkKind' is distinct from g.link_kind then
      entry := (entry - 'imageId') || jsonb_build_object('link', g.url, 'linkKind', g.link_kind,
        'linkRevision', coalesce((entry->>'linkRevision')::integer, 0) + 1)
        || case when image is null then '{}'::jsonb else jsonb_build_object('imageId', image) end;
      snapshot := jsonb_set(snapshot, array['_catalogCreatives', g.ordinal::text], entry);
      updated := updated + 1;
    end if;
  end loop;
  if updated > 0 then
    update public.team_product_catalogs set settings_snapshot = snapshot where material_id = c.material_id;
  end if;
  if exists (select 1 from private.catalog_publication_target_segments s where s.target_id = j.target_id and s.kind = 'image') then
    perform public.service_confirm_launch_creative_image_uses(c.material_id, images);
  end if;
  return jsonb_build_object('catalogId', c.material_id, 'updated', updated, 'imageIds', to_jsonb(images));
end $$;
revoke all on function public.service_confirm_catalog_creative_links(uuid) from public, anon, authenticated;
grant execute on function public.service_confirm_catalog_creative_links(uuid) to service_role;

commit;
