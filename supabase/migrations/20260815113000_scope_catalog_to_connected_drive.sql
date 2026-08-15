-- A replaced or detached Drive root is historical catalog data, not a readable
-- workspace source. Keep every caller-facing catalog and preview path scoped to
-- the one currently connected root so a stale item can never look corrupt just
-- because its former Drive authority is no longer available.

create or replace function public.list_team_materials(
  p_team uuid,
  p_parent_folder_id text default null
)
returns table (
  id uuid,
  team_id uuid,
  drive_file_id text,
  parent_folder_id text,
  name text,
  kind text,
  category text,
  mime_type text,
  file_extension text,
  size_bytes bigint,
  modified_at timestamptz,
  preview_state text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  active_connection_id uuid;
  resolved_parent_folder_id text;
begin
  if not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  select connection.id, connection.root_folder_id
    into active_connection_id, resolved_parent_folder_id
  from public.team_drive_connections as connection
  where connection.team_id = p_team
    and connection.state = 'connected'
  limit 1;

  resolved_parent_folder_id := coalesce(p_parent_folder_id, resolved_parent_folder_id);

  return query
  select material.id,
         material.team_id,
         material.drive_file_id,
         material.parent_folder_id,
         material.name,
         material.kind,
         material.category,
         material.mime_type,
         material.file_extension,
         material.size_bytes,
         material.modified_at,
         material.preview_state
  from public.team_materials as material
  where material.team_id = p_team
    and material.connection_id = active_connection_id
    and material.lifecycle = 'active'
    and material.parent_folder_id is not distinct from resolved_parent_folder_id
  order by material.kind desc, lower(material.name), material.id
  limit 500;
end;
$$;

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
    select coalesce(connection.initial_sync_state, 'not_started') as state,
           connection.last_synced_at
    from (select 1) as singleton
    left join lateral (
      select drive.initial_sync_state, drive.last_synced_at
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
      'lastSyncedAt', freshness.last_synced_at
    )
  ) into result
  from item_payload cross join facet_payload cross join freshness;
  return result;
end;
$$;

