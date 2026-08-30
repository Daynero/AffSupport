-- 012 (T017/translations): the video card reads its transcript and translations
-- through list_video_text_variants. That function only saw library-processing
-- results (team_library_results), so a transcript created in the explorer — a
-- companion linked by companion_of, with no library result — was invisible, and
-- the card fell back to "Transcribe" even though the transcript was right there.
--
-- Surface the explorer transcript companion as the 'original' variant too. When
-- a library result already provides an original for this source version, that
-- one wins (the companion is not duplicated); otherwise the companion fills the
-- original slot. Library translations continue to appear as before.
create or replace function public.list_video_text_variants(p_team uuid, p_video uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_source_version text;
  can_process boolean;
  variants jsonb;
  companion_variant jsonb;
  has_original boolean;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select coalesce(nullif(video.drive_version,''), nullif(video.checksum,''))
    into v_source_version
  from public.team_materials as video
  where video.id = p_video and video.team_id = p_team
    and video.category = 'video' and video.lifecycle = 'active';
  if v_source_version is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'materialId', text_material.id,
    'kind', case when result.kind = 'transcription' then 'original' else 'translation' end,
    'language', case when result.kind = 'translation' then result.variant
      else coalesce(video.language, nullif(video.structural_language, 'unknown'), 'unknown') end,
    'ingestState', text_material.transcript_ingest_state,
    'truncated', text_material.transcript_truncated,
    'text', text_material.transcript_text,
    'updatedAt', text_material.updated_at
  ) order by case when result.kind = 'transcription' then 0 else 1 end, result.variant), '[]'::jsonb)
  into variants
  from public.team_library_results as result
  join public.team_materials as video
    on video.id = result.source_material_id and video.team_id = result.team_id
  join public.team_materials as text_material
    on text_material.id = result.material_id and text_material.team_id = result.team_id
  where result.team_id = p_team
    and result.source_material_id = p_video
    and result.source_version = v_source_version
    and result.state = 'current'
    and result.kind in ('transcription','translation')
    and text_material.lifecycle = 'active';

  -- The explorer transcript companion (012): the video's own linked .txt.
  select jsonb_build_object(
    'materialId', companion.id,
    'kind', 'original',
    'language', coalesce(video.language, nullif(video.structural_language, 'unknown'), 'unknown'),
    'ingestState', companion.transcript_ingest_state,
    'truncated', companion.transcript_truncated,
    'text', companion.transcript_text,
    'updatedAt', companion.updated_at
  )
  into companion_variant
  from public.team_materials as companion
  join public.team_materials as video
    on video.id = companion.companion_of and video.team_id = companion.team_id
  where companion.team_id = p_team
    and companion.companion_of = p_video
    and companion.companion_kind = 'transcript'
    and companion.lifecycle = 'active'
  limit 1;

  if companion_variant is not null then
    select exists (
      select 1 from jsonb_array_elements(variants) as v
      where v->>'kind' = 'original'
    ) into has_original;
    if not has_original then
      variants := jsonb_build_array(companion_variant) || variants;
    end if;
  end if;

  can_process := private.can(p_team, 'process', auth.uid());
  return jsonb_build_object(
    'sourceVersion', v_source_version,
    'variants', variants,
    'canProcess', can_process
  );
end;
$function$;
