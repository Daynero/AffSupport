-- 046: original-only processing. Forward only; preserve historical files and records.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
-- Cutover waits for old transactions before installing the new authoritative fences.
lock table private.team_library_attempts, public.team_library_requirements,
 public.team_library_results, public.team_operations, private.team_operation_intents,
 private.team_transfer_grants in share row exclusive mode;
insert into public.team_error_codes (code) values
  ('FEATURE_RETIRED')
on conflict (code) do nothing;

-- A valid old attempt can be diagnosed without disclosing another actor's work.
create or replace function private.assert_active_library_attempt(
 p_team uuid,p_attempt uuid,p_actor uuid,p_agent uuid,p_lease text
) returns void language plpgsql security definer set search_path='' as $$
declare rid uuid; k text;
begin
 select a.requirement_id into rid from private.team_library_attempts a
 where a.id=p_attempt and a.team_id=p_team and a.actor_id=p_actor
  and a.agent_instance_id=p_agent and a.lease_token_hash=extensions.digest(p_lease,'sha256')
 for update;
 if rid is null then return;end if;
 select r.kind into k from public.team_library_requirements r where r.id=rid for update;
 if k='translation' then raise exception 'FEATURE_RETIRED' using errcode='P0001';end if;
end; $$;
revoke all on function private.assert_active_library_attempt(uuid,uuid,uuid,uuid,text)
 from public,anon,authenticated,service_role;

create or replace function private.assert_active_process(p_operation uuid,p_actor uuid,allow_history boolean default false)
 returns void language plpgsql security definer set search_path='' as $$
declare o public.team_operations%rowtype; k text;
begin
 select * into o from public.team_operations where id=p_operation and actor_id=p_actor for update;
 if o.id is null then return;end if;
 select i.tool_id into k from private.team_operation_intents i where i.operation_id=o.id;
 if k='translation' and not (allow_history and o.state='succeeded') then
  raise exception 'FEATURE_RETIRED' using errcode='P0001';
 end if;
end; $$;
revoke all on function private.assert_active_process(uuid,uuid,boolean)
 from public,anon,authenticated,service_role;


