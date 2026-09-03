-- Which detector read a material, so a fixed detector is not ignored on the files it was
-- fixed for.
--
-- `team_material_restitch_prep` is a cached answer about a file's bytes, invalidated by
-- `drive_version`. That says the file has not changed. It says nothing about whether the code
-- that read the file has — and when the tail search was taught to see through a screen that
-- was already there, every material prepared by the previous build kept being cut by the
-- previous build's answer. The fix was invisible on exactly the files it was written for.
--
-- Existing rows take 0, which no build claims, so they are re-inspected once and replaced.

alter table public.team_material_restitch_prep
  add column if not exists detector_version integer not null default 0;

grant select (detector_version) on public.team_material_restitch_prep to authenticated;

create or replace function public.set_material_restitch_prep(
  p_material uuid,
  p_drive_version text,
  p_prep jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team uuid;
begin
  select team_id into v_team from public.team_materials where id = p_material;
  if v_team is null then
    raise exception 'RESTITCH_INVALID' using errcode = '22023';
  end if;
  -- Writing what a run found is part of running a tool, so it is the `process` permission.
  if auth.uid() is null or not private.can(v_team, 'process', auth.uid()) then
    raise exception 'RESTITCH_FORBIDDEN' using errcode = '42501';
  end if;
  -- A servable material must carry a profile; a refusal carries none and needs none, and
  -- storing it is the whole point — the refusal is then never re-derived.
  if p_drive_version is null or p_drive_version = ''
     or (jsonb_typeof(p_prep -> 'profile') <> 'object'
         and coalesce(p_prep ->> 'unsupportedReason', '') = '') then
    raise exception 'RESTITCH_INVALID' using errcode = '22023';
  end if;

  insert into public.team_material_restitch_prep as prep (
    material_id, team_id, drive_version, detector_version,
    detected_start_seconds, detected_end_seconds,
    source_profile, unsupported_reason, prepared_at, prepared_by
  )
  values (
    p_material, v_team, p_drive_version,
    greatest(0, coalesce((p_prep ->> 'detectorVersion')::integer, 0)),
    coalesce((p_prep ->> 'detectedStartSeconds')::numeric, 0),
    coalesce((p_prep ->> 'detectedEndSeconds')::numeric, 0),
    case when jsonb_typeof(p_prep -> 'profile') = 'object' then p_prep -> 'profile' end,
    nullif(p_prep ->> 'unsupportedReason', ''),
    clock_timestamp(), auth.uid()
  )
  on conflict (material_id) do update
    set drive_version = excluded.drive_version,
        detector_version = excluded.detector_version,
        detected_start_seconds = excluded.detected_start_seconds,
        detected_end_seconds = excluded.detected_end_seconds,
        source_profile = excluded.source_profile,
        unsupported_reason = excluded.unsupported_reason,
        prepared_at = excluded.prepared_at,
        prepared_by = excluded.prepared_by;
  return true;
end;
$$;
