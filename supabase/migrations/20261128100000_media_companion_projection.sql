-- Feature 012 (T003, T004, T007) — the transcript companion is visible where the file is listed,
-- remembers whose audio it describes, and can be reused for the same audio.
--
--   * private.has_readable_transcript — a video has a live, linked transcript with text in it.
--     The folder page and the catalog search carry it per row (`hasTranscriptCompanion`), with
--     `companionOf` / `companionKind` on search results too, so a surface can show the state
--     without asking once per file.
--   * service_link_transcript_companion — when the agent reports the decoded-audio fingerprint
--     (T004) it is stamped on the video as well as on its transcript; a link without one (a copy,
--     an older agent) inherits the video's, instead of wiping what the companion knew.
--   * find_reusable_transcript — compute-time dedup (FR-T2): another video in the space with the
--     same bytes (Drive checksum) or the same decoded audio (fingerprint) already has text, so the
--     caller copies that transcript rather than running whisper again. Re-transcribe (T007) simply
--     does not ask.
--
-- Forward-only; ROLLBACK.md re-applies the listings from 20260918160000 / 20260918100000 and the
-- link from 20260902090000.

create index if not exists team_materials_active_checksum_idx
  on public.team_materials (team_id, checksum)
  where checksum is not null and lifecycle = 'active';

create or replace function private.has_readable_transcript(p_team uuid, p_video uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.team_materials as companion
    where companion.team_id = p_team
      and companion.companion_of = p_video
      and companion.companion_kind = 'transcript'
      and companion.lifecycle = 'active'
      and companion.transcript_ingest_state in ('full', 'truncated')
  );
$$;

revoke all on function private.has_readable_transcript(uuid, uuid) from public, anon, authenticated;

create or replace function public.service_link_transcript_companion(
  p_team uuid,
  p_video uuid,
  p_companion uuid,
  p_fingerprint text,
  p_text text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  video_row public.team_materials%rowtype;
  companion_row public.team_materials%rowtype;
  retired jsonb;
begin
  if p_fingerprint is not null and p_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into video_row from public.team_materials as material
  where material.id = p_video and material.team_id = p_team and material.lifecycle = 'active'
  for update;
  select * into companion_row from public.team_materials as material
  where material.id = p_companion and material.team_id = p_team and material.lifecycle = 'active'
  for update;
  if video_row.id is null
     or companion_row.id is null
     or video_row.category is distinct from 'video'
     or companion_row.category is distinct from 'transcript' then
    return jsonb_build_object('linked', false, 'retired', '[]'::jsonb);
  end if;

  -- The video keeps one live transcript companion: retire any earlier one, and
  -- report it so the file itself can follow the catalog row into the trash.
  with retired_rows as (
    update public.team_materials as previous
       set lifecycle = 'trashed',
           trashed_at = pg_catalog.clock_timestamp(),
           companion_of = null,
           companion_kind = null,
           updated_at = pg_catalog.clock_timestamp()
     where previous.team_id = p_team
       and previous.companion_of = p_video
       and previous.companion_kind = 'transcript'
       and previous.lifecycle = 'active'
       and previous.id <> p_companion
    returning previous.id, previous.drive_file_id, previous.resource_key
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'materialId', retired_rows.id,
               'driveFileId', retired_rows.drive_file_id,
               'resourceKey', retired_rows.resource_key
             )
           ),
           '[]'::jsonb
         )
    into retired
  from retired_rows;

  -- The fingerprint describes the video's audio, so the video carries it too: the next
  -- identical audio finds this text through either row.
  if p_fingerprint is not null then
    update public.team_materials as video
       set audio_fingerprint = p_fingerprint,
           updated_at = pg_catalog.clock_timestamp()
     where video.id = p_video and video.team_id = p_team;
  end if;

  update public.team_materials as companion
     set companion_of = p_video,
         companion_kind = 'transcript',
         audio_fingerprint = coalesce(p_fingerprint, video_row.audio_fingerprint),
         transcript_text = coalesce(p_text, companion.transcript_text),
         transcript_ingest_state = case
           when p_text is not null and length(btrim(p_text)) > 0 then 'full'
           else companion.transcript_ingest_state end,
         transcript_source_version = case
           when p_text is not null and length(btrim(p_text)) > 0 then companion.drive_version
           else companion.transcript_source_version end,
         transcript_source_checksum = case
           when p_text is not null and length(btrim(p_text)) > 0 then companion.checksum
           else companion.transcript_source_checksum end,
         updated_at = pg_catalog.clock_timestamp()
   where companion.id = p_companion and companion.team_id = p_team;

  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (p_team, p_companion, 'upserted'), (p_team, p_video, 'upserted');
  return jsonb_build_object('linked', true, 'retired', retired);
end;
$$;

revoke all on function public.service_link_transcript_companion(uuid, uuid, uuid, text, text)
from public, anon, authenticated;
grant execute on function public.service_link_transcript_companion(uuid, uuid, uuid, text, text)
to service_role;

