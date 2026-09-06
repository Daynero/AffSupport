-- What a scan touches is what it was asked about.
--
-- Three things were still team-wide inside a scoped scan. The two housekeeping
-- sweeps at the top rewrote requirement rows across the whole space on every
-- dialog open, so reading the counts for three chosen files wrote to every
-- other member's queue. `landing_optimization` was keyed by the reader's
-- interface language, so opening the same space in EN and then UA created two
-- requirements per landing and doubled the count — unlike a translation, a
-- landing optimisation is not per-language work. And nothing indexed
-- `source_material_id`, so every scoped count and every scoped claim scanned
-- the team's whole pending queue.

create index if not exists team_library_requirements_source_idx
  on public.team_library_requirements (team_id, source_material_id)
  where state in ('pending', 'failed', 'leased', 'running');

-- One landing optimisation per source version, whoever is looking at it. The
-- rows already written under a language variant are carried over by the
-- migration that follows this one, which renames them in place rather than
-- retiring them — a finished optimisation must not come back as a fresh job.


create or replace function public.scan_library_requirements(
  p_team uuid,
  p_interface_language text,
  p_sources uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  scope uuid[] := nullif(p_sources, '{}');
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
  -- A batch is a person's selection, not a query language: a bound keeps a
  -- runaway list from turning one press into an unbounded scan.
  if scope is not null and cardinality(scope) > 500 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  update public.team_library_requirements as requirement
     set state = 'stale'
   where requirement.team_id = p_team
     and requirement.state <> 'stale'
     and (scope is null or requirement.source_material_id = any(scope))
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
       where requirement.id = result.requirement_id
         and requirement.state = 'stale'
         and (scope is null or requirement.source_material_id = any(scope))
     );

  with candidates as (
    select material.id,
           coalesce(nullif(material.drive_version,''), nullif(material.checksum,'')) as source_version
    from public.team_materials as material
    where material.team_id = p_team
      and (scope is null or material.id = any(scope))
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
      and (scope is null or material.id = any(scope))
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
      and (scope is null or material.id = any(scope))
      and coalesce(material.library_stage, 'library') = 'library'
      and material.lifecycle = 'active'
      and material.category = 'landing'
      and coalesce(nullif(material.drive_version,''), nullif(material.checksum,'')) is not null
  ), inserted as (
    insert into public.team_library_requirements (
      team_id, source_material_id, source_version, kind, variant
    )
    -- A fixed variant, not the reader's language: optimising a landing page is
    -- the same job whoever opened the window. Not 'original' — the table's own
    -- check reserves that spelling for transcriptions.
    select p_team, candidate.id, candidate.source_version, 'landing_optimization', 'default'
    from candidates as candidate
    on conflict (team_id, source_material_id, source_version, kind, variant) do nothing
    returning 1
  ) select count(*)::integer into inserted_landings from inserted;

  -- Work that is no longer work is retired, not counted.
  update public.team_library_requirements as requirement
     set state = 'stale'
   where requirement.team_id = p_team
     and requirement.state = 'pending'
     and (scope is null or requirement.source_material_id = any(scope))
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
  where requirement.team_id = p_team
    and requirement.state = 'ready'
    and (scope is null or requirement.source_material_id = any(scope));

  select count(*) filter (where requirement.kind = 'transcription')::integer,
         count(*) filter (where requirement.kind = 'translation')::integer,
         count(*) filter (where requirement.kind = 'landing_optimization')::integer
    into missing_transcriptions, missing_translations, missing_landings
  from public.team_library_requirements as requirement
  where requirement.team_id = p_team
    and (scope is null or requirement.source_material_id = any(scope))
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

-- The repo's own convention, lost when these three were dropped and recreated:
-- a fresh function is PUBLIC EXECUTE by default.
revoke all on function public.scan_library_requirements(uuid, text, uuid[]) from public, anon;
revoke all on function public.claim_library_job(uuid, uuid, text[], text, uuid[]) from public, anon;
revoke all on function public.retry_failed_library_jobs(uuid, uuid[]) from public, anon;
grant execute on function public.scan_library_requirements(uuid, text, uuid[]) to authenticated;
grant execute on function public.claim_library_job(uuid, uuid, text[], text, uuid[]) to authenticated;
grant execute on function public.retry_failed_library_jobs(uuid, uuid[]) to authenticated;
