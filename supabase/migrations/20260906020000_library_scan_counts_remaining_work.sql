-- The batch counts the work that is actually left.
--
-- Two scanners looked at the same fifty-five videos and disagreed: the folder
-- dialog asks each video whether it already carries a transcript and says
-- "already have: 1", while the space scan counted every video every time — so
-- it offered to transcribe six files that were already transcribed, and to
-- translate fifty-five that had nothing to translate yet. A hundred and sixteen
-- "jobs" where there were forty-nine.
--
-- The rule is the one the companion RPC already uses: a video is transcribed
-- when an active companion of kind `transcript` holds text. Transcription skips
-- those; translation asks for them, because there is nothing to translate until
-- the transcript exists.

create or replace function public.scan_library_requirements(
  p_team uuid,
  p_interface_language text,
  p_source uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  inserted_transcriptions integer := 0;
  inserted_translations integer := 0;
  inserted_landings integer := 0;
  missing_transcriptions integer := 0;
  missing_translations integer := 0;
  missing_landings integer := 0;
  ready_count integer := 0;
begin
  if actor is null or not private.can(p_team, 'process', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if not exists (select 1 from public.language_options where code = p_interface_language) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  update public.team_library_requirements as requirement
     set state = 'stale'
   where requirement.team_id = p_team
     and requirement.state <> 'stale'
     and exists (
       select 1 from public.team_materials as material
       where material.id = requirement.source_material_id
         and material.team_id = requirement.team_id
         and coalesce(nullif(material.drive_version,''), nullif(material.checksum,''))
             is distinct from requirement.source_version
     );

  update public.team_library_results as result
     set state = 'stale', stale_at = clock_timestamp()
   where result.team_id = p_team
     and result.state = 'current'
     and exists (
       select 1 from public.team_library_requirements as requirement
       where requirement.id = result.requirement_id and requirement.state = 'stale'
     );

  with candidates as (
    select material.id,
           coalesce(nullif(material.drive_version,''), nullif(material.checksum,'')) as source_version
    from public.team_materials as material
    where material.team_id = p_team
      and (p_source is null or material.id = p_source)
      and coalesce(material.library_stage, 'library') = 'library'
      and material.lifecycle = 'active'
      and material.category = 'video'
      and not exists (
        select 1 from public.team_materials as transcript
        where transcript.team_id = material.team_id
          and transcript.companion_of = material.id
          and transcript.companion_kind = 'transcript'
          and transcript.lifecycle = 'active'
          and transcript.transcript_text is not null
          and length(btrim(transcript.transcript_text)) > 0
      )
      and coalesce(nullif(material.drive_version,''), nullif(material.checksum,'')) is not null
  ), inserted as (
    insert into public.team_library_requirements (
      team_id, source_material_id, source_version, kind, variant
    )
    select p_team, candidate.id, candidate.source_version, 'transcription', 'original'
    from candidates as candidate
    on conflict (team_id, source_material_id, source_version, kind, variant) do nothing
    returning 1
  ) select count(*)::integer into inserted_transcriptions from inserted;

  with candidates as (
    select material.id,
           coalesce(nullif(material.drive_version,''), nullif(material.checksum,'')) as source_version
    from public.team_materials as material
    where material.team_id = p_team
      and (p_source is null or material.id = p_source)
      and coalesce(material.library_stage, 'library') = 'library'
      and material.lifecycle = 'active'
      and material.category = 'video'
      and exists (
        select 1 from public.team_materials as transcript
        where transcript.team_id = material.team_id
          and transcript.companion_of = material.id
          and transcript.companion_kind = 'transcript'
          and transcript.lifecycle = 'active'
          and transcript.transcript_text is not null
          and length(btrim(transcript.transcript_text)) > 0
      )
      and coalesce(nullif(material.drive_version,''), nullif(material.checksum,'')) is not null
      and coalesce(material.structural_language, material.language, 'unknown') <> p_interface_language
  ), inserted as (
    insert into public.team_library_requirements (
      team_id, source_material_id, source_version, kind, variant
    )
    select p_team, candidate.id, candidate.source_version, 'translation', p_interface_language
    from candidates as candidate
    on conflict (team_id, source_material_id, source_version, kind, variant) do nothing
    returning 1
  ) select count(*)::integer into inserted_translations from inserted;

  with candidates as (
    select material.id,
           coalesce(nullif(material.drive_version,''), nullif(material.checksum,'')) as source_version
    from public.team_materials as material
    where material.team_id = p_team
      and (p_source is null or material.id = p_source)
      and coalesce(material.library_stage, 'library') = 'library'
      and material.lifecycle = 'active'
      and material.category = 'landing'
      and coalesce(nullif(material.drive_version,''), nullif(material.checksum,'')) is not null
  ), inserted as (
    insert into public.team_library_requirements (
      team_id, source_material_id, source_version, kind, variant
    )
    select p_team, candidate.id, candidate.source_version, 'landing_optimization', p_interface_language
    from candidates as candidate
    on conflict (team_id, source_material_id, source_version, kind, variant) do nothing
    returning 1
  ) select count(*)::integer into inserted_landings from inserted;

  /*
   * Work that is no longer work is retired, not counted.
   *
   * The counts below read requirement rows, not candidates — so a
   * transcription asked for last week stayed `pending` and kept being offered
   * long after somebody transcribed that video by hand, and a translation
   * stayed queued for a video whose transcript never arrived. Nothing else
   * ever cleared them: only a change of source version marked a row stale.
   */
  update public.team_library_requirements as requirement
     set state = 'stale'
   where requirement.team_id = p_team
     and requirement.state = 'pending'
     and (p_source is null or requirement.source_material_id = p_source)
     and (
       (requirement.kind = 'transcription' and exists (
          select 1 from public.team_materials as transcript
          where transcript.team_id = requirement.team_id
            and transcript.companion_of = requirement.source_material_id
            and transcript.companion_kind = 'transcript'
            and transcript.lifecycle = 'active'
            and transcript.transcript_text is not null
            and length(btrim(transcript.transcript_text)) > 0
        ))
       or (requirement.kind = 'translation' and not exists (
          select 1 from public.team_materials as transcript
          where transcript.team_id = requirement.team_id
            and transcript.companion_of = requirement.source_material_id
            and transcript.companion_kind = 'transcript'
            and transcript.lifecycle = 'active'
            and transcript.transcript_text is not null
            and length(btrim(transcript.transcript_text)) > 0
        ))
     );

  select count(*)::integer into ready_count
  from public.team_library_requirements as requirement
  where requirement.team_id = p_team and requirement.state = 'ready';

  select count(*) filter (where requirement.kind = 'transcription')::integer,
         count(*) filter (where requirement.kind = 'translation')::integer,
         count(*) filter (where requirement.kind = 'landing_optimization')::integer
    into missing_transcriptions, missing_translations, missing_landings
  from public.team_library_requirements as requirement
  where requirement.team_id = p_team
    and (p_source is null or requirement.source_material_id = p_source)
    and requirement.state in ('pending','leased','running','failed');

  return jsonb_build_object(
    'created', jsonb_build_object(
      'transcription', inserted_transcriptions,
      'translation', inserted_translations,
      'landingOptimization', inserted_landings
    ),
    'missing', jsonb_build_object(
      'transcription', missing_transcriptions,
      'translation', missing_translations,
      'landingOptimization', missing_landings
    ),
    'ready', ready_count,
    'started', false
  );
end;
$$;
