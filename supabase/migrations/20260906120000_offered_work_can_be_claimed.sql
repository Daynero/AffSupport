-- Everything the window offers, the loop can claim.
--
-- Two states broke that. A `failed` row was counted in the numbers over Start,
-- revived by nothing, and skipped by the claim, which takes `pending` only — so
-- a scope holding three failures from an earlier session offered three jobs and
-- finished with none. And a `ready` row whose result is gone — somebody trashed
-- the transcript, and the video's version did not change, so no sweep touched it
-- — left the video counted as needing work that could never be claimed.
--
-- Pressing Start is asking for the failed work as well; the separate retry
-- button already meant that. A finished job whose result no longer exists is not
-- finished, and is retired before the inserts so the same statement revives it.
-- The retirement sweep now covers `failed` too, or reviving one would offer work
-- that is no longer warranted.

create or replace function public.scan_library_requirements(
  p_team uuid,
  p_interface_language text,
  p_sources uuid[] default null,
  p_commit boolean default true
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
  candidate_transcriptions integer := 0;
  candidate_translations integer := 0;
  candidate_landings integer := 0;
  ready_count integer := 0;
begin
  /*
   * `p_commit = false` answers the question without joining the queue.
   *
   * Opening the batch window used to write a requirement row for every
   * candidate in scope, while the window said processing starts only after
   * confirmation. True of the processing — but the rows are what other members'
   * devices claim from, so reading the counts enqueued the work for the space.
   * A dry read counts the candidates instead: each one is either a row that
   * exists or a row that would be created, so the number is the same.
   */
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
   where p_commit
     and requirement.team_id = p_team
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
   where p_commit
     and result.team_id = p_team
     and result.state = 'current'
     and exists (
       select 1 from public.team_library_requirements as requirement
       where requirement.id = result.requirement_id
         and requirement.state = 'stale'
         and (scope is null or requirement.source_material_id = any(scope))
     );

  update public.team_library_requirements as requirement
     set state = 'stale'
   where p_commit
     and requirement.team_id = p_team
     and requirement.state = 'ready'
     and (scope is null or requirement.source_material_id = any(scope))
     and not exists (
       select 1
       from public.team_library_results as result
       join public.team_materials as produced
         on produced.id = result.material_id and produced.team_id = result.team_id
       where result.id = requirement.current_result_id
         and result.state = 'current'
         and produced.lifecycle = 'active'
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
    where p_commit
    on conflict (team_id, source_material_id, source_version, kind, variant)
    do update set state = 'pending', last_error_code = null
    where public.team_library_requirements.state in ('stale', 'failed')
    returning 1
  ) select count(*)::integer, (select count(*)::integer from candidates)
      into inserted_transcriptions, candidate_transcriptions
    from inserted;

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
    where p_commit
    on conflict (team_id, source_material_id, source_version, kind, variant)
    do update set state = 'pending', last_error_code = null
    where public.team_library_requirements.state in ('stale', 'failed')
    returning 1
  ) select count(*)::integer, (select count(*)::integer from candidates)
      into inserted_translations, candidate_translations
    from inserted;

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
    where p_commit
    on conflict (team_id, source_material_id, source_version, kind, variant)
    do update set state = 'pending', last_error_code = null
    where public.team_library_requirements.state in ('stale', 'failed')
    returning 1
  ) select count(*)::integer, (select count(*)::integer from candidates)
      into inserted_landings, candidate_landings
    from inserted;

  -- Work that is no longer work is retired, not counted.
  update public.team_library_requirements as requirement
     set state = 'stale'
   where p_commit
     and requirement.team_id = p_team
     and requirement.state in ('pending', 'failed')
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

  if p_commit then
    select count(*) filter (where requirement.kind = 'transcription')::integer,
           count(*) filter (where requirement.kind = 'translation')::integer,
           count(*) filter (where requirement.kind = 'landing_optimization')::integer
      into missing_transcriptions, missing_translations, missing_landings
    from public.team_library_requirements as requirement
    where requirement.team_id = p_team
      and (scope is null or requirement.source_material_id = any(scope))
      and requirement.state in ('pending','leased','running','failed');
  else
    -- Every candidate is either a row that exists or one the commit would
    -- create, and the rows a commit would retire are not candidates. So the
    -- candidate count is the same number, arrived at without writing.
    missing_transcriptions := candidate_transcriptions;
    missing_translations := candidate_translations;
    missing_landings := candidate_landings;
  end if;

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


revoke all on function public.scan_library_requirements(uuid, text, uuid[], boolean)
  from public, anon;
grant execute on function public.scan_library_requirements(uuid, text, uuid[], boolean)
  to authenticated;
