-- Feature 024 — the search's GEO and language filters list what files carry.
--
-- `geo` and `languages` stay the whole dictionaries, which the metadata editor chooses from;
-- `usedGeo` and `usedLanguages` are what the space's live files have, which is all a filter can find. Forward-only; ROLLBACK.md
-- re-applies 20260815113000's definition.

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
    -- What the space's files actually carry (024): a filter offering every
    -- language in the dictionary found nothing for most of them. Set by hand in
    -- the metadata, or by a transcription that heard it.
    'usedGeo', coalesce((
      select pg_catalog.jsonb_agg(used.code order by used.code)
      from (
        select distinct material.geo as code
        from current_materials as material
        where material.geo is not null
      ) as used
    ), '[]'::jsonb),
    'usedLanguages', coalesce((
      select pg_catalog.jsonb_agg(used.code order by used.code)
      from (
        select distinct material.language as code
        from current_materials as material
        where material.language is not null
      ) as used
    ), '[]'::jsonb),
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
