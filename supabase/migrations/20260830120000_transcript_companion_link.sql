-- 012 (T005): the server side of turning a transcript into a companion. Two
-- pure steps the finalize/agent path composes with an actual Drive .txt upload:
--
--   * find_transcript_by_fingerprint — before transcribing, ask whether an
--     identical audio was already transcribed in this space; if so its text is
--     reused rather than recomputed (compute-time dedup, FR-T2).
--   * link_transcript_companion — after the .txt material exists, link it to
--     its video, record the fingerprint, and trash the video's previous
--     companion (FR-T1/FR-T3). Names and placement are the caller's job (the
--     upload already put the file beside the video, named after it).

create or replace function public.service_find_transcript_by_fingerprint(
  p_team uuid,
  p_fingerprint text
)
returns table (transcript_text text, source_version text, source_checksum text)
language sql
security definer
set search_path = ''
as $$
  select companion.transcript_text,
         companion.transcript_source_version,
         companion.transcript_source_checksum
  from public.team_materials as companion
  where companion.team_id = p_team
    and companion.audio_fingerprint = p_fingerprint
    and companion.companion_kind = 'transcript'
    and companion.lifecycle = 'active'
    and companion.transcript_text is not null
    and length(btrim(companion.transcript_text)) > 0
  order by companion.created_at desc
  limit 1;
$$;

revoke all on function public.service_find_transcript_by_fingerprint(uuid, text)
from public, anon, authenticated;
grant execute on function public.service_find_transcript_by_fingerprint(uuid, text) to service_role;

create or replace function public.service_link_transcript_companion(
  p_team uuid,
  p_video uuid,
  p_companion uuid,
  p_fingerprint text,
  p_text text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  video_row public.team_materials%rowtype;
  companion_row public.team_materials%rowtype;
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
    return false;
  end if;

  -- The video keeps one live transcript companion: retire any earlier one.
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
     and previous.id <> p_companion;

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
  return true;
end;
$$;

revoke all on function public.service_link_transcript_companion(uuid, uuid, uuid, text, text)
from public, anon, authenticated;
grant execute on function public.service_link_transcript_companion(uuid, uuid, uuid, text, text)
to service_role;
