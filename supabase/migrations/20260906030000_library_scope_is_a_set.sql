-- The batch's scope is a set of materials, not one.
--
-- Both RPCs took `p_source uuid`: the whole space, or exactly one file. So a
-- selection of four videos could not be processed at all, and a folder — the
-- shape a library actually has — could only be walked by asking the same
-- question once per file, one round trip each.
--
-- `p_sources uuid[]` says the same thing for any number: null is everything in
-- the space, one id is the old single-file scope, a list is the chosen set.
-- The old signatures are dropped rather than kept alongside, so a named-argument
-- call cannot land on two candidates at once.

drop function if exists public.scan_library_requirements(uuid, text, uuid);
drop function if exists public.claim_library_job(uuid, uuid, text[], text, uuid);

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
    select p_team, candidate.id, candidate.source_version, 'landing_optimization', p_interface_language
    from candidates as candidate
    on conflict (team_id, source_material_id, source_version, kind, variant) do nothing
    returning 1
  ) select count(*)::integer into inserted_landings from inserted;

  -- Work that is no longer work is retired, not counted: a transcription asked
  -- for last week stays `pending` long after somebody transcribed that video by
  -- hand, and a translation stays queued for a video whose transcript never came.
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

  -- Scoped like every other count here: `ready` answers for the batch that was
  -- asked about, not for whatever else the space has finished.
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

create or replace function public.claim_library_job(
  p_team uuid,
  p_agent_instance uuid,
  p_supported_kinds text[],
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
  requirement public.team_library_requirements%rowtype;
  attempt_id uuid;
  lease_token text;
  lease_expires_at timestamptz;
begin
  if actor is null or not private.can(p_team, 'process', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_agent_instance is null or p_supported_kinds is null or cardinality(p_supported_kinds) not between 1 and 3
     or exists (select 1 from unnest(p_supported_kinds) as kind where kind not in ('transcription','translation','landing_optimization'))
     or cardinality(array(select distinct kind from unnest(p_supported_kinds) as kind)) <> cardinality(p_supported_kinds)
     or not exists (select 1 from public.language_options where code = p_interface_language) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if scope is not null and cardinality(scope) > 500 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  with expired as (
    update private.team_library_attempts as attempt
       set state = 'expired', finished_at = clock_timestamp()
     where attempt.team_id = p_team
       and attempt.state in ('leased','running')
       and attempt.lease_expires_at <= clock_timestamp()
     returning attempt.requirement_id
  )
  update public.team_library_requirements as candidate
     set state = 'pending'
   where candidate.id in (select requirement_id from expired)
     and candidate.state in ('leased','running');

  select candidate.* into requirement
  from public.team_library_requirements as candidate
  join public.team_materials as material
    on material.id = candidate.source_material_id and material.team_id = candidate.team_id
  where candidate.team_id = p_team
    and candidate.state = 'pending'
    and candidate.kind = any(p_supported_kinds)
    and (scope is null or candidate.source_material_id = any(scope))
    and material.lifecycle = 'active'
    and coalesce(material.library_stage, 'library') = 'library'
    and coalesce(nullif(material.drive_version,''), nullif(material.checksum,'')) = candidate.source_version
  order by candidate.created_at, candidate.id
  for update of candidate skip locked
  limit 1;
  if requirement.id is null then
    raise exception 'NO_WORK' using errcode = 'P0002';
  end if;

  lease_token := encode(extensions.gen_random_bytes(32), 'hex');
  lease_expires_at := clock_timestamp() + interval '90 seconds';
  insert into private.team_library_attempts (
    requirement_id, team_id, actor_id, agent_instance_id,
    lease_token_hash, lease_expires_at
  ) values (
    requirement.id, p_team, actor, p_agent_instance,
    extensions.digest(lease_token, 'sha256'), lease_expires_at
  ) returning id into attempt_id;
  update public.team_library_requirements
     set state = 'leased', last_error_code = null
   where id = requirement.id;

  return jsonb_build_object(
    'teamId', p_team,
    'requirementId', requirement.id,
    'attemptId', attempt_id,
    'sourceMaterialId', requirement.source_material_id,
    'sourceVersion', requirement.source_version,
    'kind', requirement.kind,
    'variant', requirement.variant,
    'leaseToken', lease_token,
    'leaseExpiresAt', lease_expires_at
  );
end;
$$;

grant execute on function public.scan_library_requirements(uuid, text, uuid[])
to authenticated;
grant execute on function public.claim_library_job(uuid, uuid, text[], text, uuid[])
to authenticated;