create or replace function public.get_team_vocab_and_facets(p_team uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  with current_materials as materialized (
    select material.*
    from public.team_materials as material
    join public.team_drive_connections as connection
      on connection.id = material.connection_id
     and connection.team_id = material.team_id
     and connection.state = 'connected'
    where material.team_id = p_team
      and material.lifecycle = 'active'
  )
  select pg_catalog.jsonb_build_object(
    'geo', (select pg_catalog.jsonb_agg(option.code order by option.code) from public.geo_options as option),
    'languages', (select pg_catalog.jsonb_agg(option.code order by option.code) from public.language_options as option),
    'offers', coalesce((
      select pg_catalog.jsonb_agg(offer.value order by pg_catalog.lower(offer.value))
      from (
        select min(material.offer) as value
        from current_materials as material
        where material.offer is not null
        group by pg_catalog.lower(material.offer)
      ) as offer
    ), '[]'::jsonb),
    'tags', coalesce((
      select pg_catalog.jsonb_agg(tag.value order by pg_catalog.lower(tag.value))
      from (
        select min(value) as value
        from current_materials as material
        cross join lateral pg_catalog.unnest(material.tags) as valueset(value)
        group by pg_catalog.lower(value)
      ) as tag
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

create or replace function public.list_library_materials(
  p_team uuid,
  p_stage text,
  p_cursor uuid default null,
  p_page_size integer default 50
)
returns table (
  id uuid,
  team_id uuid,
  name text,
  category text,
  mime_type text,
  file_extension text,
  size_bytes bigint,
  lifecycle text,
  source_version text,
  stage text,
  offer text,
  language text,
  type text,
  placement_state text,
  language_decision_source text,
  thumbnail_state text,
  thumbnail_time_ms integer,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  active_connection_id uuid;
  cursor_created_at timestamptz;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_stage not in ('finds','library') or p_page_size not between 1 and 100 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  select connection.id into active_connection_id
  from public.team_drive_connections as connection
  where connection.team_id = p_team
    and connection.state = 'connected'
  limit 1;

  if p_cursor is not null then
    select material.created_at into cursor_created_at
    from public.team_materials as material
    where material.id = p_cursor
      and material.team_id = p_team
      and material.connection_id = active_connection_id
      and (
        material.library_stage = p_stage
        or (p_stage = 'finds' and material.library_stage is null)
      );
    if cursor_created_at is null then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  end if;

  return query
  select material.id, material.team_id, material.name, material.category,
         material.mime_type, material.file_extension, material.size_bytes,
         material.lifecycle,
         coalesce(nullif(material.drive_version,''), nullif(material.checksum,'')),
         coalesce(material.library_stage, 'finds'),
         coalesce(material.structural_offer, 'unknown'),
         coalesce(material.structural_language, 'unknown'),
         coalesce(material.structural_type, 'Unknown'), material.placement_state,
         material.language_decision_source, material.thumbnail_state,
         material.thumbnail_time_ms, material.created_at
  from public.team_materials as material
  where material.team_id = p_team
    and material.connection_id = active_connection_id
    and material.kind = 'file'
    and (
      material.library_stage = p_stage
      or (p_stage = 'finds' and material.library_stage is null)
    )
    and (p_cursor is null or (material.created_at, material.id) < (cursor_created_at, p_cursor))
  order by material.created_at desc, material.id desc
  limit p_page_size;
end;
$$;

create or replace function public.service_get_library_asset_placement(
  p_team uuid,
  p_actor uuid,
  p_material uuid
)
returns table (
  material_id uuid,
  placement_revision bigint,
  stage text,
  offer text,
  language text,
  type text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.can(p_team, 'edit', p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
  select material.id, material.placement_revision,
         coalesce(material.library_stage, 'finds'),
         coalesce(material.structural_offer, material.offer, 'unknown'),
         coalesce(material.structural_language, material.language, 'unknown'),
         coalesce(material.structural_type, initcap(coalesce(material.category, 'unknown')))
  from public.team_materials as material
  join public.team_drive_connections as connection
    on connection.id = material.connection_id
   and connection.team_id = material.team_id
   and connection.state = 'connected'
  where material.id = p_material
    and material.team_id = p_team
    and material.kind = 'file'
    and material.lifecycle = 'active'
    and (material.library_stage in ('finds','library') or material.library_stage is null);
end;
$$;

create or replace function public.get_material_preview(
  p_team uuid,
  p_material uuid
)
returns table (
  team_id uuid,
  material_id uuid,
  drive_file_id text,
  resource_key text,
  name text,
  category text,
  mime_type text,
  file_extension text,
  size_bytes bigint,
  drive_version text,
  checksum text,
  preview_state text,
  preview_error_code text,
  transcript_text text,
  transcript_ingest_state text,
  transcript_truncated boolean,
  transcript_indexed_bytes integer,
  transcript_source_version text,
  can_download boolean,
  can_edit boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
  select material.team_id,
         material.id,
         material.drive_file_id,
         material.resource_key,
         material.name,
         material.category,
         material.mime_type,
         material.file_extension,
         material.size_bytes,
         material.drive_version,
         material.checksum,
         material.preview_state,
         material.preview_error_code,
         material.transcript_text,
         material.transcript_ingest_state,
         material.transcript_truncated,
         material.transcript_indexed_bytes,
         material.transcript_source_version,
         private.can(p_team, 'download', auth.uid()),
         private.can(p_team, 'edit', auth.uid())
  from public.team_materials as material
  join public.team_drive_connections as connection
    on connection.id = material.connection_id
   and connection.team_id = material.team_id
   and connection.state = 'connected'
  where material.id = p_material
    and material.team_id = p_team
    and material.kind = 'file'
    and material.lifecycle = 'active'
  limit 1;
end;
$$;

create or replace function public.list_landing_renders(
  p_team uuid,
  p_material_ids uuid[],
  p_preset text
)
returns table (
  material_id uuid,
  render_state text,
  valid boolean,
  preset text,
  segment_count integer,
  failure_reason text,
  source_version text,
  source_checksum text,
  fingerprint text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  return query
  with projected as (
    select render.*,
           case
             when render.render_state = 'rendering'
               and render.updated_at < pg_catalog.now() - interval '4 minutes'
               then 'failed'
             else render.render_state
           end as effective_render_state,
           case
             when render.render_state = 'rendering'
               and render.updated_at < pg_catalog.now() - interval '4 minutes'
               then 'render_error'
             else render.failure_reason
           end as effective_failure_reason
    from public.team_landing_renders as render
    where render.team_id = p_team
      and render.material_id = any (p_material_ids)
      and render.preset = p_preset
  )
  select projected.material_id,
         projected.effective_render_state,
         (
           projected.effective_render_state = 'ready'
           and projected.artifact_root is not null
           and projected.segment_count >= 1
           and projected.source_version is not distinct from material.drive_version
           and projected.source_checksum is not distinct from material.checksum
         ) as valid,
         projected.preset,
         projected.segment_count,
         projected.effective_failure_reason,
         projected.source_version,
         projected.source_checksum,
         projected.fingerprint
  from projected
  join public.team_materials as material
    on material.id = projected.material_id
   and material.team_id = projected.team_id
  join public.team_drive_connections as connection
    on connection.id = material.connection_id
   and connection.team_id = material.team_id
   and connection.state = 'connected';
end;
$$;

comment on function public.list_team_materials(uuid, text) is
  'Caller-checked catalog listing; material rows are scoped to the currently connected Drive root.';
comment on function public.list_library_materials(uuid, text, uuid, integer) is
  'Caller-checked Creative Library listing; only files from the currently connected Drive root are browseable.';