create or replace function public.scan_library_requirements(
  p_team uuid,
  p_interface_language text,
  p_sources uuid[] default null,
  p_commit boolean default true,
  p_kinds text[] default null
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
  inserted_landings integer := 0;
  missing_transcriptions integer := 0;
  missing_landings integer := 0;
  candidate_transcriptions integer := 0;
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
  if 'translation'=any(p_kinds) then raise exception 'FEATURE_RETIRED' using errcode='P0001';end if;

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
     and requirement.team_id = p_team and requirement.kind <> 'translation'
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
    where p_commit and (p_kinds is null or 'transcription' = any(p_kinds))
    on conflict (team_id, source_material_id, source_version, kind, variant) do nothing
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
    where p_commit and (p_kinds is null or 'landing_optimization' = any(p_kinds))
    on conflict (team_id, source_material_id, source_version, kind, variant) do nothing
    returning 1
  ) select count(*)::integer, (select count(*)::integer from candidates)
      into inserted_landings, candidate_landings
    from inserted;

  -- Work that is no longer work is retired, not counted.
  update public.team_library_requirements as requirement
     set state = 'stale'
   where p_commit
     and requirement.team_id = p_team and requirement.kind <> 'translation'
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

     );

  select count(*)::integer into ready_count
  from public.team_library_requirements as requirement
  where requirement.team_id = p_team and requirement.kind <> 'translation'
    and requirement.state = 'ready'
    and (scope is null or requirement.source_material_id = any(scope));

  if p_commit then
    select count(*) filter (where requirement.kind = 'transcription')::integer,
           count(*) filter (where requirement.kind = 'landing_optimization')::integer
      into missing_transcriptions, missing_landings
    from public.team_library_requirements as requirement
    where requirement.team_id = p_team and requirement.kind <> 'translation'
      and (scope is null or requirement.source_material_id = any(scope))
      and requirement.state in ('pending','leased','running','failed');
  else
    -- Every candidate is either a row that exists or one the commit would
    -- create, and the rows a commit would retire are not candidates. So the
    -- candidate count is the same number, arrived at without writing.
    missing_transcriptions := candidate_transcriptions;
    missing_landings := candidate_landings;
  end if;

  return jsonb_build_object(
    'created', jsonb_build_object(
      'transcription', inserted_transcriptions,
      'landingOptimization', inserted_landings
    ),
    'missing', jsonb_build_object(
      'transcription', missing_transcriptions,
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
  if 'translation'=any(p_supported_kinds) then raise exception 'FEATURE_RETIRED' using errcode='P0001';end if;

  if p_agent_instance is null or p_supported_kinds is null or cardinality(p_supported_kinds) not between 1 and 2
     or exists (select 1 from unnest(p_supported_kinds) as kind where kind not in ('transcription','landing_optimization'))
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
     and candidate.state in ('leased','running') and candidate.kind<>'translation';

  select candidate.* into requirement
  from public.team_library_requirements as candidate
  join public.team_materials as material
    on material.id = candidate.source_material_id and material.team_id = candidate.team_id
  where candidate.team_id = p_team
    and candidate.state = 'pending' and candidate.kind<>'translation'
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

create or replace function public.heartbeat_library_job(
  p_team uuid,
  p_attempt uuid,
  p_agent_instance uuid,
  p_lease_token text,
  p_progress integer,
  p_stage text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  updated_expiry timestamptz;
  requirement_id uuid;
begin
  if actor is null or not private.can(p_team, 'process', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  perform private.assert_active_library_attempt(p_team,p_attempt,auth.uid(),p_agent_instance,p_lease_token);

  if p_progress not between 0 and 100 or p_stage !~ '^[a-z][a-z0-9_:-]{0,63}$'
     or p_lease_token is null or char_length(p_lease_token) not between 24 and 2048 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update private.team_library_attempts as attempt
     set state = 'running', progress = p_progress, stage = p_stage,
         last_heartbeat_at = clock_timestamp(),
         lease_expires_at = clock_timestamp() + interval '90 seconds'
   where attempt.id = p_attempt
     and attempt.team_id = p_team
     and attempt.actor_id = actor
     and attempt.agent_instance_id = p_agent_instance
     and attempt.state in ('leased','running')
     and attempt.lease_expires_at > clock_timestamp()
     and attempt.lease_token_hash = extensions.digest(p_lease_token, 'sha256')
   returning attempt.lease_expires_at, attempt.requirement_id
   into updated_expiry, requirement_id;
  if requirement_id is null then
    if exists (
      select 1 from private.team_library_attempts as attempt
      where attempt.id = p_attempt and attempt.team_id = p_team
        and attempt.lease_expires_at <= clock_timestamp()
    ) then
      raise exception 'LEASE_EXPIRED' using errcode = '40001';
    end if;
    raise exception 'LEASE_MISMATCH' using errcode = '42501';
  end if;
  update public.team_library_requirements set state = 'running' where id = requirement_id;
  return jsonb_build_object(
    'attemptId', p_attempt,
    'progress', p_progress,
    'stage', p_stage,
    'leaseExpiresAt', updated_expiry
  );
end;
$$;

create or replace function public.cancel_library_job(
  p_team uuid,
  p_attempt uuid,
  p_agent_instance uuid,
  p_lease_token text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  requirement_id uuid;
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  perform private.assert_active_library_attempt(p_team,p_attempt,auth.uid(),p_agent_instance,p_lease_token);

  update private.team_library_attempts as attempt
     set state = 'canceled', finished_at = clock_timestamp()
   where attempt.id = p_attempt and attempt.team_id = p_team
     and attempt.actor_id = auth.uid() and attempt.agent_instance_id = p_agent_instance
     and attempt.state in ('leased','running')
     and attempt.lease_token_hash = extensions.digest(p_lease_token, 'sha256')
   returning attempt.requirement_id into requirement_id;
  if requirement_id is null then return false; end if;
  update public.team_library_requirements
     set state = 'pending'
   where id = requirement_id and state in ('leased','running');
  return true;
end;
$$;

create or replace function public.fail_library_job(
  p_team uuid,
  p_attempt uuid,
  p_agent_instance uuid,
  p_lease_token text,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  requirement_id uuid;
  requirement_kind text;
begin
  if actor is null or not private.can(p_team, 'process', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  perform private.assert_active_library_attempt(p_team,p_attempt,auth.uid(),p_agent_instance,p_lease_token);

  if p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$'
     or p_lease_token is null or char_length(p_lease_token) not between 24 and 2048 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update private.team_library_attempts as attempt
     set state = 'failed', error_code = p_error_code, finished_at = clock_timestamp()
   where attempt.id = p_attempt and attempt.team_id = p_team
     and attempt.actor_id = actor and attempt.agent_instance_id = p_agent_instance
     and attempt.state in ('leased','running')
     and attempt.lease_token_hash = extensions.digest(p_lease_token, 'sha256')
   returning attempt.requirement_id into requirement_id;
  if requirement_id is null then return false; end if;
  update public.team_library_requirements as requirement
     set state = 'failed', last_error_code = p_error_code
   where requirement.id = requirement_id
   returning requirement.kind into requirement_kind;
  perform private.append_library_contribution(
    p_team, actor, 'local_processing', requirement_kind, 'failure', p_agent_instance
  );
  return true;
end;
$$;

create or replace function public.service_accept_library_result(
  p_team uuid,
  p_attempt uuid,
  p_actor uuid,
  p_agent_instance uuid,
  p_lease_token text,
  p_result_material uuid,
  p_source_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  attempt private.team_library_attempts%rowtype;
  requirement public.team_library_requirements%rowtype;
  result_id uuid;
  source_name text;
begin
  select * into attempt from private.team_library_attempts as candidate
  where candidate.id = p_attempt and candidate.team_id = p_team for update;
  if attempt.id is null or attempt.actor_id <> p_actor or attempt.agent_instance_id <> p_agent_instance
     or attempt.lease_token_hash <> extensions.digest(p_lease_token, 'sha256') then
    raise exception 'LEASE_MISMATCH' using errcode = '42501';
  end if;
  perform private.assert_active_library_attempt(p_team,p_attempt,p_actor,p_agent_instance,p_lease_token);
  if attempt.state not in ('leased','running') or attempt.lease_expires_at <= clock_timestamp() then
    raise exception 'LEASE_EXPIRED' using errcode = '40001';
  end if;
  select * into requirement from public.team_library_requirements as candidate
  where candidate.id = attempt.requirement_id for update;
  if requirement.state = 'ready' then
    update private.team_library_attempts
       set state = 'skipped', finished_at = clock_timestamp()
     where id = p_attempt;
    return jsonb_build_object(
      'state', 'skipped', 'reason', 'already_completed',
      'materialId', (select material_id from public.team_library_results where id = requirement.current_result_id)
    );
  end if;
  if requirement.source_version <> p_source_version
     or not exists (
       select 1 from public.team_materials as source
       where source.id = requirement.source_material_id and source.team_id = p_team
         and source.lifecycle = 'active'
         and coalesce(nullif(source.drive_version,''), nullif(source.checksum,'')) = p_source_version
     ) then
    raise exception 'STALE_RESULT' using errcode = '40001';
  end if;
  if not exists (
    select 1 from public.team_materials as result
    where result.id = p_result_material and result.team_id = p_team and result.lifecycle = 'active'
      and (requirement.kind not in ('transcription','translation') or result.category = 'transcript')
  ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  insert into public.team_library_results (
    team_id, requirement_id, source_material_id, source_version,
    kind, variant, material_id, accepted_attempt_id, accepted_by
  ) values (
    p_team, requirement.id, requirement.source_material_id, requirement.source_version,
    requirement.kind, requirement.variant, p_result_material, p_attempt, p_actor
  ) returning id into result_id;
  select source.name into source_name from public.team_materials as source
  where source.id = requirement.source_material_id;
  insert into public.team_material_links (
    team_id, source_material_id, derivative_material_id, relation,
    source_name_snapshot, tool_id, tool_contract_version, created_by
  ) values (
    p_team, requirement.source_material_id, p_result_material, 'processed_from',
    source_name, requirement.kind, 1, p_actor
  ) on conflict (team_id, source_material_id, derivative_material_id, relation) do nothing;
  update public.team_materials as result
     set library_stage = source.library_stage,
         structural_offer = coalesce(source.structural_offer, source.offer, 'unknown'),
         structural_language = coalesce(source.structural_language, source.language, 'unknown'),
         structural_type = coalesce(source.structural_type, initcap(coalesce(source.category, 'unknown'))),
         placement_state = 'ready', placement_revision = result.placement_revision + 1
    from public.team_materials as source
   where result.id = p_result_material and result.team_id = p_team
     and source.id = requirement.source_material_id and source.team_id = p_team;
  update private.team_library_attempts
     set state = 'ready', progress = 100, result_material_id = p_result_material,
         finished_at = clock_timestamp()
   where id = p_attempt;
  update public.team_library_requirements
     set state = 'ready', current_result_id = result_id, completed_at = clock_timestamp()
   where id = requirement.id;
  perform private.append_library_contribution(
    p_team, p_actor, 'local_processing', requirement.kind, 'success', p_agent_instance
  );
  return jsonb_build_object('state', 'accepted', 'resultId', result_id, 'materialId', p_result_material);
exception
  when unique_violation then
    update private.team_library_attempts
       set state = 'skipped', finished_at = clock_timestamp()
     where id = p_attempt and state in ('leased','running');
    return jsonb_build_object('state', 'skipped', 'reason', 'already_completed', 'materialId', null);
end;
$$;

create or replace function public.retry_failed_library_jobs(
  p_team uuid,
  p_sources uuid[] default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  scope uuid[] := nullif(p_sources, '{}');
  retried integer;
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if scope is not null and cardinality(scope) > 500 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update public.team_library_requirements as requirement
     set state = 'pending', last_error_code = null
   where requirement.team_id = p_team and requirement.state = 'failed' and requirement.kind <> 'translation'
     and (scope is null or requirement.source_material_id = any(scope));
  get diagnostics retried = row_count;
  return retried;
end;
$$;

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
    'attemptId', result.accepted_attempt_id,
    'kind', 'original',
    'language', coalesce(video.language, nullif(video.structural_language, 'unknown'), 'unknown'),
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
    and result.kind = 'transcription'
    and text_material.lifecycle = 'active';

  -- The explorer transcript companion (012): the video's own linked .txt.
  select jsonb_build_object(
    'materialId', companion.id,
    'attemptId', null,
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

create or replace function private.append_library_contribution(
  p_team uuid,
  p_actor uuid,
  p_category text,
  p_action text,
  p_outcome text,
  p_agent_instance uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  contribution_id uuid;
begin
  if p_action='translation' then raise exception 'FEATURE_RETIRED' using errcode='P0001';end if;
  if not private.can(p_team, 'view', p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  insert into public.team_contribution_records (
    team_id, actor_id, category, agent_instance_id, action_kind, outcome
  ) values (
    p_team, p_actor, p_category, p_agent_instance, p_action, p_outcome
  ) returning id into contribution_id;
  return contribution_id;
end;
$$;

create or replace function public.list_library_contribution_totals(
  p_team uuid,
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table (category text, action_kind text, outcome text, total bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not coalesce(private.team_role(p_team, auth.uid()) in ('owner', 'admin'), false) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if (p_from is null) <> (p_to is null) or (p_from is not null and p_from >= p_to) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return query
  select record.category, record.action_kind, record.outcome, count(*)
  from public.team_contribution_records as record
  where record.team_id = p_team and record.action_kind <> 'translation'
    and (p_from is null or (record.occurred_at >= p_from and record.occurred_at < p_to))
  group by record.category, record.action_kind, record.outcome
  order by record.category, record.action_kind, record.outcome;
end;
$$;

create or replace function public.service_set_team_operation_intent(
  p_operation uuid,
  p_actor uuid,
  p_expected_name text,
  p_mime_type text,
  p_expected_size bigint,
  p_replace_material uuid,
  p_version_of_material uuid,
  p_tool text,
  p_tool_contract_version integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  operation_row public.team_operations%rowtype;
  relation_value text;
  intent_row private.team_operation_intents%rowtype;
begin
  select operation.* into operation_row
  from public.team_operations as operation
  where operation.id = p_operation and operation.actor_id = p_actor
  for update;
  if operation_row.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if operation_row.state not in ('pending', 'running') then
    raise exception 'WRONG_STATE' using errcode = '23514';
  end if;
  if p_tool='translation' then raise exception 'FEATURE_RETIRED' using errcode='P0001';end if;
  relation_value := case operation_row.kind
    when 'new_version' then 'version_of'
    when 'process' then 'processed_from'
    else null
  end;
  if p_expected_name is not null and char_length(p_expected_name) not between 1 and 1024
     or p_mime_type is not null and char_length(p_mime_type) not between 1 and 255
     or p_expected_size is not null and p_expected_size < 0
     or p_replace_material is not null and p_version_of_material is not null
     or operation_row.kind = 'new_version' and p_version_of_material is null
     or operation_row.kind = 'process' and (operation_row.source_material_id is null or p_tool is null)
     or p_version_of_material is not null and p_version_of_material <> operation_row.source_material_id
     or p_replace_material is not null and not exists (
       select 1 from public.team_materials as material
       where material.id = p_replace_material and material.team_id = operation_row.team_id
     ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  insert into private.team_operation_intents as stored (
    operation_id, team_id, expected_name, mime_type, expected_size,
    replace_material_id, version_of_material_id, relation, tool_id, tool_contract_version
  ) values (
    p_operation, operation_row.team_id, p_expected_name, p_mime_type, p_expected_size,
    p_replace_material, p_version_of_material, relation_value, p_tool, p_tool_contract_version
  ) on conflict (operation_id) do update
  set expected_size = case
        when stored.expected_size is null
          and operation_row.kind = 'process' then excluded.expected_size
        else stored.expected_size
      end,
      updated_at = pg_catalog.clock_timestamp();
  select intent.* into intent_row
  from private.team_operation_intents as intent
  where intent.operation_id = p_operation;
  if intent_row.expected_name is distinct from p_expected_name
     or intent_row.mime_type is distinct from p_mime_type
     or intent_row.expected_size is distinct from p_expected_size
     or intent_row.replace_material_id is distinct from p_replace_material
     or intent_row.version_of_material_id is distinct from p_version_of_material
     or intent_row.tool_id is distinct from p_tool
     or intent_row.tool_contract_version is distinct from p_tool_contract_version then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return true;
end;
$$;

create or replace function public.service_prepare_process_upload(
 p_operation uuid,p_actor uuid,p_connection uuid,p_file text,p_checksum text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.team_operations%rowtype;i private.team_operation_intents%rowtype;
 c public.team_drive_connections%rowtype;s public.team_materials%rowtype;
 u private.process_upload_ownership%rowtype;parent text;handoff_expiry timestamptz;
begin
 perform private.assert_active_process(p_operation,p_actor);
 if p_file is null or p_file !~ '^[A-Za-z0-9_-]{1,200}$'
  or p_checksum is null or p_checksum !~ '^[a-f0-9]{32}$' then
  raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select * into o from public.team_operations where id=p_operation and actor_id=p_actor for update;
 if o.id is null then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 select * into i from private.team_operation_intents where operation_id=o.id and team_id=o.team_id;
 if o.kind<>'process' or o.state<>'running' or o.result_material_id is not null
  or i.operation_id is null or i.version_of_material_id is not null or i.replace_material_id is not null
  or i.expected_size is null or i.expected_size<=0 or i.expected_name is null or i.mime_type is null
  or i.provider_result_id is not null then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if not private.can(o.team_id,'process',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select max(g.expires_at) into handoff_expiry from private.team_transfer_grants g
  where g.operation_id=o.id and g.team_id=o.team_id and g.actor_id=p_actor and g.purpose='finalize'
   and g.tool_id=i.tool_id and g.revoked_at is null and g.expires_at>clock_timestamp()+interval '5 seconds';
 if handoff_expiry is null then raise exception 'EXPIRED' using errcode='55000';end if;
 select * into c from public.team_drive_connections where id=p_connection and team_id=o.team_id and state='connected';
 select * into s from public.team_materials where id=o.source_material_id and team_id=o.team_id;
 if c.id is null or s.id is null or s.connection_id<>c.id then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 if o.destination_folder_id is null then parent:=c.root_folder_id;
 else select drive_file_id into parent from public.team_materials where id=o.destination_folder_id
  and team_id=o.team_id and connection_id=c.id and kind='folder' and lifecycle='active';end if;
 if parent is null then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 insert into private.process_output_identity_fences(file_id) values(p_file) on conflict do nothing;
 perform 1 from private.process_output_identity_fences where file_id=p_file for update;
 select * into u from private.process_upload_ownership where operation_id=o.id for update;
 if found then
  if u.actor_id<>p_actor or u.connection_id<>c.id or u.credential_id<>c.credential_id
   or u.root_id<>c.root_folder_id or u.parent_id<>parent or u.checksum<>p_checksum
   or u.expected_name<>i.expected_name or u.mime_type<>i.mime_type or u.size_bytes<>i.expected_size
   or u.source_file_id<>s.drive_file_id then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
  if handoff_expiry>u.handoff_expires_at then
   update private.process_upload_ownership set handoff_expires_at=handoff_expiry,updated_at=clock_timestamp()
    where operation_id=o.id returning * into u;
  end if;
  return private.process_upload_binding(u);
 end if;
 if exists(select 1 from public.team_materials where drive_file_id=p_file)
  or p_file=s.drive_file_id then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 insert into private.process_upload_ownership(operation_id,team_id,actor_id,connection_id,credential_id,
  root_id,parent_id,file_id,source_file_id,expected_name,mime_type,size_bytes,checksum,handoff_expires_at)
 values(o.id,o.team_id,p_actor,c.id,c.credential_id,c.root_folder_id,parent,p_file,s.drive_file_id,
  i.expected_name,i.mime_type,i.expected_size,p_checksum,handoff_expiry) returning * into u;
 return private.process_upload_binding(u);
exception when unique_violation then raise exception 'SOURCE_CHANGED' using errcode='55000';
end $$;

create or replace function public.service_start_process_upload(p_operation uuid,p_actor uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare o public.team_operations%rowtype;u private.process_upload_ownership%rowtype;
begin
 perform private.assert_active_process(p_operation,p_actor);
 select * into o from public.team_operations where id=p_operation and actor_id=p_actor for update;
 select * into u from private.process_upload_ownership where operation_id=o.id for update;
 if o.id is null or o.kind<>'process' or o.state<>'running' or u.operation_id is null
  or u.upload_state<>'prepared' or u.cleanup_state<>'not_needed' then
  raise exception 'WRONG_STATE' using errcode='55000';end if;
 if not private.can(o.team_id,'process',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if u.handoff_expires_at<=clock_timestamp() or not exists(
  select 1 from private.team_transfer_grants g where g.operation_id=o.id and g.actor_id=p_actor
   and g.team_id=o.team_id and g.purpose='finalize' and g.revoked_at is null and g.expires_at>clock_timestamp())
 then raise exception 'EXPIRED' using errcode='55000';end if;
 if not exists(select 1 from public.team_drive_connections c where c.id=u.connection_id and c.team_id=u.team_id
  and c.state='connected' and c.credential_id=u.credential_id and c.root_folder_id=u.root_id)
 then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 update private.process_upload_ownership set upload_state='started',updated_at=clock_timestamp() where operation_id=o.id;
 return true;
end $$;

create or replace function public.service_finalize_uploaded_material(p_operation uuid, p_actor uuid, p_drive jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  operation_row public.team_operations%rowtype;
  intent_row private.team_operation_intents%rowtype;
  destination public.team_materials%rowtype;
  -- The space root is not a material, so a root upload has no destination row:
  -- these two carry what the rest of the function actually needs from it.
  destination_connection_id uuid;
  destination_drive_file_id text;
  source public.team_materials%rowtype;
  result_row public.team_materials%rowtype;
  actual_drive_file_id text;
  actual_name text;
  actual_mime text;
  actual_parent text;
  actual_kind text;
  actual_category text;
  actual_extension text;
  actual_classification_source text;
  actual_size bigint;
  actual_modified_at timestamptz;
  actual_version text;
  actual_checksum text;
  actual_drive_id text;
  actual_resource_key text;
  required_permission text;
begin
 perform private.assert_active_process(p_operation,p_actor,true);
  if pg_catalog.jsonb_typeof(p_drive) <> 'object'
     or exists (
       select 1 from pg_catalog.jsonb_object_keys(p_drive) as key(name)
       where key.name not in (
         'driveFileId','driveId','resourceKey','parentFolderId','name','mimeType',
         'fileExtension','kind','category','classificationSource','sizeBytes',
         'modifiedAt','driveVersion','checksum'
       )
     ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select operation.* into operation_row
  from public.team_operations as operation
  where operation.id = p_operation and operation.actor_id = p_actor
  for update;
  if operation_row.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if operation_row.state = 'succeeded' and operation_row.result_material_id is not null then
    return pg_catalog.jsonb_build_object(
      'operationId', operation_row.id,
      'state', operation_row.state,
      'materialId', operation_row.result_material_id,
      'reused', true
    );
  end if;
  if operation_row.kind not in ('upload','new_version','process')
     or operation_row.state not in ('pending','running') then
    raise exception 'WRONG_STATE' using errcode = '23514';
  end if;
  required_permission := case when operation_row.kind = 'process' then 'process' else 'upload' end;
  if not private.can(operation_row.team_id, required_permission, p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select intent.* into intent_row
  from private.team_operation_intents as intent
  where intent.operation_id = p_operation and intent.team_id = operation_row.team_id;
  if intent_row.operation_id is null then raise exception 'WRONG_STATE' using errcode = '23514'; end if;
  if operation_row.destination_folder_id is null then
    select connection.id, connection.root_folder_id
      into destination_connection_id, destination_drive_file_id
    from public.team_drive_connections as connection
    where connection.team_id = operation_row.team_id
      and connection.state = 'connected'
    order by connection.connected_at desc nulls last
    limit 1;
  else
    select folder.* into destination
    from public.team_materials as folder
    where folder.id = operation_row.destination_folder_id
      and folder.team_id = operation_row.team_id
      and folder.kind = 'folder'
      and folder.lifecycle = 'active';
    destination_connection_id := destination.connection_id;
    destination_drive_file_id := destination.drive_file_id;
  end if;
  if destination_drive_file_id is null or destination_connection_id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if operation_row.source_material_id is not null then
    select material.* into source
    from public.team_materials as material
    where material.id = operation_row.source_material_id
      and material.team_id = operation_row.team_id;
    if source.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    if intent_row.expected_source_drive_file_id is not null
       and (intent_row.version_of_material_id is null
            or intent_row.version_of_material_id <> operation_row.source_material_id)
       and (
      source.drive_file_id is distinct from intent_row.expected_source_drive_file_id
      or source.drive_version is distinct from intent_row.expected_source_version
      or source.checksum is distinct from intent_row.expected_source_checksum
    ) then
      raise exception 'SOURCE_CHANGED' using errcode = '23514';
    end if;
  end if;

  actual_drive_file_id := p_drive ->> 'driveFileId';
  actual_name := p_drive ->> 'name';
  actual_mime := p_drive ->> 'mimeType';
  actual_parent := p_drive ->> 'parentFolderId';
  actual_kind := coalesce(p_drive ->> 'kind', 'file');
  actual_category := p_drive ->> 'category';
  actual_extension := p_drive ->> 'fileExtension';
  actual_classification_source := coalesce(p_drive ->> 'classificationSource', 'fallback');
  actual_size := nullif(p_drive ->> 'sizeBytes', '')::bigint;
  actual_modified_at := nullif(p_drive ->> 'modifiedAt', '')::timestamptz;
  actual_version := p_drive ->> 'driveVersion';
  actual_checksum := p_drive ->> 'checksum';
  actual_drive_id := p_drive ->> 'driveId';
  actual_resource_key := p_drive ->> 'resourceKey';
  if actual_drive_file_id is null or char_length(actual_drive_file_id) not between 1 and 1024
     or actual_name is distinct from intent_row.expected_name
     or actual_mime is distinct from intent_row.mime_type
     or actual_parent is distinct from destination_drive_file_id
     or actual_kind <> 'file'
     or actual_category not in ('video','image','archive','transcript','landing','other')
     or actual_classification_source not in ('mime','extension','inspected_landing','fallback')
     or actual_size is distinct from intent_row.expected_size
     or intent_row.replace_material_id is null and source.id is not null
        and actual_drive_file_id = source.drive_file_id
        and (intent_row.version_of_material_id is null
             or intent_row.version_of_material_id <> operation_row.source_material_id)
     or intent_row.replace_material_id is not null and not exists (
       select 1 from public.team_materials as replacement
       where replacement.id = intent_row.replace_material_id
         and replacement.team_id = operation_row.team_id
         and replacement.drive_file_id = actual_drive_file_id
     ) then
    raise exception 'SOURCE_CHANGED' using errcode = '23514';
  end if;

  if intent_row.replace_material_id is not null then
    update public.team_materials as material
    set connection_id = destination_connection_id,
        drive_id = actual_drive_id,
        resource_key = actual_resource_key,
        parent_folder_id = actual_parent,
        name = actual_name,
        mime_type = actual_mime,
        file_extension = actual_extension,
        kind = 'file',
        category = actual_category,
        classification_version = 1,
        classification_source = actual_classification_source,
        size_bytes = actual_size,
        modified_at = actual_modified_at,
        drive_version = actual_version,
        checksum = actual_checksum,
        lifecycle = 'active',
        trashed_at = null,
        missing_at = null,
        transcript_text = null,
        transcript_ingest_state = case when actual_category = 'transcript' then 'pending' else 'not_applicable' end,
        transcript_truncated = false,
        transcript_indexed_bytes = 0,
        transcript_source_version = null,
        transcript_source_checksum = null,
        preview_state = 'pending',
        preview_error_code = null,
        updated_at = pg_catalog.clock_timestamp()
    where material.id = intent_row.replace_material_id
      and material.team_id = operation_row.team_id
    returning material.* into result_row;
  else
    insert into public.team_materials (
      team_id, connection_id, drive_file_id, drive_id, resource_key,
      parent_folder_id, name, mime_type, file_extension, kind, category,
      classification_version, classification_source, size_bytes, modified_at,
      drive_version, checksum, lifecycle, geo, language, offer, tags,
      transcript_ingest_state, preview_state
    ) values (
      operation_row.team_id, destination_connection_id, actual_drive_file_id, actual_drive_id, actual_resource_key,
      actual_parent, actual_name, actual_mime, actual_extension, 'file', actual_category,
      1, actual_classification_source, actual_size, actual_modified_at,
      actual_version, actual_checksum, 'active', source.geo, source.language, source.offer,
      coalesce(source.tags, '{}'::text[]),
      case when actual_category = 'transcript' then 'pending' else 'not_applicable' end,
      'pending'
    )
    on conflict (team_id, drive_file_id) do update
    set connection_id = excluded.connection_id,
        drive_id = excluded.drive_id,
        resource_key = excluded.resource_key,
        parent_folder_id = excluded.parent_folder_id,
        name = excluded.name,
        mime_type = excluded.mime_type,
        file_extension = excluded.file_extension,
        category = excluded.category,
        classification_version = excluded.classification_version,
        classification_source = excluded.classification_source,
        size_bytes = excluded.size_bytes,
        modified_at = excluded.modified_at,
        drive_version = excluded.drive_version,
        checksum = excluded.checksum,
        lifecycle = 'active',
        trashed_at = null,
        missing_at = null,
        updated_at = pg_catalog.clock_timestamp()
    returning public.team_materials.* into result_row;
  end if;

  if intent_row.relation is not null and source.id is distinct from result_row.id then
    if source.id is null or source.id = result_row.id then
      raise exception 'MATERIAL_LINK_CYCLE' using errcode = '23514';
    end if;
    insert into public.team_material_links (
      team_id, source_material_id, derivative_material_id, relation,
      source_name_snapshot, tool_id, tool_contract_version, created_by
    ) values (
      operation_row.team_id, source.id, result_row.id, intent_row.relation,
      source.name, intent_row.tool_id, intent_row.tool_contract_version, p_actor
    ) on conflict (team_id, source_material_id, derivative_material_id, relation) do nothing;
  end if;

  if operation_row.state = 'pending' then
    update public.team_operations set state = 'running', stage = 'finalizing', updated_at = pg_catalog.clock_timestamp()
    where id = p_operation;
  end if;
  update public.team_operations as operation
  set state = 'succeeded',
      stage = 'completed',
      progress = 100,
      result_material_id = result_row.id,
      bytes_completed = case
        when operation.kind = 'process' then coalesce(operation.bytes_total, 0)
        else coalesce(intent_row.expected_size, 0)
      end,
      error_code = null,
      retryable = false,
      reservation_released_at = coalesce(operation.reservation_released_at, pg_catalog.clock_timestamp()),
      finished_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  where operation.id = p_operation;
  update private.team_operation_intents
  set provider_result_id = actual_drive_file_id, updated_at = pg_catalog.clock_timestamp()
  where operation_id = p_operation;
  update private.team_transfer_grants
  set revoked_at = pg_catalog.clock_timestamp()
  where operation_id = p_operation and revoked_at is null;
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (operation_row.team_id, result_row.id, 'upserted');
  perform private.record_team_audit(
    operation_row.team_id, p_actor,
    case operation_row.kind
      when 'new_version' then 'material.version_created'
      when 'process' then 'material.processed'
      else 'material.uploaded'
    end,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'material_id', result_row.id,
      'operation_id', p_operation,
      'relation', intent_row.relation
    )),
    'succeeded', null
  );
  return pg_catalog.jsonb_build_object(
    'operationId', p_operation,
    'state', 'succeeded',
    'materialId', result_row.id,
    'reused', false
  );
end;
$function$;


create or replace function private.consume_team_transfer_grant(
  p_token_hash bytea,
  p_purpose text
)
returns table (
  grant_id uuid,
  operation_id uuid,
  team_id uuid,
  actor_id uuid,
  material_id uuid,
  destination_folder_id uuid,
  tool_id text,
  max_range_bytes integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  grant_row private.team_transfer_grants%rowtype;
  permission text;
begin
  select transfer.* into grant_row
  from private.team_transfer_grants as transfer
  where transfer.token_hash = p_token_hash
  for update;

  if grant_row.id is not null and grant_row.purpose in ('process_input','process_output','finalize') and (grant_row.tool_id='translation' or exists (select 1 from private.team_operation_intents i where i.operation_id=grant_row.operation_id and i.tool_id='translation')) then
    raise exception 'FEATURE_RETIRED' using errcode='P0001';
  end if;
  if grant_row.id is null
     or grant_row.purpose <> p_purpose
     or grant_row.revoked_at is not null
     or grant_row.expires_at <= clock_timestamp()
     or grant_row.uses >= grant_row.max_uses then
    return;
  end if;

  permission := case grant_row.purpose
    when 'preview_range' then 'view'
    when 'download_range' then 'download'
    when 'process_input' then 'process'
    when 'process_output' then 'upload'
    when 'finalize' then 'upload'
    when 'thumbnail_session' then 'view'
  end;
  if not private.can(grant_row.team_id, permission, grant_row.actor_id) then
    return;
  end if;

  update private.team_transfer_grants
  set uses = uses + 1
  where id = grant_row.id;

  return query select grant_row.id,
                      grant_row.operation_id,
                      grant_row.team_id,
                      grant_row.actor_id,
                      grant_row.material_id,
                      grant_row.destination_folder_id,
                      grant_row.tool_id,
                      grant_row.max_range_bytes;
end;
$$;


-- Freeze all unfinished work. Existing ready/succeeded results and companion links remain intact.
update private.team_library_attempts a set state='canceled',error_code='FEATURE_RETIRED',
 finished_at=clock_timestamp(),updated_at=clock_timestamp()
 from public.team_library_requirements r
 where a.requirement_id=r.id and r.kind='translation' and a.state in ('leased','running');
update public.team_library_requirements set state='canceled',last_error_code='FEATURE_RETIRED',updated_at=clock_timestamp()
 where kind='translation' and state in ('pending','leased','running','failed','stale');
update private.team_transfer_grants g set revoked_at=clock_timestamp()
 from private.team_operation_intents i where g.operation_id=i.operation_id
 and i.tool_id='translation' and g.purpose in ('process_input','process_output','finalize') and g.revoked_at is null;
update public.team_operations o set state='canceled',stage='canceled',error_code='FEATURE_RETIRED',
 retryable=false,finished_at=clock_timestamp(),updated_at=clock_timestamp()
 from private.team_operation_intents i where i.operation_id=o.id and i.tool_id='translation'
 and o.state in ('pending','running');

-- Defense against older writers: historical rows are readable but never executable again.
create or replace function private.fence_retired_library_work() returns trigger
language plpgsql security definer set search_path='' as $$
declare k text;
begin
 if tg_table_name='team_library_requirements' then
  k:=new.kind;
  if k='translation' and (tg_op='INSERT' or new.state in ('pending','leased','running','ready','failed','stale')) then
   raise exception 'FEATURE_RETIRED' using errcode='P0001';end if;
 elsif tg_table_name='team_library_attempts' then
  select kind into k from public.team_library_requirements where id=new.requirement_id;
  if k='translation' then raise exception 'FEATURE_RETIRED' using errcode='P0001';end if;
 elsif tg_table_name='team_library_results' then
  if new.kind='translation' then raise exception 'FEATURE_RETIRED' using errcode='P0001';end if;
 elsif tg_table_name='team_contribution_records' then
  if new.action_kind='translation' then raise exception 'FEATURE_RETIRED' using errcode='P0001';end if;
 end if;
 return new;
end; $$;
revoke all on function private.fence_retired_library_work() from public,anon,authenticated,service_role;
create trigger retirement_requirements before insert or update of kind,state on public.team_library_requirements
 for each row execute function private.fence_retired_library_work();
create trigger retirement_attempts before insert or update of state on private.team_library_attempts
 for each row execute function private.fence_retired_library_work();
create trigger retirement_results before insert or update of kind,state on public.team_library_results
 for each row execute function private.fence_retired_library_work();
create trigger retirement_contributions before insert on public.team_contribution_records
 for each row execute function private.fence_retired_library_work();

create or replace function private.fence_retired_process_work() returns trigger
language plpgsql security definer set search_path='' as $$
declare k text;
begin
 if tg_table_name='team_operation_intents' then
  if new.tool_id='translation' then raise exception 'FEATURE_RETIRED' using errcode='P0001';end if;
 elsif tg_table_name='team_operations' then
  select i.tool_id into k from private.team_operation_intents i where i.operation_id=new.id;
  if k='translation' and new.state in ('pending','running','succeeded') then
   raise exception 'FEATURE_RETIRED' using errcode='P0001';end if;
 elsif tg_table_name='team_transfer_grants' then
  select i.tool_id into k from private.team_operation_intents i where i.operation_id=new.operation_id;
  if (k='translation' or new.tool_id='translation') and new.purpose in ('process_input','process_output','finalize') then
   raise exception 'FEATURE_RETIRED' using errcode='P0001';end if;
 end if;
 return new;
end; $$;
revoke all on function private.fence_retired_process_work() from public,anon,authenticated,service_role;
create trigger retirement_intent before insert or update of tool_id on private.team_operation_intents
 for each row execute function private.fence_retired_process_work();
create trigger retirement_operation before update of state on public.team_operations
 for each row execute function private.fence_retired_process_work();
create trigger retirement_grant before insert on private.team_transfer_grants
 for each row execute function private.fence_retired_process_work();
commit;
