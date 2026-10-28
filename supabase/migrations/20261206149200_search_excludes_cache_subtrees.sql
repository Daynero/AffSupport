-- Hide Soty cache folders and all descendants before ranking, counts, facets and paging.
-- Retain indexed records for direct folder access and dependent generated outputs.

-- Register pg_trgm's USERSET parameters in this migration session before
-- CREATE FUNCTION validates its SET clause under the non-superuser CLI role.
do $$ begin
  if pg_catalog.to_regprocedure('extensions.word_similarity(text,text)') is not null then
    perform extensions.word_similarity('', '');
  end if;
end $$;

create or replace function public.search_materials(
  p_team uuid,
  p_query text default null,
  p_filters jsonb default '{}'::jsonb,
  p_page integer default 1,
  p_page_size integer default 50,
  p_parent_folder_id text default null,
  p_kind text[] default null,
  p_recursive boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
-- The fuzzy arm's index operator (%>) reads this; a placeholder where pg_trgm is absent.
set pg_trgm.word_similarity_threshold = '0.45'
as $$
declare
  normalized_query text;
  query_lower text;
  query_value tsquery;
  has_query boolean;
  is_websearch boolean;
  prefix_pattern text;
  infix_pattern text;
  fuzzy_query text;
  fuzzy_words text[];
  fuzzy_anchor text;
  scope_folders text[];
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
    '\s+', ' ', 'g'
  );
  normalized_query := pg_catalog.btrim(normalized_query);
  has_query := normalized_query <> '';
  query_lower := pg_catalog.lower(normalized_query);
  query_value := case when has_query then private.material_search_query(normalized_query) end;
  -- Same test material_search_query uses to switch to web-search syntax: such a query means
  -- what its operators say, so it is not also read as a literal piece of a name.
  is_websearch := has_query and normalized_query ~* '"|(^|\s)-|\sor\s';
  if has_query then
    prefix_pattern := pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
      query_lower, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  if has_query and not is_websearch and char_length(query_lower) >= 3 then
    infix_pattern := '%' || prefix_pattern;
  end if;
  -- A typo is forgiven word by word: the longest word (4+ characters) finds candidates through
  -- the trigram index, and every word must then sit in the name either literally or within a
  -- typo — so "summer zebra" does not match "summer sale banner" on "summer" alone.
  if has_query and not is_websearch then
    select pg_catalog.array_agg(word.value order by char_length(word.value) desc, word.value)
      into fuzzy_words
    from pg_catalog.regexp_split_to_table(query_lower, ' ') as word(value)
    where word.value <> '';
    fuzzy_anchor := fuzzy_words[1];
    -- A word with a digit is an identifier, not a word to misspell: "lp31" must not bring back
    -- Lp35 … Lp39 as typos of it.
    if char_length(fuzzy_anchor) >= 4 and query_lower !~ '[0-9]' then
      fuzzy_query := query_lower;
    end if;
  end if;

  -- The folder and, when asked, every folder below it. Drive gives a row one parent, so this is
  -- a tree; the depth cap and the visited path only guard against a corrupt loop.
  if p_parent_folder_id is not null then
    if coalesce(p_recursive, false) then
      with recursive scope(folder_id, depth, visited) as (
        select p_parent_folder_id, 0, array[p_parent_folder_id]
        union all
        select child.drive_file_id, scope.depth + 1, scope.visited || child.drive_file_id
        from scope
        join public.team_materials as child
          on child.team_id = p_team
         and child.parent_folder_id = scope.folder_id
         and child.kind = 'folder'
         and child.lifecycle = 'active'
        where scope.depth < 50
          and not (child.drive_file_id = any(scope.visited))
      )
      select pg_catalog.array_agg(distinct scope.folder_id) into scope_folders from scope;
    else
      scope_folders := array[p_parent_folder_id];
    end if;
  end if;

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

  -- Each arm is written so its own index can answer it (GIN on search_tsv, trigram GIN on
  -- lower(name)); an arm whose switch is off is a one-time filter and costs nothing.
  with recursive cache_tree(connection_id, drive_file_id) as (
    -- UNION deduplicates IDs and terminates even if the indexed tree has a cycle.
    -- Keep connection identity: Drive IDs alone must not cross connected roots.
    select folder.connection_id, folder.drive_file_id
    from public.team_materials as folder
    where folder.team_id = p_team and folder.kind = 'folder'
      and pg_catalog.lower(pg_catalog.btrim(folder.name)) in ('soty cache', '.soty')
    union
    select child.connection_id, child.drive_file_id
    from public.team_materials as child
    join cache_tree as parent
      on parent.connection_id = child.connection_id
     and parent.drive_file_id = child.parent_folder_id
    where child.team_id = p_team
  ), candidates as (
    select material.id
    from public.team_materials as material
    where not has_query and material.team_id = p_team and material.lifecycle = 'active'
    union
    select material.id
    from public.team_materials as material
    where has_query and material.team_id = p_team and material.lifecycle = 'active'
      and material.search_tsv @@ query_value
    union
    select material.id
    from public.team_materials as material
    where infix_pattern is not null and material.team_id = p_team and material.lifecycle = 'active'
      and pg_catalog.lower(material.name) like infix_pattern
    union
    select material.id
    from public.team_materials as material
    where fuzzy_query is not null and material.team_id = p_team and material.lifecycle = 'active'
      and private.name_fuzzy_match(pg_catalog.lower(material.name), fuzzy_anchor)
      and not exists (
        select 1 from pg_catalog.unnest(fuzzy_words) as word(value)
        where pg_catalog.strpos(pg_catalog.lower(material.name), word.value) = 0
          and private.name_similarity(pg_catalog.lower(material.name), word.value) < 0.45
      )
  ), filtered as materialized (
    select material.*,
           case
             when not has_query then 0
             when pg_catalog.lower(material.name) = query_lower
               or pg_catalog.regexp_replace(pg_catalog.lower(material.name), '\.[^.]*$', '') = query_lower
               then 6
             when pg_catalog.lower(material.name) like prefix_pattern then 5
             when pg_catalog.ts_filter(material.search_tsv, '{a}'::"char"[]) @@ query_value then 4
             when infix_pattern is not null and pg_catalog.lower(material.name) like infix_pattern then 3
             when material.search_tsv @@ query_value then 2
             else 1
           end as match_tier,
           case when has_query
             then pg_catalog.ts_rank_cd('{0.1,0.2,0.4,1.0}'::real[], material.search_tsv, query_value, 1 | 32)
             else 0::real
           end as relevance
    from public.team_materials as material
    join public.team_drive_connections as connection
      on connection.id = material.connection_id
     and connection.team_id = material.team_id
     and connection.state = 'connected'
    where material.team_id = p_team
      and material.lifecycle = 'active'
      and material.id in (select candidate.id from candidates as candidate)
      and not private.is_housekeeping_name(material.name)
      and not exists (
        select 1 from cache_tree as cached
        where cached.connection_id = material.connection_id
          and cached.drive_file_id = material.drive_file_id
      )
      and (cardinality(geo_filters) = 0 or material.geo = any(geo_filters))
      and (cardinality(language_filters) = 0 or material.language = any(language_filters))
      and (cardinality(offer_filters) = 0 or pg_catalog.lower(material.offer) = any(offer_filters))
      and (cardinality(category_filters) = 0 or material.category = any(category_filters))
      and (cardinality(kind_filters) = 0 or material.kind = any(kind_filters))
      and (cardinality(marker_filters) = 0 or material.tag_color = any(marker_filters))
      and (scope_folders is null or material.parent_folder_id = any(scope_folders))
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
  ), ranked as (
    select material.*,
           case when material.match_tier = 1
             then private.name_similarity(pg_catalog.lower(material.name), fuzzy_query)
             else 0::real
           end as fuzzy_score
    from filtered as material
  ), paged as (
    select material.*,
           pg_catalog.row_number() over (
             order by material.match_tier desc, material.relevance desc, material.fuzzy_score desc,
                      material.modified_at desc nulls last, pg_catalog.lower(material.name), material.id
           ) as ordinal
    from ranked as material
    order by material.match_tier desc, material.relevance desc, material.fuzzy_score desc,
             material.modified_at desc nulls last, pg_catalog.lower(material.name), material.id
    offset (p_page - 1) * p_page_size
    limit p_page_size
  ), explained as (
    -- Only the returned page pays for the explanation and the headline.
    select material.*,
           case
             when not has_query then null
             when material.match_tier <> 2 then 'name'
             when pg_catalog.to_tsvector('simple'::regconfig,
                    coalesce(pg_catalog.array_to_string(material.tags, ' '), '')) @@ query_value
               then 'tags'
             when pg_catalog.to_tsvector('simple'::regconfig, pg_catalog.concat_ws(
                    ' ', material.geo, material.language, material.offer)) @@ query_value
               then 'meta'
             when pg_catalog.ts_filter(material.search_tsv, '{c}'::"char"[]) @@ query_value then 'note'
             when pg_catalog.ts_filter(material.search_tsv, '{d}'::"char"[]) @@ query_value then 'transcript'
             else null
           end as matched_in
    from paged as material
  ), headlined as (
    select material.*,
           case when material.matched_in in ('note', 'transcript') then
             pg_catalog.btrim(pg_catalog.regexp_replace(
               pg_catalog.ts_headline(
                 'simple'::regconfig,
                 case when material.matched_in = 'note' then material.note
                   else material.transcript_text end,
                 query_value,
                 'StartSel="", StopSel="", MaxFragments=1, MaxWords=20, MinWords=8'
               ),
               '\s+', ' ', 'g'
             ))
           end as headline
    from explained as material
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
          ),
          'matchedIn', material.matched_in,
          'snippet', case
            when material.headline is null or char_length(material.headline) <= 160
              then material.headline
            -- Cut at a word boundary: the 161st character decides whether the 160th ends a word.
            else pg_catalog.regexp_replace(pg_catalog.left(material.headline, 161), '\s+\S*$', '')
          end
        ) order by material.ordinal
      ), '[]'::jsonb
    ) as items
    from headlined as material
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
      coalesce((
        select count(*)
        from public.team_materials as discovered
        where discovered.team_id = p_team
          and discovered.connection_id = connection.id
          and discovered.lifecycle = 'active'
      ), 0) as discovered_count,
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
