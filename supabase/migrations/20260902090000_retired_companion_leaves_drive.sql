-- The transcript a repeat replaces has to leave Google Drive too.
--
-- `service_link_transcript_companion` retired the previous companion in the
-- catalog and nowhere else, so the file stayed in the Drive folder: invisible
-- in Soty, still holding the name the video expects. The next transcription
-- asked for `16-tail.txt`, found it taken, and was written as `16-tail (2).txt`
-- — one more parenthesis every run, and a folder that no longer matched what
-- Soty showed (owner, 2026-09-02).
--
-- The function now hands back what it retired, so the caller — which has the
-- Drive client and the credentials this function does not — can trash the file
-- for real. The return type changes from boolean to jsonb, hence the drop.

drop function if exists public.service_link_transcript_companion(uuid, uuid, uuid, text, text);

create function public.service_link_transcript_companion(
  p_team uuid,
  p_video uuid,
  p_companion uuid,
  p_fingerprint text,
  p_text text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  video_row public.team_materials%rowtype;
  companion_row public.team_materials%rowtype;
  retired jsonb;
begin
  if p_fingerprint is not null and p_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into video_row from public.team_materials as material
  where material.id = p_video and material.team_id = p_team and material.lifecycle = 'active'
  for update;
  select * into companion_row from public.team_materials as material
  where material.id = p_companion and material.team_id = p_team and material.lifecycle = 'active'
  for update;
  if video_row.id is null
     or companion_row.id is null
     or video_row.category is distinct from 'video'
     or companion_row.category is distinct from 'transcript' then
    return jsonb_build_object('linked', false, 'retired', '[]'::jsonb);
  end if;

  -- The video keeps one live transcript companion: retire any earlier one, and
  -- report it so the file itself can follow the catalog row into the trash.
  with retired_rows as (
    update public.team_materials as previous
       set lifecycle = 'trashed',
           trashed_at = pg_catalog.clock_timestamp(),
           companion_of = null,
           companion_kind = null,
           updated_at = pg_catalog.clock_timestamp()
     where previous.team_id = p_team
       and previous.companion_of = p_video
       and previous.companion_kind = 'transcript'
       and previous.lifecycle = 'active'
       and previous.id <> p_companion
    returning previous.id, previous.drive_file_id, previous.resource_key
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'materialId', retired_rows.id,
               'driveFileId', retired_rows.drive_file_id,
               'resourceKey', retired_rows.resource_key
             )
           ),
           '[]'::jsonb
         )
    into retired
  from retired_rows;

  update public.team_materials as companion
     set companion_of = p_video,
         companion_kind = 'transcript',
         audio_fingerprint = p_fingerprint,
         transcript_text = coalesce(p_text, companion.transcript_text),
         transcript_ingest_state = case
           when p_text is not null and length(btrim(p_text)) > 0 then 'full'
           else companion.transcript_ingest_state end,
         transcript_source_version = case
           when p_text is not null and length(btrim(p_text)) > 0 then companion.drive_version
           else companion.transcript_source_version end,
         transcript_source_checksum = case
           when p_text is not null and length(btrim(p_text)) > 0 then companion.checksum
           else companion.transcript_source_checksum end,
         updated_at = pg_catalog.clock_timestamp()
   where companion.id = p_companion and companion.team_id = p_team;

  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (p_team, p_companion, 'upserted'), (p_team, p_video, 'upserted');
  return jsonb_build_object('linked', true, 'retired', retired);
end;
$$;

revoke all on function public.service_link_transcript_companion(uuid, uuid, uuid, text, text)
from public, anon, authenticated;
grant execute on function public.service_link_transcript_companion(uuid, uuid, uuid, text, text)
to service_role;
