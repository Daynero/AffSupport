-- A transcription knows what language the video is in. Now it says so.
--
-- Language is one of the three fields the catalogue filters by, and the only
-- way to fill it was by hand, one file at a time — so on a space of five
-- hundred Drive files it was empty everywhere and the filter found nothing.
-- Meanwhile transcription had the answer all along: Whisper reports the
-- language it heard, and a run given an explicit one was told outright.
--
-- Written through its own function rather than `update_material_metadata`,
-- because this write must never overrule a person. `language_decision_source`
-- has had a value for exactly this since 20260814100000 — `automatic` — and
-- nothing has ever written it.
--
-- Forward-only. Reverse steps are in ROLLBACK.md.

create or replace function public.record_material_source_language(
  p_team uuid,
  p_material uuid,
  p_language text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_language text;
  touched uuid;
begin
  if auth.uid() is null or not private.can(p_team, 'manage_metadata', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  -- The catalogue's own spelling, or nothing: an agent may send a regional tag
  -- (`en-GB`) or a code this deployment does not carry.
  select option.code into normalized_language
  from public.language_options as option
  where pg_catalog.lower(option.code)
        = pg_catalog.lower(pg_catalog.split_part(pg_catalog.btrim(p_language), '-', 1));
  if normalized_language is null then
    return false;
  end if;

  -- Only into an empty field. A member who set the language by hand has looked
  -- at the file; a detector has listened to the first half-minute of it.
  update public.team_materials as material
  set language = normalized_language,
      language_decision_source = 'automatic',
      language_decision_revision = coalesce(material.language_decision_revision, 0) + 1,
      updated_at = pg_catalog.clock_timestamp()
  where material.id = p_material
    and material.team_id = p_team
    and material.lifecycle = 'active'
    and material.language is null
  returning material.id into touched;
  if touched is null then return false; end if;

  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (p_team, p_material, 'upserted');
  return true;
end;
$$;

revoke all on function public.record_material_source_language(uuid, uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.record_material_source_language(uuid, uuid, text) to authenticated;

comment on function public.record_material_source_language(uuid, uuid, text) is
  'Records the language a transcription heard, on a material that has none. Never overwrites a language a person chose.';
