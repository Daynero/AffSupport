-- A background re-stitch keeps what it read (071, owner 2026-11-25: «раз перезашили — далі за секунди»).
--
-- A manual «Скачати перезашите» stores what the agent found about the source (its edges and
-- profile) through set_material_restitch_prep, so the next re-stitch of that video skips the six
-- to fourteen seconds of reading — and the space's «Готово N з M» counts it. A catalog round or a
-- launch re-stitches through the agent's process path, which has no page to store anything: the
-- reading was repeated on every round and the counter never moved.
--
-- An agent from 1.6.4 sends the finding with the process output's finalize (`restitchPrep`),
-- and drive-ops hands it here once the output is committed. It is stored only when:
--   - the operation is a succeeded `process` with a source material, and the actor still may
--     `process` in that space (the same permission set_material_restitch_prep asks for);
--   - the Drive version the agent read is the material's current one (a record describes bytes);
--   - the finding is well formed (detector version ≥ 1, edges ≥ 0, a profile object);
--   - it does not replace a record for the same bytes from the same or a newer detector.
-- Anything else is answered false and nothing is written: the record is an optimisation, and a
-- refusal here never fails the file. An older agent sends nothing; nothing changes for it.
create or replace function public.service_record_material_restitch_prep(
  p_operation uuid,
  p_prep jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  op public.team_operations;
  material_team uuid;
  material_version text;
  detector integer;
  start_seconds numeric;
  end_seconds numeric;
  existing public.team_material_restitch_prep;
begin
  if p_operation is null or jsonb_typeof(p_prep) is distinct from 'object' then return false; end if;
  if jsonb_typeof(p_prep -> 'profile') is distinct from 'object'
     or jsonb_typeof(p_prep -> 'detectorVersion') is distinct from 'number'
     or jsonb_typeof(p_prep -> 'detectedStartSeconds') is distinct from 'number'
     or jsonb_typeof(p_prep -> 'detectedEndSeconds') is distinct from 'number'
     or jsonb_typeof(p_prep -> 'driveVersion') is distinct from 'string' then
    return false;
  end if;
  if (p_prep ->> 'detectorVersion')::numeric <> trunc((p_prep ->> 'detectorVersion')::numeric)
     or (p_prep ->> 'detectorVersion')::numeric not between 1 and 1000000 then
    return false;
  end if;
  detector := (p_prep ->> 'detectorVersion')::integer;
  start_seconds := (p_prep ->> 'detectedStartSeconds')::numeric;
  end_seconds := (p_prep ->> 'detectedEndSeconds')::numeric;
  if start_seconds < 0 or end_seconds < 0 or start_seconds > 86400 or end_seconds > 86400 then
    return false;
  end if;

  select * into op from public.team_operations where id = p_operation;
  if op.id is null or op.kind <> 'process' or op.state <> 'succeeded'
     or op.source_material_id is null then
    return false;
  end if;
  if not private.can(op.team_id, 'process', op.actor_id) then return false; end if;

  select team_id, drive_version into material_team, material_version
    from public.team_materials where id = op.source_material_id;
  if material_team is distinct from op.team_id
     or material_version is null
     or material_version is distinct from p_prep ->> 'driveVersion' then
    return false;
  end if;

  select * into existing from public.team_material_restitch_prep
    where material_id = op.source_material_id;
  if existing.material_id is not null
     and existing.drive_version = material_version
     and existing.detector_version >= detector
     and existing.unsupported_reason is null then
    return false;
  end if;

  insert into public.team_material_restitch_prep as prep (
    material_id, team_id, drive_version, detector_version,
    detected_start_seconds, detected_end_seconds,
    source_profile, unsupported_reason, prepared_at, prepared_by
  )
  values (
    op.source_material_id, op.team_id, material_version, detector,
    start_seconds, end_seconds, p_prep -> 'profile', null, clock_timestamp(), op.actor_id
  )
  on conflict (material_id) do update
    set drive_version = excluded.drive_version,
        detector_version = excluded.detector_version,
        detected_start_seconds = excluded.detected_start_seconds,
        detected_end_seconds = excluded.detected_end_seconds,
        source_profile = excluded.source_profile,
        unsupported_reason = null,
        prepared_at = excluded.prepared_at,
        prepared_by = excluded.prepared_by;
  return true;
end;
$$;

revoke all on function public.service_record_material_restitch_prep(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.service_record_material_restitch_prep(uuid, jsonb) to service_role;
