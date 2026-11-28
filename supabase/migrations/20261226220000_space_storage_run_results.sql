-- 057 (deferred from T035): what a finished tool run in an R2 space leaves behind, as on Drive.
--
-- 1. A transcription's text file is read back and its text kept on the material for search,
--    as `cacheGeneratedTextResult` does for Drive with `service_commit_catalog_transcript`. An R2
--    material has no Drive version or checksum; its bytes are named by its content id, so the
--    commit is bound to that instead: it lands only while the file still holds those bytes.
--    `transcript_source_version` stays null, as `team_materials_transcript_identity_check` asks
--    of a row without a Drive version (relaxing that check would rescan the whole table).
-- 2. A background re-stitch reports what it found about its source (071). The record is bound to
--    the bytes it describes: the Drive version for a Drive file (unchanged), the content id for a
--    file of an R2 space (the agent's `sourceVersion` for an R2 source is its content id).
--
-- Drive materials take exactly the paths they took: the transcript commit for Drive is
-- untouched, and in the prep recorder `coalesce(drive_version, …)` is the Drive version whenever
-- the material has one.

create function public.service_commit_space_transcript(
  p_material uuid,
  p_content_id text,
  p_expected_extension text,
  p_state text,
  p_text text,
  p_indexed_bytes integer,
  p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_team uuid;
begin
  if p_state not in ('full', 'truncated', 'invalid_encoding', 'unavailable')
     or p_content_id is null or p_content_id !~ '^[0-9a-f]{64}$'
     or p_indexed_bytes is null or p_indexed_bytes not between 0 and 1048576
     or (p_text is not null and pg_catalog.octet_length(p_text) > 1048576)
     or (p_error_code is not null and p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update public.team_materials as material
  set transcript_text = case when p_state in ('full', 'truncated') then p_text else null end,
      transcript_ingest_state = p_state,
      transcript_truncated = p_state = 'truncated',
      transcript_indexed_bytes = p_indexed_bytes,
      transcript_source_version = null,
      transcript_source_checksum = null,
      transcript_ingested_at = clock_timestamp(),
      transcript_error_code = p_error_code,
      updated_at = clock_timestamp()
  from public.space_objects as object
  where material.id = p_material
    and material.lifecycle = 'active'
    and material.category = 'transcript'
    and material.connection_id is null
    and material.file_extension is not distinct from p_expected_extension
    and object.id = material.space_object_id
    and object.team_id = material.team_id
    and object.kind = 'original'
    and object.state = 'committed'
    and object.content_id = p_content_id
  returning material.team_id into resolved_team;
  if resolved_team is null then return false; end if;
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (resolved_team, p_material, 'upserted');
  return true;
end;
$$;
revoke all on function public.service_commit_space_transcript(uuid, text, text, text, text, integer, text)
from public, anon, authenticated;
grant execute on function public.service_commit_space_transcript(uuid, text, text, text, text, integer, text)
to service_role;

do $prep$
declare d text;
begin
  select pg_get_functiondef('public.service_record_material_restitch_prep(uuid,jsonb)'::regprocedure) into d;
  if strpos(d, $find$select team_id, drive_version into material_team, material_version
    from public.team_materials where id = op.source_material_id;$find$) = 0 then
    raise exception 'RESTITCH_PREP_SPACE_PATCH_MISSING';
  end if;
  d := replace(d, $find$select team_id, drive_version into material_team, material_version
    from public.team_materials where id = op.source_material_id;$find$,
    $replace$select material.team_id, coalesce(material.drive_version, object.content_id)
      into material_team, material_version
    from public.team_materials as material
    left join public.space_objects as object
      on object.id = material.space_object_id and object.team_id = material.team_id
     and object.kind = 'original' and object.state = 'committed'
    where material.id = op.source_material_id;$replace$);
  execute d;
end $prep$;
