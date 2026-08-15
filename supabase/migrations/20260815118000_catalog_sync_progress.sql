-- A connected Drive folder scans breadth-first, so a true completion percentage
-- is impossible: the tree size is unknown until the walk finishes. Members were
-- left staring at a static "scanning…" line with no way to tell a live scan from
-- a stuck one. Extend the catalog freshness payload with the liveness signals we
-- can honestly report — how many items have been discovered so far (unfiltered by
-- the caller's query, so a landings-only view still shows the scan is working),
-- how many folders remain queued for the initial scan, and when the sync last
-- made progress — so the UI can render an alive, self-updating indicator.

create or replace function public.search_materials(
  p_team uuid,
  p_query text default null,
  p_filters jsonb default '{}'::jsonb,
  p_page integer default 1,
  p_page_size integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_query text;
  query_value tsquery;
  geo_filters text[];
  language_filters text[];
  offer_filters text[];
  category_filters text[];
  original_type_filters text[];
  kind_filters text[];
  unfilled_filters text[];
  result jsonb;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_page not between 1 and 1000000 or p_page_size not between 1 and 100 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_query is not null and char_length(p_query) > 240 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_filters, '{}'::jsonb)) <> 'object'
     or exists (
       select 1 from pg_catalog.jsonb_each(coalesce(p_filters, '{}'::jsonb)) as entry
       where entry.key not in (
         'geo', 'language', 'offer', 'category', 'originalType', 'kind', 'unfilled'
       ) or pg_catalog.jsonb_typeof(entry.value) <> 'array'
     )
     or exists (
       select 1
       from pg_catalog.jsonb_each(coalesce(p_filters, '{}'::jsonb)) as entry
       cross join lateral pg_catalog.jsonb_array_elements(entry.value) as element(value)
       where pg_catalog.jsonb_typeof(element.value) <> 'string'
     ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  normalized_query := pg_catalog.regexp_replace(
    normalize(coalesce(p_query, ''), NFC),
    '\\s+', ' ', 'g'
  );
  normalized_query := pg_catalog.btrim(normalized_query);
  query_value := case when normalized_query = '' then null
    else pg_catalog.websearch_to_tsquery('simple'::regconfig, normalized_query) end;

  select coalesce(pg_catalog.array_agg(pg_catalog.upper(value)), '{}'::text[])
    into geo_filters
  from pg_catalog.jsonb_array_elements_text(coalesce(p_filters -> 'geo', '[]'::jsonb)) as valueset(value);
  select coalesce(pg_catalog.array_agg(value), '{}'::text[])
    into language_filters
  from pg_catalog.jsonb_array_elements_text(coalesce(p_filters -> 'language', '[]'::jsonb)) as valueset(value);
  select coalesce(pg_catalog.array_agg(pg_catalog.lower(value)), '{}'::text[])
    into offer_filters
  from pg_catalog.jsonb_array_elements_text(coalesce(p_filters -> 'offer', '[]'::jsonb)) as valueset(value);
  select coalesce(pg_catalog.array_agg(pg_catalog.lower(value)), '{}'::text[])
    into category_filters
  from pg_catalog.jsonb_array_elements_text(coalesce(p_filters -> 'category', '[]'::jsonb)) as valueset(value);
  select coalesce(pg_catalog.array_agg(pg_catalog.lower(pg_catalog.ltrim(value, '.'))), '{}'::text[])
    into original_type_filters
  from pg_catalog.jsonb_array_elements_text(coalesce(p_filters -> 'originalType', '[]'::jsonb)) as valueset(value);
  select coalesce(pg_catalog.array_agg(pg_catalog.lower(value)), '{}'::text[])
    into kind_filters
  from pg_catalog.jsonb_array_elements_text(coalesce(p_filters -> 'kind', '[]'::jsonb)) as valueset(value);
  select coalesce(pg_catalog.array_agg(pg_catalog.lower(value)), '{}'::text[])
    into unfilled_filters
  from pg_catalog.jsonb_array_elements_text(coalesce(p_filters -> 'unfilled', '[]'::jsonb)) as valueset(value);

  if exists (select 1 from pg_catalog.unnest(geo_filters) as value where value not in (select code from public.geo_options))
     or exists (select 1 from pg_catalog.unnest(language_filters) as value where value not in (select code from public.language_options))
     or exists (select 1 from pg_catalog.unnest(category_filters) as value where value not in ('video','image','archive','transcript','landing','other'))
     or exists (select 1 from pg_catalog.unnest(kind_filters) as value where value not in ('file','folder','shortcut'))
     or exists (select 1 from pg_catalog.unnest(unfilled_filters) as value where value not in ('geo','language','offer')) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  with filtered as materialized (
    select material.*,
           case when query_value is null then 0::real
             else pg_catalog.ts_rank(material.search_tsv, query_value) end as relevance
    from public.team_materials as material
    join public.team_drive_connections as connection
      on connection.id = material.connection_id
     and connection.team_id = material.team_id
     and connection.state = 'connected'
    where material.team_id = p_team
      and material.lifecycle = 'active'
      and (query_value is null or material.search_tsv @@ query_value)
      and (cardinality(geo_filters) = 0 or material.geo = any(geo_filters))
      and (cardinality(language_filters) = 0 or material.language = any(language_filters))
      and (cardinality(offer_filters) = 0 or pg_catalog.lower(material.offer) = any(offer_filters))
      and (cardinality(category_filters) = 0 or material.category = any(category_filters))
      and (cardinality(kind_filters) = 0 or material.kind = any(kind_filters))
      and (
        cardinality(original_type_filters) = 0
        or pg_catalog.lower(material.mime_type) = any(original_type_filters)
        or pg_catalog.lower(material.file_extension) = any(original_type_filters)
      )
      and (
        cardinality(unfilled_filters) = 0
        or ('geo' = any(unfilled_filters) and material.geo is null)
        or ('language' = any(unfilled_filters) and material.language is null)
        or ('offer' = any(unfilled_filters) and material.offer is null)
      )
  ), paged as (
    select material.*,
           pg_catalog.row_number() over (
             order by material.relevance desc, material.modified_at desc nulls last,
                      pg_catalog.lower(material.name), material.id
           ) as ordinal
    from filtered as material
    order by material.relevance desc, material.modified_at desc nulls last,
             pg_catalog.lower(material.name), material.id
    offset (p_page - 1) * p_page_size
    limit p_page_size
  ), item_payload as (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', material.id,
          'teamId', material.team_id,
          'parentFolderId', material.parent_folder_id,
          'name', material.name,
          'kind', material.kind,
          'category', material.category,
          'mimeType', material.mime_type,
          'fileExtension', material.file_extension,
          'classificationVersion', material.classification_version,
          'classificationSource', material.classification_source,
          'sizeBytes', material.size_bytes,
          'modifiedAt', material.modified_at,
          'geo', material.geo,
          'language', material.language,
          'offer', material.offer,
          'tags', material.tags,
          'transcriptIngestState', material.transcript_ingest_state,
          'transcriptTruncated', material.transcript_truncated,
          'previewState', material.preview_state,
          'lineage', pg_catalog.jsonb_build_object(
            'hasSource', exists (
              select 1 from public.team_material_links as link
              where link.team_id = p_team and link.derivative_material_id = material.id
            ),
            'hasDerivatives', exists (
              select 1 from public.team_material_links as link
              where link.team_id = p_team and link.source_material_id = material.id
            ),
            'isVersion', exists (
              select 1 from public.team_material_links as link
              where link.team_id = p_team
                and link.derivative_material_id = material.id
                and link.relation = 'version_of'
            )
          )
        ) order by material.ordinal
      ), '[]'::jsonb
    ) as items
    from paged as material
  ), facet_payload as (
    select pg_catalog.jsonb_build_object(
      'geo', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('value', facet.value, 'count', facet.count) order by facet.value)
        from (select geo as value, count(*) as count from filtered where geo is not null group by geo) as facet
      ), '[]'::jsonb),
      'language', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('value', facet.value, 'count', facet.count) order by facet.value)
        from (select language as value, count(*) as count from filtered where language is not null group by language) as facet
      ), '[]'::jsonb),
      'offer', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('value', facet.value, 'count', facet.count) order by pg_catalog.lower(facet.value))
        from (select min(offer) as value, count(*) as count from filtered where offer is not null group by pg_catalog.lower(offer)) as facet
      ), '[]'::jsonb),
      'category', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('value', facet.value, 'count', facet.count) order by facet.value)
        from (select category as value, count(*) as count from filtered where category is not null group by category) as facet
      ), '[]'::jsonb),
      'originalType', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('value', facet.value, 'count', facet.count) order by facet.value)
        from (
          select coalesce(mime_type, file_extension) as value, count(*) as count
          from filtered where coalesce(mime_type, file_extension) is not null
          group by coalesce(mime_type, file_extension)
        ) as facet
      ), '[]'::jsonb),
      'kind', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('value', facet.value, 'count', facet.count) order by facet.value)
        from (select kind as value, count(*) as count from filtered group by kind) as facet
      ), '[]'::jsonb)
    ) as facets
  ), freshness as (
    select
      coalesce(connection.initial_sync_state, 'not_started') as state,
      connection.last_synced_at,
      -- Unfiltered so a category-scoped view (e.g. landings only) still proves
      -- the scan is finding things while its own matches are still zero.
      coalesce((
        select count(*)
        from public.team_materials as discovered
        where discovered.team_id = p_team
          and discovered.connection_id = connection.id
          and discovered.lifecycle = 'active'
      ), 0) as discovered_count,
      -- Folders still queued for the breadth-first walk; null once the initial
      -- scan is no longer in flight (replaying, ready, or never started).
      (
        select pg_catalog.jsonb_array_length(job.folder_queue)
        from private.catalog_sync_jobs as job
        where job.connection_id = connection.id
          and job.phase = 'initial_scan'
          and job.state in ('pending', 'retry', 'leased')
        order by job.created_at desc
        limit 1
      ) as folders_remaining,
      greatest(
        connection.updated_at,
        (
          select max(job.updated_at)
          from private.catalog_sync_jobs as job
          where job.connection_id = connection.id
        )
      ) as last_progress_at
    from (select 1) as singleton
    left join lateral (
      select drive.id, drive.initial_sync_state, drive.last_synced_at, drive.updated_at
      from public.team_drive_connections as drive
      where drive.team_id = p_team and drive.state = 'connected'
      limit 1
    ) as connection on true
  )
  select pg_catalog.jsonb_build_object(
    'items', item_payload.items,
    'total', (select count(*) from filtered),
    'activeFilters', coalesce(p_filters, '{}'::jsonb),
    'facets', facet_payload.facets,
    'catalogFreshness', pg_catalog.jsonb_build_object(
      'state', freshness.state,
      'lastSyncedAt', freshness.last_synced_at,
      'discoveredCount', freshness.discovered_count,
      'foldersRemaining', freshness.folders_remaining,
      'lastProgressAt', freshness.last_progress_at
    )
  ) into result
  from item_payload cross join facet_payload cross join freshness;
  return result;
end;
$$;