-- A transcript another video in the space already holds for the same audio, or null.
-- Nothing is returned for a video that has its own: asking again is a re-transcribe.
create or replace function public.find_reusable_transcript(p_team uuid, p_video uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  video_row public.team_materials%rowtype;
  found jsonb;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select * into video_row from public.team_materials as material
   where material.id = p_video and material.team_id = p_team and material.lifecycle = 'active';
  if video_row.id is null or video_row.category is distinct from 'video' then
    return null;
  end if;
  if video_row.checksum is null and video_row.audio_fingerprint is null then
    return null;
  end if;
  if exists (
    select 1 from public.team_materials as own
     where own.team_id = p_team
       and own.companion_of = p_video
       and own.companion_kind = 'transcript'
       and own.lifecycle = 'active'
  ) then
    return null;
  end if;

  select jsonb_build_object(
           'id', companion.id,
           'name', companion.name,
           'videoId', companion.companion_of,
           'match', case
             when video_row.checksum is not null and owner_video.checksum = video_row.checksum
               then 'checksum'
             else 'fingerprint' end
         )
    into found
  from public.team_materials as companion
  join public.team_materials as owner_video
    on owner_video.id = companion.companion_of
   and owner_video.team_id = p_team
   and owner_video.lifecycle = 'active'
  where companion.team_id = p_team
    and companion.companion_kind = 'transcript'
    and companion.lifecycle = 'active'
    and companion.transcript_ingest_state in ('full', 'truncated')
    and companion.companion_of <> p_video
    and (
      (video_row.checksum is not null and owner_video.checksum = video_row.checksum)
      or (
        video_row.audio_fingerprint is not null
        and (
          owner_video.audio_fingerprint = video_row.audio_fingerprint
          or companion.audio_fingerprint = video_row.audio_fingerprint
        )
      )
    )
  order by companion.updated_at desc, companion.id
  limit 1;
  return found;
end;
$$;

revoke all on function public.find_reusable_transcript(uuid, uuid) from public, anon;
grant execute on function public.find_reusable_transcript(uuid, uuid) to authenticated;

create or replace function public.list_team_folder_page(p_team uuid, p_parent_folder_id text DEFAULT NULL::text, p_kind text[] DEFAULT NULL::text[], p_after_sort_key text DEFAULT NULL::text, p_after_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  active_connection uuid;
  root_folder text;
  parent text;
  total_count integer;
  page_rows jsonb;
  next_cursor jsonb := null;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 200
     or (p_after_sort_key is null) <> (p_after_id is null)
     or (p_kind is not null and exists (
       select 1 from unnest(p_kind) as requested(kind)
       where requested.kind not in (
         'folder', 'image', 'video', 'landing', 'archive', 'transcript', 'document', 'shortcut', 'other'
       )
     )) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  select connection.id, connection.root_folder_id
    into active_connection, root_folder
  from public.team_drive_connections as connection
  where connection.team_id = p_team
    and connection.state in ('connected', 'needs_reauth', 'root_missing')
  order by connection.connected_at desc nulls last
  limit 1;
  if active_connection is null then
    return jsonb_build_object('rows', '[]'::jsonb, 'total', 0, 'next', null);
  end if;
  parent := coalesce(p_parent_folder_id, root_folder);

  select count(*) into total_count
  from public.team_materials as material
  where material.team_id = p_team
    and material.connection_id = active_connection
    and material.lifecycle = 'active'
    and material.parent_folder_id is not distinct from parent
    and not private.is_housekeeping_name(material.name)
    and (
      p_kind is null
      or material.kind = 'folder'
      or public.team_material_kind(material.kind, material.mime_type, material.category) = any(p_kind)
    );

  with candidate as (
    select material.*,
           public.team_material_kind(material.kind, material.mime_type, material.category) as row_kind,
           (case when material.kind = 'folder' then '0' else '1' end) || '|' || lower(material.name)
             as sort_key
    from public.team_materials as material
    where material.team_id = p_team
      and material.connection_id = active_connection
      and material.lifecycle = 'active'
      and material.parent_folder_id is not distinct from parent
      and not private.is_housekeeping_name(material.name)
  ),
  page as (
    select candidate.*,
           (
             select render.render_state
             from public.team_landing_renders as render
             where render.team_id = p_team and render.material_id = candidate.id
             order by render.updated_at desc
             limit 1
           ) as render_state
    from candidate
    where (p_kind is null or candidate.row_kind = 'folder' or candidate.row_kind = any(p_kind))
      and (p_after_sort_key is null or (candidate.sort_key, candidate.id) > (p_after_sort_key, p_after_id))
    order by candidate.sort_key, candidate.id
    limit p_limit + 1
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', page.id,
      'teamId', page.team_id,
      'name', page.name,
      'category', page.category,
      'mimeType', page.mime_type,
      'fileExtension', page.file_extension,
      'sizeBytes', page.size_bytes,
      'kind', page.row_kind,
      'driveFileId', page.drive_file_id,
      'parentFolderId', page.parent_folder_id,
      'modifiedAt', page.modified_at,
      'driveVersion', page.drive_version,
      'previewState', page.provider_thumbnail_state,
      'thumbnailReady', page.provider_thumbnail_state = 'ready',
      'sortKey', page.sort_key,
      'tagColor', page.tag_color,
      -- What this file belongs to (024, US25): a transcript or a catalog folds under its video.
      'companionOf', page.companion_of,
      'companionKind', page.companion_kind
    )
    -- 012 (T003): whether the video already has text to read, so the row can say so without a
    -- second call per file.
    || case when page.row_kind = 'video'
         then jsonb_build_object(
                'hasTranscriptCompanion', private.has_readable_transcript(p_team, page.id))
         else '{}'::jsonb end
    || case when page.provider_thumbnail_reason is not null
         then jsonb_build_object('previewReason', page.provider_thumbnail_reason) else '{}'::jsonb end
    || case when page.row_kind = 'landing'
         then jsonb_build_object('landingRender',
                jsonb_build_object('state', coalesce(page.render_state, 'none')))
         else '{}'::jsonb end
    order by page.sort_key, page.id
  ), '[]'::jsonb) into page_rows
  from page;

  if jsonb_array_length(page_rows) > p_limit then
    next_cursor := jsonb_build_object(
      'sortKey', page_rows -> (p_limit - 1) ->> 'sortKey',
      'id', page_rows -> (p_limit - 1) ->> 'id'
    );
    select coalesce(jsonb_agg(element.value order by element.ordinality), '[]'::jsonb)
      into page_rows
    from jsonb_array_elements(page_rows) with ordinality as element(value, ordinality)
    where element.ordinality <= p_limit;
  end if;

  return jsonb_build_object('rows', page_rows, 'total', total_count, 'next', next_cursor);
