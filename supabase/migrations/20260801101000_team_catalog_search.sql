-- User Story 3: searchable, caller-isolated catalog and durable catalog worker controls.

alter table public.team_materials
  add constraint team_materials_landing_validation_state_check check (
    landing_validation_state is null
    or landing_validation_state in ('pending', 'validated', 'invalid', 'unavailable')
  ),
  add constraint team_materials_landing_validation_proof_check check (
    landing_validation_state <> 'validated'
    or (
      landing_validation_version is not null
      and landing_validation_fingerprint is not null
      and char_length(landing_validation_fingerprint) between 1 and 256
    )
  ),
  add constraint team_materials_transcript_identity_check check (
    transcript_ingest_state not in ('full', 'truncated')
    or transcript_source_version is not distinct from drive_version
  );

create or replace function private.refresh_team_material_search()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.search_tsv := pg_catalog.to_tsvector(
    'simple'::regconfig,
    pg_catalog.concat_ws(
      ' ',
      new.name,
      pg_catalog.regexp_replace(new.name, '[._/+:-]+', ' ', 'g'),
      pg_catalog.array_to_string(new.tags, ' '),
      new.geo,
      new.language,
      new.offer,
      new.transcript_text
    )
  );
  return new;
end;
$$;

revoke all on function private.refresh_team_material_search()
from public, anon, authenticated, service_role;

create trigger team_materials_refresh_search
before insert or update of name, tags, geo, language, offer, transcript_text
on public.team_materials
for each row execute function private.refresh_team_material_search();

update public.team_materials set updated_at = updated_at;

create index team_materials_search_gin_idx
  on public.team_materials using gin (search_tsv);
create index team_materials_geo_facet_idx
  on public.team_materials (team_id, lifecycle, geo);
create index team_materials_language_facet_idx
  on public.team_materials (team_id, lifecycle, language);
create index team_materials_offer_facet_idx
  on public.team_materials (team_id, lifecycle, lower(offer));
create index team_materials_category_facet_idx
  on public.team_materials (team_id, lifecycle, category);
create index team_materials_kind_facet_idx
  on public.team_materials (team_id, lifecycle, kind);
create index team_materials_original_type_facet_idx
  on public.team_materials (team_id, lifecycle, lower(mime_type), lower(file_extension));
create index team_materials_missing_geo_idx
  on public.team_materials (team_id, id) where lifecycle = 'active' and geo is null;
create index team_materials_missing_language_idx
  on public.team_materials (team_id, id) where lifecycle = 'active' and language is null;
create index team_materials_missing_offer_idx
  on public.team_materials (team_id, id) where lifecycle = 'active' and offer is null;

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
    '\s+', ' ', 'g'
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
      where drive.team_id = p_team and drive.state <> 'detached'
      order by drive.created_at desc
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

