-- 062: the publication lane writes catalogs with several creatives (research R26).
--
-- service_catalog_publication_cells_context answers a 'creatives' target
-- instead of refusing it (the temporary refusal of 20261221116000 is
-- removed). Besides the fields every target returns it adds
--   creativeKind: 'video' | 'image'
--   segments:     [{ordinal, kind, materialId, rowStart, rowCount}]
-- and `sources`:
--   * no restitched segment: one source per segment, in segment order;
--     a video source has the 'source' branch's shape, an image source adds
--     {kind:'image', r2:boolean, imageUrl?} - imageUrl when a ready creative
--     image exists for the material's current Drive version and checksum;
--   * a restitched segment present: one source per row (productCount), each
--     row its segment's output (the 'video_set' branch's shape) or its
--     segment's source.
-- recipeRowIds come from the catalog's initial plan.
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

-- One source of a segment: its video or image, as the lane resolves it.
create function private.catalog_publication_segment_source(p_team uuid, p_catalog uuid, p_target uuid, p_ordinal integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare g private.catalog_publication_target_segments%rowtype; src public.team_materials%rowtype; conn public.team_drive_connections%rowtype; url text;
begin
  select * into g from private.catalog_publication_target_segments where target_id = p_target and ordinal = p_ordinal and team_id = p_team;
  select * into src from public.team_materials where id = g.source_material_id and team_id = p_team and lifecycle = 'active';
  select * into conn from public.team_drive_connections where id = src.connection_id and team_id = p_team and state = 'connected';
  if g.target_id is null or src.id is null or conn.id is null or g.source_version is null
     or private.catalog_publication_source_version(src.id, p_team) is distinct from g.source_version then
    raise exception 'SOURCE_CHANGED' using errcode = '55000';
  end if;
  if g.kind = 'image' then
    select i.url into url from private.launch_creative_images i
     where i.team_id = p_team and i.material_id = src.id and i.source_version = src.drive_version
       and i.source_checksum = lower(src.checksum) and i.state in ('ready', 'retiring');
  end if;
  return jsonb_build_object('materialId', src.id, 'connectionId', src.connection_id, 'sourceVersion', g.source_version,
      'fileId', src.drive_file_id, 'credentialId', conn.credential_id, 'rootFolderId', conn.root_folder_id)
    || case when g.kind = 'image' then jsonb_build_object('kind', 'image',
         'r2', coalesce((select pr.enabled from private.catalog_video_r2_preferences pr where pr.catalog_material_id = p_catalog), false))
         || case when url is null then '{}'::jsonb else jsonb_build_object('imageUrl', url) end
       else '{}'::jsonb end;
end $$;
revoke all on function private.catalog_publication_segment_source(uuid, uuid, uuid, integer) from public, anon, authenticated, service_role;

-- Remove the temporary refusal.
select private.patch_function_062('public.service_catalog_publication_cells_context(uuid,uuid)'::regprocedure,
  $find$
 if exists(select 1 from private.catalog_publication_targets x where x.id=j.target_id and x.kind='creatives') then raise exception 'MULTI_CREATIVE_UNSUPPORTED' using errcode='22023';end if;$find$,
  '');

-- The 'creatives' branch.
select private.patch_function_062('public.service_catalog_publication_cells_context(uuid,uuid)'::regprocedure,
  $find$ if t.kind='video_set' then
  select * into s from private.catalog_video_sets where id=t.video_set_id and team_id=j.team_id;$find$,
  $repl$ if t.kind='creatives' then
  if exists(select 1 from private.catalog_publication_target_segments g join private.catalog_video_sets x on x.id=g.video_set_id where g.target_id=t.id and x.state is distinct from 'ready') then
   update private.catalog_video_publication_jobs set validation_epoch_started_at=null where id=j.id and dispatched_at is null;return jsonb_build_object('state','waiting');
  end if;
  select i.checkpoint->'initialVideoPlan'->'recipeRowIds' into row_ids from private.catalog_generation_intents i where i.team_id=j.team_id and i.checkpoint->>'materialId'=j.catalog_material_id::text order by i.created_at limit 1;
  if row_ids is not null and jsonb_array_length(row_ids)<>catalog.product_count then row_ids:=null;end if;
  if exists(select 1 from private.catalog_publication_target_segments g where g.target_id=t.id and g.video_set_id is not null) then
   if row_ids is null then update private.catalog_video_publication_jobs set validation_epoch_started_at=null where id=j.id and dispatched_at is null;return jsonb_build_object('state','waiting');end if;
   if exists(select 1 from private.catalog_publication_target_segments g where g.target_id=t.id and g.video_set_id is not null
       and private.catalog_video_recipe_consumer_allowed(g.video_set_id,j.team_id,g.recipe_revision,j.catalog_material_id,j.actor_id) is not true) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
   select jsonb_agg(case when g.video_set_id is null then private.catalog_publication_segment_source(j.team_id,j.catalog_material_id,t.id,g.ordinal)
      else (select jsonb_build_object('rowId',a.recipe_row_id,'materialId',output.id,'connectionId',output.connection_id,'sourceVersion',private.catalog_publication_source_version(output.id,j.team_id),'fileId',output.drive_file_id,'credentialId',oc.credential_id,'rootFolderId',oc.root_folder_id)
              from private.catalog_video_assignments a join private.catalog_video_variants v on v.video_set_id=a.video_set_id and v.video_variant_index=a.video_variant_index and v.state='registered'
              join public.team_materials output on output.id=v.output_material_id and output.team_id=j.team_id and output.lifecycle='active'
              join public.team_drive_connections oc on oc.id=output.connection_id and oc.team_id=j.team_id and oc.state='connected'
             where a.video_set_id=g.video_set_id and a.recipe_revision=g.recipe_revision and a.recipe_row_id::text=r.id) end order by r.ordinality) into source_rows
     from jsonb_array_elements_text(row_ids) with ordinality r(id,ordinality)
     join private.catalog_publication_target_segments g on g.target_id=t.id and r.ordinality-1 between g.row_start and g.row_start+g.row_count-1;
   if source_rows is null or jsonb_array_length(source_rows)<>catalog.product_count or exists(select 1 from jsonb_array_elements(source_rows) x where x.value='null'::jsonb) then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
  else
   select jsonb_agg(private.catalog_publication_segment_source(j.team_id,j.catalog_material_id,t.id,g.ordinal) order by g.ordinal) into source_rows
     from private.catalog_publication_target_segments g where g.target_id=t.id;
   if source_rows is null then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
  end if;
 elsif t.kind='video_set' then
  select * into s from private.catalog_video_sets where id=t.video_set_id and team_id=j.team_id;$repl$);

-- Public ids of a 'creatives' catalog come from its sheet like a single source's.
select private.patch_function_062('public.service_catalog_publication_cells_context(uuid,uuid)'::regprocedure,
  $find$and generated_cell.ordinality>2 and (t.kind='source' or $find$,
  $repl$and generated_cell.ordinality>2 and (t.kind in('source','creatives') or $repl$);
select private.patch_function_062('public.service_catalog_publication_cells_context(uuid,uuid)'::regprocedure,
  $find$ if (t.kind='source' or catalog.settings_snapshot->'_catalogRecipeRowIds'=row_ids)$find$,
  $repl$ if (t.kind in('source','creatives') or catalog.settings_snapshot->'_catalogRecipeRowIds'=row_ids)$repl$);

-- creativeKind and segments.
select private.patch_function_062('public.service_catalog_publication_cells_context(uuid,uuid)'::regprocedure,
  $find$'sources',source_rows,'sourceOnly',t.kind='source');$find$,
  $repl$'sources',source_rows,'sourceOnly',t.kind='source')||case when t.kind='creatives' then jsonb_build_object(
   'creativeKind',(select case when bool_or(g.kind='image') then 'image' else 'video' end from private.catalog_publication_target_segments g where g.target_id=t.id),
   'segments',(select jsonb_agg(jsonb_build_object('ordinal',g.ordinal,'kind',g.kind,'materialId',g.source_material_id,'rowStart',g.row_start,'rowCount',g.row_count) order by g.ordinal)
     from private.catalog_publication_target_segments g where g.target_id=t.id)) else '{}'::jsonb end;$repl$);

drop function private.patch_function_062(regprocedure, text, text);

commit;