end;
$$;

create or replace function public.search_materials(
  p_team uuid,
  p_query text default null,
  p_filters jsonb default '{}'::jsonb,
  p_page integer default 1,
  p_page_size integer default 50,
  p_parent_folder_id text default null,
  p_kind text[] default null
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
  marker_filters text[];
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
  -- 011: the explorer narrows a search to the open folder and to row kinds.
  if p_parent_folder_id is not null and char_length(p_parent_folder_id) not between 1 and 1024 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_kind is not null and exists (
    select 1 from pg_catalog.unnest(p_kind) as requested(kind)
    where requested.kind not in (
      'folder', 'image', 'video', 'landing', 'archive', 'transcript', 'document', 'shortcut', 'other'
    )
  ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_filters, '{}'::jsonb)) <> 'object'
     or exists (
       select 1 from pg_catalog.jsonb_each(coalesce(p_filters, '{}'::jsonb)) as entry
       where entry.key not in (
         'geo', 'language', 'offer', 'category', 'originalType', 'kind', 'unfilled', 'marker'
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
    else private.material_search_query(normalized_query) end;

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
  select coalesce(pg_catalog.array_agg(pg_catalog.lower(value)), '{}'::text[])
    into marker_filters
  from pg_catalog.jsonb_array_elements_text(coalesce(p_filters -> 'marker', '[]'::jsonb)) as valueset(value);

  if exists (select 1 from pg_catalog.unnest(geo_filters) as value where value not in (select code from public.geo_options))
     or exists (select 1 from pg_catalog.unnest(language_filters) as value where value not in (select code from public.language_options))
     or exists (select 1 from pg_catalog.unnest(category_filters) as value where value not in ('video','image','archive','transcript','landing','other'))
     or exists (select 1 from pg_catalog.unnest(kind_filters) as value where value not in ('file','folder','shortcut'))
     or exists (select 1 from pg_catalog.unnest(unfilled_filters) as value where value not in ('geo','language','offer'))
     or exists (select 1 from pg_catalog.unnest(marker_filters) as value where value not in ('red','orange','yellow','green','blue','purple','grey')) then
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
      and (cardinality(marker_filters) = 0 or material.tag_color = any(marker_filters))
      and (p_parent_folder_id is null or material.parent_folder_id = p_parent_folder_id)
      and (
        p_kind is null
        or public.team_material_kind(material.kind, material.mime_type, material.category) = any(p_kind)
      )
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
          'note', material.note,
          'tags', material.tags,
          'transcriptIngestState', material.transcript_ingest_state,
          'transcriptTruncated', material.transcript_truncated,
          'previewState', material.preview_state,
          'tagColor', material.tag_color,
          -- 012 (T003): what the result belongs to, and whether a video has its text ready.
          'companionOf', material.companion_of,
          'companionKind', material.companion_kind,
          'hasTranscriptCompanion', material.category = 'video'
            and private.has_readable_transcript(p_team, material.id),
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
