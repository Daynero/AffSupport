-- Incident 2026-11-17: transcripts with a file in Drive and no text in the catalog.
--
-- A transcript row is written `pending` and only the change feed ever read its text, on the
-- page that carried the file. Two paths left rows pending for good: the feed's last page
-- completed the job first and its lease-checked ingest then refused every write (fixed in the
-- worker), and a folder walk (initial scan, a person's "sync this folder", reconcile) commits
-- rows through service_commit_catalog_scan_page, which never reads a transcript at all. Fifty
-- rows across eleven spaces had been waiting since 2026-09-28; a library batch is where it
-- shows, because those videos keep being offered as untranscribed.
--
-- The worker now sweeps what is left after each poll of the feed: a few pending rows of the
-- connection that have waited past the feed's own turn, oldest first. The commit stays fenced
-- by the row's version and checksum, so a file that moved while it was read is left pending
-- for the next sweep.
begin;

create index if not exists team_materials_pending_transcripts_idx
  on public.team_materials (connection_id, updated_at)
  where category = 'transcript' and lifecycle = 'active' and transcript_ingest_state = 'pending';

create or replace function public.service_list_waiting_catalog_transcripts(
  p_connection uuid,
  p_limit integer default 20,
  p_waited_seconds integer default 120
)
returns table(
  material_id uuid, drive_file_id text, resource_key text, drive_version text,
  checksum text, mime_type text, file_extension text
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_connection is null or p_limit is null or p_limit not between 1 and 50
     or p_waited_seconds is null or p_waited_seconds not between 0 and 86400 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return query
  select material.id, material.drive_file_id, material.resource_key,
         material.drive_version, material.checksum, material.mime_type, material.file_extension
  from public.team_materials as material
  where material.connection_id = p_connection
    and material.category = 'transcript'
    and material.lifecycle = 'active'
    and material.transcript_ingest_state = 'pending'
    and material.updated_at <= clock_timestamp() - make_interval(secs => p_waited_seconds)
  order by material.updated_at, material.id
  limit p_limit;
end;
$$;

revoke all on function public.service_list_waiting_catalog_transcripts(uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.service_list_waiting_catalog_transcripts(uuid, integer, integer)
  to service_role;

commit;