revoke all on function public.search_materials(uuid, text, jsonb, integer, integer)
from public, anon, authenticated, service_role;
grant execute on function public.search_materials(uuid, text, jsonb, integer, integer)
to authenticated;

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
  select pg_catalog.jsonb_build_object(
    'geo', (select pg_catalog.jsonb_agg(option.code order by option.code) from public.geo_options as option),
    'languages', (select pg_catalog.jsonb_agg(option.code order by option.code) from public.language_options as option),
    'offers', coalesce((
      select pg_catalog.jsonb_agg(offer.value order by pg_catalog.lower(offer.value))
      from (
        select min(material.offer) as value
        from public.team_materials as material
        where material.team_id = p_team and material.lifecycle = 'active' and material.offer is not null
        group by pg_catalog.lower(material.offer)
      ) as offer
    ), '[]'::jsonb),
    'tags', coalesce((
      select pg_catalog.jsonb_agg(tag.value order by pg_catalog.lower(tag.value))
      from (
        select min(value) as value
        from public.team_materials as material
        cross join lateral pg_catalog.unnest(material.tags) as valueset(value)
        where material.team_id = p_team and material.lifecycle = 'active'
        group by pg_catalog.lower(value)
      ) as tag
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke all on function public.get_team_vocab_and_facets(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.get_team_vocab_and_facets(uuid) to authenticated;

create or replace function public.update_material_metadata(
  p_team uuid,
  p_material uuid,
  p_patch jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_geo text;
  normalized_language text;
  normalized_offer text;
  normalized_tags text[] := '{}'::text[];
  seen_tags text[] := '{}'::text[];
  raw_tag jsonb;
  tag_value text;
  updated public.team_materials%rowtype;
begin
  if auth.uid() is null or not private.can(p_team, 'manage_metadata', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_patch is null or pg_catalog.jsonb_typeof(p_patch) <> 'object'
     or p_patch = '{}'::jsonb
     or exists (
       select 1 from pg_catalog.jsonb_object_keys(p_patch) as patch_key(key)
       where patch_key.key not in ('geo', 'language', 'offer', 'tags')
     ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  if p_patch ? 'geo' and p_patch -> 'geo' <> 'null'::jsonb then
    if pg_catalog.jsonb_typeof(p_patch -> 'geo') <> 'string' then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    normalized_geo := pg_catalog.upper(pg_catalog.btrim(p_patch ->> 'geo'));
    if not exists (select 1 from public.geo_options where code = normalized_geo) then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
  end if;

  if p_patch ? 'language' and p_patch -> 'language' <> 'null'::jsonb then
    if pg_catalog.jsonb_typeof(p_patch -> 'language') <> 'string' then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    select option.code into normalized_language
    from public.language_options as option
    where pg_catalog.lower(option.code) = pg_catalog.lower(pg_catalog.btrim(p_patch ->> 'language'));
    if normalized_language is null then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
  end if;

  if p_patch ? 'offer' and p_patch -> 'offer' <> 'null'::jsonb then
    if pg_catalog.jsonb_typeof(p_patch -> 'offer') <> 'string' then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    normalized_offer := pg_catalog.regexp_replace(
      normalize(p_patch ->> 'offer', NFC), '\s+', ' ', 'g'
    );
    normalized_offer := pg_catalog.btrim(normalized_offer);
    if char_length(normalized_offer) not between 1 and 160 then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
  end if;

  if p_patch ? 'tags' then
    if pg_catalog.jsonb_typeof(p_patch -> 'tags') <> 'array'
       or pg_catalog.jsonb_array_length(p_patch -> 'tags') > 50 then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    for raw_tag in select value from pg_catalog.jsonb_array_elements(p_patch -> 'tags') as entries(value)
    loop
      if pg_catalog.jsonb_typeof(raw_tag) <> 'string' then
        raise exception 'INVALID_INPUT' using errcode = '22023';
      end if;
      tag_value := pg_catalog.btrim(pg_catalog.regexp_replace(
        normalize(raw_tag #>> '{}', NFC), '\s+', ' ', 'g'
      ));
      if char_length(tag_value) not between 1 and 64 then
        raise exception 'INVALID_INPUT' using errcode = '22023';
      end if;
      if not (pg_catalog.lower(tag_value) = any(seen_tags)) then
        normalized_tags := pg_catalog.array_append(normalized_tags, tag_value);
        seen_tags := pg_catalog.array_append(seen_tags, pg_catalog.lower(tag_value));
      end if;
    end loop;
  end if;

  update public.team_materials as material
  set geo = case when p_patch ? 'geo' then normalized_geo else material.geo end,
      language = case when p_patch ? 'language' then normalized_language else material.language end,
      offer = case when p_patch ? 'offer' then normalized_offer else material.offer end,
      tags = case when p_patch ? 'tags' then normalized_tags else material.tags end,
      updated_at = clock_timestamp()
  where material.id = p_material
    and material.team_id = p_team
    and material.lifecycle = 'active'
  returning material.* into updated;
  if updated.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  perform private.record_team_audit(
    p_team, auth.uid(), 'material.metadata_updated',
    pg_catalog.jsonb_build_object('material_id', p_material), 'succeeded', null
  );
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (p_team, p_material, 'upserted');

  return pg_catalog.jsonb_build_object(
    'id', updated.id,
    'teamId', updated.team_id,
    'parentFolderId', updated.parent_folder_id,
    'name', updated.name,
    'kind', updated.kind,
    'category', updated.category,
    'mimeType', updated.mime_type,
    'fileExtension', updated.file_extension,
    'classificationVersion', updated.classification_version,
    'classificationSource', updated.classification_source,
    'sizeBytes', updated.size_bytes,
    'modifiedAt', updated.modified_at,
    'geo', updated.geo,
    'language', updated.language,
    'offer', updated.offer,
    'tags', updated.tags,
    'transcriptIngestState', updated.transcript_ingest_state,
    'transcriptTruncated', updated.transcript_truncated,
    'previewState', updated.preview_state,
    'lineage', pg_catalog.jsonb_build_object(
      'hasSource', exists (
        select 1 from public.team_material_links as link
        where link.team_id = p_team and link.derivative_material_id = p_material
      ),
      'hasDerivatives', exists (
        select 1 from public.team_material_links as link
        where link.team_id = p_team and link.source_material_id = p_material
      ),
      'isVersion', exists (
        select 1 from public.team_material_links as link
        where link.team_id = p_team and link.derivative_material_id = p_material and link.relation = 'version_of'
      )
    )
  );
end;
$$;

revoke all on function public.update_material_metadata(uuid, uuid, jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.update_material_metadata(uuid, uuid, jsonb) to authenticated;

-- Replace the initial-scan upsert with source-identity invalidation and restore behavior.
create or replace function public.service_upsert_catalog_page(
  p_connection uuid,
  p_parent_folder_id text,
  p_files jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_team uuid;
  affected integer;
begin
  if pg_catalog.jsonb_typeof(p_files) <> 'array' or pg_catalog.jsonb_array_length(p_files) > 1000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select connection.team_id into resolved_team
  from public.team_drive_connections as connection
  where connection.id = p_connection and connection.state <> 'detached';
  if resolved_team is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  insert into public.team_materials (
    team_id, connection_id, drive_file_id, drive_id, resource_key,
    parent_folder_id, name, mime_type, file_extension, kind,
    shortcut_target_id, shortcut_target_resource_key, category,
    classification_version, classification_source, size_bytes, modified_at,
    drive_version, checksum, lifecycle, transcript_ingest_state
  )
  select resolved_team, p_connection, item.drive_file_id, item.drive_id, item.resource_key,
         coalesce(item.parent_folder_id, p_parent_folder_id), item.name, item.mime_type,
         item.file_extension, item.kind, item.shortcut_target_id,
         item.shortcut_target_resource_key, item.category,
         coalesce(item.classification_version, 1),
         coalesce(item.classification_source, 'fallback'), item.size_bytes,
         nullif(item.modified_at, '')::timestamptz, item.drive_version, item.checksum,
         'active', case when item.category = 'transcript' then 'pending' else 'not_applicable' end
  from pg_catalog.jsonb_to_recordset(p_files) as item(
    drive_file_id text, drive_id text, resource_key text, parent_folder_id text,
    name text, mime_type text, file_extension text, kind text,
    shortcut_target_id text, shortcut_target_resource_key text, category text,
    classification_version integer, classification_source text, size_bytes bigint,
    modified_at text, drive_version text, checksum text
  )
  where char_length(item.drive_file_id) between 1 and 1024
    and char_length(item.name) between 1 and 1024
    and item.kind in ('file', 'folder', 'shortcut')
  on conflict (team_id, drive_file_id) do update
  set connection_id = excluded.connection_id,
      drive_id = excluded.drive_id,
      resource_key = excluded.resource_key,
      parent_folder_id = excluded.parent_folder_id,
      name = excluded.name,
      mime_type = excluded.mime_type,
      file_extension = excluded.file_extension,
      kind = excluded.kind,
      shortcut_target_id = excluded.shortcut_target_id,
      shortcut_target_resource_key = excluded.shortcut_target_resource_key,
      category = case
        when public.team_materials.landing_validation_state = 'validated'
          and public.team_materials.landing_validation_version is not distinct from excluded.drive_version
          and excluded.category = 'archive' then 'landing'
        else excluded.category end,
      classification_version = excluded.classification_version,
      classification_source = case
        when public.team_materials.landing_validation_state = 'validated'
          and public.team_materials.landing_validation_version is not distinct from excluded.drive_version
          and excluded.category = 'archive' then 'inspected_landing'
        else excluded.classification_source end,
      size_bytes = excluded.size_bytes,
      modified_at = excluded.modified_at,
      landing_validation_state = case
        when public.team_materials.drive_version is distinct from excluded.drive_version then null
        else public.team_materials.landing_validation_state end,
      landing_validation_version = case
        when public.team_materials.drive_version is distinct from excluded.drive_version then null
        else public.team_materials.landing_validation_version end,
      landing_validation_fingerprint = case
        when public.team_materials.drive_version is distinct from excluded.drive_version then null
        else public.team_materials.landing_validation_fingerprint end,
      transcript_text = case
        when public.team_materials.drive_version is distinct from excluded.drive_version
          or public.team_materials.checksum is distinct from excluded.checksum
          or public.team_materials.mime_type is distinct from excluded.mime_type
          or public.team_materials.file_extension is distinct from excluded.file_extension
          or excluded.category <> 'transcript' then null
        else public.team_materials.transcript_text end,
      transcript_ingest_state = case
        when excluded.category <> 'transcript' then 'not_applicable'
        when public.team_materials.drive_version is distinct from excluded.drive_version
          or public.team_materials.checksum is distinct from excluded.checksum
          or public.team_materials.mime_type is distinct from excluded.mime_type
          or public.team_materials.file_extension is distinct from excluded.file_extension then 'pending'
        else public.team_materials.transcript_ingest_state end,
      transcript_truncated = case
        when public.team_materials.drive_version is distinct from excluded.drive_version
          or public.team_materials.checksum is distinct from excluded.checksum
          or public.team_materials.mime_type is distinct from excluded.mime_type
          or public.team_materials.file_extension is distinct from excluded.file_extension
          or excluded.category <> 'transcript' then false
        else public.team_materials.transcript_truncated end,
      transcript_indexed_bytes = case
        when public.team_materials.drive_version is distinct from excluded.drive_version
          or public.team_materials.checksum is distinct from excluded.checksum
          or public.team_materials.mime_type is distinct from excluded.mime_type
          or public.team_materials.file_extension is distinct from excluded.file_extension
          or excluded.category <> 'transcript' then 0
        else public.team_materials.transcript_indexed_bytes end,
      transcript_error_code = case
        when public.team_materials.drive_version is distinct from excluded.drive_version
          or public.team_materials.checksum is distinct from excluded.checksum
          or public.team_materials.mime_type is distinct from excluded.mime_type
          or public.team_materials.file_extension is distinct from excluded.file_extension then null
        else public.team_materials.transcript_error_code end,
      drive_version = excluded.drive_version,
      checksum = excluded.checksum,
      lifecycle = 'active',
      trashed_at = null,
      missing_at = null,
      updated_at = clock_timestamp();
  get diagnostics affected = row_count;
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (resolved_team, null, 'upserted');
  return affected;
end;
$$;

revoke all on function public.service_upsert_catalog_page(uuid, text, jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.service_upsert_catalog_page(uuid, text, jsonb) to service_role;

create or replace function public.service_checkpoint_catalog_sync_job(
  p_job uuid,
  p_worker text,
  p_phase text,
  p_page_token text,
  p_change_token text,
  p_folder_queue jsonb,
  p_discovered_folders jsonb default '[]'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_phase not in ('initial_scan', 'change_replay', 'incremental', 'reconcile')
     or pg_catalog.jsonb_typeof(p_folder_queue) <> 'array'
     or pg_catalog.jsonb_typeof(p_discovered_folders) <> 'array' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update private.catalog_sync_jobs
  set phase = p_phase,
      cursor = pg_catalog.jsonb_build_object(
        'pageToken', p_page_token,
        'changePageToken', p_change_token,
        'discoveredFolders', p_discovered_folders
      ),
      folder_queue = p_folder_queue,
      state = 'pending',
      lease_owner = null,
      lease_expires_at = null,
      next_attempt_at = clock_timestamp(),
      last_error_code = null,
      updated_at = clock_timestamp()
  where id = p_job and lease_owner = p_worker and lease_expires_at > clock_timestamp();
  return found;
end;
$$;

revoke all on function public.service_checkpoint_catalog_sync_job(uuid, text, text, text, text, jsonb, jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.service_checkpoint_catalog_sync_job(uuid, text, text, text, text, jsonb, jsonb)
to service_role;

create or replace function public.service_complete_catalog_sync_job(
  p_job uuid,
  p_worker text,
  p_change_token text,
  p_next_phase text default 'incremental'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_team uuid;
  resolved_connection uuid;
begin
  if p_next_phase not in ('incremental', 'reconcile') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update private.catalog_sync_jobs as job
  set phase = p_next_phase,
      cursor = pg_catalog.jsonb_build_object(
        'pageToken', p_change_token,
        'changePageToken', p_change_token,
        'discoveredFolders', '[]'::jsonb
      ),
      folder_queue = '[]'::jsonb,
      state = 'pending',
      lease_owner = null,
      lease_expires_at = null,
      next_attempt_at = clock_timestamp() + interval '1 minute',
      last_error_code = null,
      updated_at = clock_timestamp()
  where job.id = p_job and job.lease_owner = p_worker and job.lease_expires_at > clock_timestamp()
  returning job.connection_id into resolved_connection;
  if resolved_connection is null then return false; end if;

  update public.team_drive_connections as connection
  set change_page_token = p_change_token,
      initial_sync_state = 'ready',
      last_synced_at = clock_timestamp(),
      last_error_code = null,
      updated_at = clock_timestamp()
  where connection.id = resolved_connection
  returning connection.team_id into resolved_team;
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (resolved_team, null, 'sync_state');
  return true;
end;
$$;

revoke all on function public.service_complete_catalog_sync_job(uuid, text, text, text)
from public, anon, authenticated, service_role;
grant execute on function public.service_complete_catalog_sync_job(uuid, text, text, text)
to service_role;

create or replace function public.service_retry_catalog_sync_job(
  p_job uuid,
  p_worker text,
  p_error_code text,
  p_next_attempt_at timestamptz,
  p_permanent boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_connection uuid;
begin
  update private.catalog_sync_jobs as job
  set state = case when p_permanent then 'failed' else 'retry' end,
      last_error_code = pg_catalog.left(coalesce(p_error_code, 'DRIVE_UNAVAILABLE'), 96),
      next_attempt_at = case when p_permanent then job.next_attempt_at else p_next_attempt_at end,
      lease_owner = null,
      lease_expires_at = null,
      completed_at = case when p_permanent then clock_timestamp() else null end,
      updated_at = clock_timestamp()
  where job.id = p_job and job.lease_owner = p_worker
  returning job.connection_id into resolved_connection;
  if resolved_connection is null then return false; end if;
  if p_permanent then
    update public.team_drive_connections
    set initial_sync_state = 'failed', last_error_code = pg_catalog.left(p_error_code, 96),
        updated_at = clock_timestamp()
    where id = resolved_connection;
  end if;
  return true;
end;
$$;

revoke all on function public.service_retry_catalog_sync_job(uuid, text, text, timestamptz, boolean)
from public, anon, authenticated, service_role;
grant execute on function public.service_retry_catalog_sync_job(uuid, text, text, timestamptz, boolean)
to service_role;

create or replace function public.service_tombstone_catalog_files(
  p_connection uuid,
  p_items jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_team uuid;
  affected integer;
begin
  if pg_catalog.jsonb_typeof(p_items) <> 'array' or pg_catalog.jsonb_array_length(p_items) > 1000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select team_id into resolved_team from public.team_drive_connections where id = p_connection;
  if resolved_team is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  update public.team_materials as material
  set lifecycle = item.lifecycle,
      trashed_at = case when item.lifecycle = 'trashed' then clock_timestamp() else null end,
      missing_at = case when item.lifecycle = 'missing' then clock_timestamp() else null end,
      transcript_text = null,
      transcript_ingest_state = 'unavailable',
      transcript_truncated = false,
      transcript_indexed_bytes = 0,
      transcript_error_code = case when item.lifecycle = 'trashed' then 'SOURCE_TRASHED' else 'SOURCE_MISSING' end,
      updated_at = clock_timestamp()
  from pg_catalog.jsonb_to_recordset(p_items) as item(file_id text, lifecycle text)
  where material.connection_id = p_connection
    and material.team_id = resolved_team
    and material.drive_file_id = item.file_id
    and item.lifecycle in ('trashed', 'missing');
  get diagnostics affected = row_count;
  if affected > 0 then
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    values (resolved_team, null, 'tombstoned');
  end if;
  return affected;
end;
$$;

revoke all on function public.service_tombstone_catalog_files(uuid, jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.service_tombstone_catalog_files(uuid, jsonb) to service_role;

create or replace function public.service_requeue_catalog_transcripts(
  p_connection uuid,
  p_files jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  if pg_catalog.jsonb_typeof(p_files) <> 'array' or pg_catalog.jsonb_array_length(p_files) > 1000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update public.team_materials as material
  set transcript_text = null,
      transcript_ingest_state = 'pending',
      transcript_truncated = false,
      transcript_indexed_bytes = 0,
      transcript_error_code = null,
      transcript_source_version = null,
      transcript_source_checksum = null,
      updated_at = clock_timestamp()
  from pg_catalog.jsonb_to_recordset(p_files) as item(
    drive_file_id text, drive_version text, checksum text, mime_type text, file_extension text
  )
  where material.connection_id = p_connection
    and material.drive_file_id = item.drive_file_id
    and material.lifecycle = 'active'
    and material.category = 'transcript'
    and (
      material.transcript_source_version is distinct from item.drive_version
      or material.transcript_source_checksum is distinct from item.checksum
      or material.transcript_ingest_state in ('pending', 'unavailable', 'invalid_encoding')
    );
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.service_requeue_catalog_transcripts(uuid, jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.service_requeue_catalog_transcripts(uuid, jsonb) to service_role;

create or replace function public.service_list_pending_catalog_transcripts(
  p_connection uuid,
  p_file_ids jsonb
)
returns table (
  material_id uuid,
  drive_file_id text,
  resource_key text,
  drive_version text,
  checksum text,
  mime_type text,
  file_extension text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if pg_catalog.jsonb_typeof(p_file_ids) <> 'array'
     or pg_catalog.jsonb_array_length(p_file_ids) > 1000
     or exists (
       select 1 from pg_catalog.jsonb_array_elements(p_file_ids) as entry(value)
       where pg_catalog.jsonb_typeof(entry.value) <> 'string'
     ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return query
  select material.id, material.drive_file_id, material.resource_key,
         material.drive_version, material.checksum, material.mime_type, material.file_extension
  from public.team_materials as material
  where material.connection_id = p_connection
    and material.lifecycle = 'active'
    and material.category = 'transcript'
    and material.transcript_ingest_state = 'pending'
    and material.drive_file_id in (
      select value from pg_catalog.jsonb_array_elements_text(p_file_ids) as ids(value)
    );
end;
$$;

revoke all on function public.service_list_pending_catalog_transcripts(uuid, jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.service_list_pending_catalog_transcripts(uuid, jsonb) to service_role;

create or replace function public.service_commit_catalog_transcript(
  p_material uuid,
  p_expected_version text,
  p_expected_checksum text,
  p_expected_mime_type text,
  p_expected_extension text,
  p_state text,
  p_text text,
  p_indexed_bytes integer,
  p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_team uuid;
begin
  if p_state not in ('full', 'truncated', 'invalid_encoding', 'unavailable')
     or p_indexed_bytes not between 0 and 1048576
     or (p_text is not null and pg_catalog.octet_length(p_text) > 1048576) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update public.team_materials as material
  set transcript_text = case when p_state in ('full', 'truncated') then p_text else null end,
      transcript_ingest_state = p_state,
      transcript_truncated = p_state = 'truncated',
      transcript_indexed_bytes = p_indexed_bytes,
      transcript_source_version = p_expected_version,
      transcript_source_checksum = p_expected_checksum,
      transcript_ingested_at = clock_timestamp(),
      transcript_error_code = p_error_code,
      updated_at = clock_timestamp()
  where material.id = p_material
    and material.lifecycle = 'active'
    and material.category = 'transcript'
    and material.drive_version is not distinct from p_expected_version
    and material.checksum is not distinct from p_expected_checksum
    and material.mime_type is not distinct from p_expected_mime_type
    and material.file_extension is not distinct from p_expected_extension
  returning material.team_id into resolved_team;
  if resolved_team is null then return false; end if;
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (resolved_team, p_material, 'upserted');
  return true;
end;
$$;

revoke all on function public.service_commit_catalog_transcript(uuid, text, text, text, text, text, text, integer, text)
from public, anon, authenticated, service_role;
grant execute on function public.service_commit_catalog_transcript(uuid, text, text, text, text, text, text, integer, text)
to service_role;

create or replace function public.service_enqueue_catalog_reconciliation(p_connection uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_job uuid;
  token text;
begin
  select connection.change_page_token into token
  from public.team_drive_connections as connection
  where connection.id = p_connection and connection.state <> 'detached';
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  insert into private.catalog_sync_jobs (connection_id, phase, cursor, folder_queue)
  values (
    p_connection, 'initial_scan',
    pg_catalog.jsonb_build_object('pageToken', null, 'changePageToken', token, 'discoveredFolders', '[]'::jsonb),
    '[]'::jsonb
  ) returning id into created_job;
  return created_job;
end;
$$;

revoke all on function public.service_enqueue_catalog_reconciliation(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.service_enqueue_catalog_reconciliation(uuid) to service_role;

-- One global schedule invokes a bounded worker. Both endpoint and worker key are
-- named Vault secrets; absent local secrets make the invocation a safe no-op.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create or replace function private.invoke_catalog_sync_worker()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  endpoint text;
  worker_secret text;
  request_id bigint;
begin
  select secret.decrypted_secret into endpoint
  from vault.decrypted_secrets as secret
  where secret.name = 'wishly_catalog_sync_url'
  order by secret.created_at desc limit 1;
  select secret.decrypted_secret into worker_secret
  from vault.decrypted_secrets as secret
  where secret.name = 'wishly_catalog_sync_secret'
  order by secret.created_at desc limit 1;
  if endpoint is null or endpoint !~ '^https?://' or worker_secret is null
     or char_length(worker_secret) < 32 then
    return null;
  end if;
  select net.http_post(
    url := endpoint,
    headers := pg_catalog.jsonb_build_object(
      'content-type', 'application/json',
      'x-catalog-sync-secret', worker_secret
    ),
    body := '{"scheduled":true}'::jsonb,
    timeout_milliseconds := 5000
  ) into request_id;
  return request_id;
end;
$$;

revoke all on function private.invoke_catalog_sync_worker()
from public, anon, authenticated, service_role;

select cron.unschedule(job.jobid)
from cron.job as job
where job.jobname = 'wishly-catalog-sync';

select cron.schedule(
  'wishly-catalog-sync',
  '* * * * *',
  $cron$select private.invoke_catalog_sync_worker()$cron$
);

comment on function public.search_materials(uuid, text, jsonb, integer, integer) is
  'Caller-checked exact-team catalog search; transcript bodies and provider identifiers are excluded.';
comment on function public.update_material_metadata(uuid, uuid, jsonb) is
  'Metadata-only Wishly write surface; Drive identity, content, lifecycle, and transcript fields are immutable here.';
