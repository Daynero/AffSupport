-- Feature 024 — a note on a file.
--
-- A file in the space can carry a note: why it exists, what it was made for, what to watch for.
-- It is Soty's own metadata, beside GEO, language, offer and tags — not written into Google Drive,
-- because a Drive description moves the file's version, and a new version resets its transcript
-- and landing checks and aborts a download already under way. A file downloaded through Soty
-- comes without it, like the rest of Soty's metadata; nothing says so, nothing needs to.
--
-- What this adds:
--   team_materials.note                  up to 4000 characters, line breaks kept
--   update_material_metadata             accepts `note`
--   get_team_material_note               the note of one file, for the details card
--   search                               the note is searched with the name, tags and transcript
--
-- Forward-only; reverse steps in ROLLBACK.md.

alter table public.team_materials
  add column if not exists note text;

alter table public.team_materials
  drop constraint if exists team_materials_note_check;
alter table public.team_materials
  add constraint team_materials_note_check
  check (note is null or char_length(note) between 1 and 4000);

grant select (note) on public.team_materials to authenticated;

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
      new.note,
      new.transcript_text
    )
  );
  return new;
end;
$$;

revoke all on function private.refresh_team_material_search()
from public, anon, authenticated, service_role;

drop trigger if exists team_materials_refresh_search on public.team_materials;
create trigger team_materials_refresh_search
before insert or update of name, tags, geo, language, offer, note, transcript_text
on public.team_materials
for each row execute function private.refresh_team_material_search();

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
  normalized_note text;
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
       where patch_key.key not in ('geo', 'language', 'offer', 'tags', 'note')
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

  -- A note keeps its line breaks; an empty one is no note (024).
  if p_patch ? 'note' and p_patch -> 'note' <> 'null'::jsonb then
    if pg_catalog.jsonb_typeof(p_patch -> 'note') <> 'string' then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    normalized_note := nullif(pg_catalog.btrim(normalize(p_patch ->> 'note', NFC)), '');
    if normalized_note is not null and char_length(normalized_note) > 4000 then
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
      note = case when p_patch ? 'note' then normalized_note else material.note end,
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
    'note', updated.note,
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

create or replace function public.get_team_material_note(p_team uuid, p_material uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  found_note text;
  found_id uuid;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select material.id, material.note into found_id, found_note
  from public.team_materials as material
  where material.id = p_material and material.team_id = p_team;
  if found_id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  return found_note;
end;
$$;

revoke all on function public.get_team_material_note(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.get_team_material_note(uuid, uuid) to authenticated;
