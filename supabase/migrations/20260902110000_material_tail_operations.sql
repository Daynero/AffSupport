-- A material's tail travels with it (owner, 2026-09-02).
--
-- A video owns one transcript and a landing owns its rendered preview. Moving
-- and renaming already carried the transcript along; copying carried nothing,
-- so a pasted video arrived without its text and a pasted landing arrived with
-- a blank tile and a render to redo — for bytes that had not changed.
--
-- Three pieces here:
--
--   * link_transcript_companion — the caller-authorized way to say "this .txt
--     belongs to that video", so a copy can link the copy it just made. The
--     service function behind it stays service-only.
--   * service_clone_material_extras — everything about a copy that is already
--     known because the bytes are identical: a transcript's text, a zip's
--     landing classification, and the landing render, pointed at the same
--     artifact. Not the provider thumbnail: that picture belongs to a
--     particular Drive file and does not exist for one made a second ago.
--   * service_invalidate_landing_renders — now that two rows can share an
--     artifact folder, only hand one to the worker for deletion when nothing
--     else still points at it.

create or replace function public.link_transcript_companion(
  p_team uuid,
  p_video uuid,
  p_companion uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.can(p_team, 'edit', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  -- The service function owns the rules (one live companion per video, the
  -- previous one retired and reported). Nothing is retired for a fresh copy;
  -- the caller has no Drive client, so this path never has files to trash.
  return public.service_link_transcript_companion(p_team, p_video, p_companion, null, null);
end;
$$;

revoke all on function public.link_transcript_companion(uuid, uuid, uuid) from public, anon;
grant execute on function public.link_transcript_companion(uuid, uuid, uuid) to authenticated;

create or replace function public.service_clone_material_extras(
  p_team uuid,
  p_source uuid,
  p_copy uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_row public.team_materials%rowtype;
  copy_row public.team_materials%rowtype;
  renders integer := 0;
begin
  select * into source_row from public.team_materials as material
   where material.id = p_source and material.team_id = p_team;
  select * into copy_row from public.team_materials as material
   where material.id = p_copy and material.team_id = p_team and material.lifecycle = 'active';
  if source_row.id is null or copy_row.id is null then
    return jsonb_build_object('thumbnail', false, 'renders', 0);
  end if;

  -- Deliberately NOT copied: the provider thumbnail. It is a picture Google
  -- makes for a particular file, and it does not exist for one created a second
  -- ago. Marking the copy 'ready' produced a tile that asked for an image that
  -- was not there and, because nothing revisits a ready row, kept the broken
  -- glyph for good. The ordinary pending pass fills it in within a minute.

  -- A transcript copy is the same bytes, so it is the same text. Without this
  -- the copy is linked to the copied video and still reads as "no transcript
  -- yet" until something re-reads the file — the card offers Transcribe for
  -- text that is already sitting there.
  update public.team_materials as target
     set transcript_text = source_row.transcript_text,
         transcript_ingest_state = source_row.transcript_ingest_state,
         transcript_truncated = source_row.transcript_truncated,
         transcript_indexed_bytes = source_row.transcript_indexed_bytes,
         transcript_source_version = target.drive_version,
         transcript_source_checksum = target.checksum,
         transcript_ingested_at = pg_catalog.clock_timestamp(),
         transcript_error_code = source_row.transcript_error_code,
         updated_at = pg_catalog.clock_timestamp()
   where target.id = p_copy
     and target.team_id = p_team
     and source_row.category = 'transcript'
     and source_row.transcript_ingest_state in ('full', 'truncated');

  -- A zip is filed as an archive until something looks inside it and finds a
  -- landing page. The copy is the same bytes, so it is the same answer: without
  -- this the copy arrives as a plain archive, with no preview and a fresh
  -- inspection to wait for.
  update public.team_materials as target
     set category = source_row.category,
         landing_validation_state = source_row.landing_validation_state,
         landing_validation_version = target.drive_version,
         landing_validation_fingerprint = source_row.landing_validation_fingerprint,
         updated_at = pg_catalog.clock_timestamp()
   where target.id = p_copy
     and target.team_id = p_team
     and source_row.category = 'landing'
     and target.category = 'archive';

  -- A landing render is a folder of WebP segments in Drive. The copy is the
  -- same bytes, so it points at the same folder rather than rendering it again;
  -- `service_invalidate_landing_renders` keeps that folder alive while anything
  -- still refers to it.
  insert into public.team_landing_renders (
    team_id, material_id, preset, source_version, source_checksum, fingerprint,
    render_state, failure_reason, artifact_root, segment_count, rendered_by
  )
  select p_team,
         p_copy,
         render.preset,
         copy_row.drive_version,
         copy_row.checksum,
         render.fingerprint,
         render.render_state,
         render.failure_reason,
         render.artifact_root,
         render.segment_count,
         render.rendered_by
  from public.team_landing_renders as render
  where render.team_id = p_team
    and render.material_id = p_source
    and render.render_state = 'ready'
    and render.artifact_root is not null
    and render.segment_count >= 1
  on conflict (team_id, material_id, preset) do nothing;
  get diagnostics renders = row_count;

  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (p_team, p_copy, 'upserted');
  return jsonb_build_object(
    'transcript', source_row.transcript_ingest_state in ('full', 'truncated'),
    'landing', source_row.category = 'landing',
    'renders', renders
  );
end;
$$;

revoke all on function public.service_clone_material_extras(uuid, uuid, uuid)
from public, anon, authenticated;
grant execute on function public.service_clone_material_extras(uuid, uuid, uuid) to service_role;

create or replace function public.service_invalidate_landing_renders(
  p_connection uuid,
  p_drive_file_ids text[]
)
returns table (
  team_id uuid,
  material_id uuid,
  artifact_root text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with targets as materialized (
    select render.id,
           render.team_id,
           render.material_id,
           render.artifact_root
    from public.team_landing_renders as render
    join public.team_materials as material
      on material.id = render.material_id
     and material.team_id = render.team_id
    where material.connection_id = p_connection
      and material.drive_file_id = any(p_drive_file_ids)
      and render.render_state <> 'stale'
  ), updated as (
    update public.team_landing_renders as render
       set render_state = 'stale',
           artifact_root = null,
           segment_count = 0,
           updated_at = pg_catalog.clock_timestamp()
      from targets
     where render.id = targets.id
    returning targets.team_id, targets.material_id, targets.artifact_root
  ), events as (
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    select distinct updated.team_id, updated.material_id, 'upserted'
    from updated
    returning 1
  )
  -- A copy shares its original's artifact folder, so the worker is only told to
  -- delete one that nothing points at any more. Deleting a shared folder would
  -- leave the other row claiming a preview whose files are gone.
  select updated.team_id, updated.material_id, updated.artifact_root
  from updated
  where updated.artifact_root is not null
    and not exists (
      select 1
      from public.team_landing_renders as keeper
      where keeper.artifact_root = updated.artifact_root
    );
end;
$$;

revoke all on function public.service_invalidate_landing_renders(uuid, text[])
from public, anon, authenticated, service_role;
grant execute on function public.service_invalidate_landing_renders(uuid, text[])
to service_role;
