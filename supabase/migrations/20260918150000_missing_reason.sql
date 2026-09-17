-- Feature 024 US24 — a file taken out of the space is not a file deleted.
--
-- The catalogue marks both the same way: `missing`. One means the video was deleted or lost to
-- us; the other means somebody moved it to a folder Soty does not watch — the file is alive and
-- well, and clearing its catalog and its text would destroy work nobody asked to lose. The reason
-- is recorded beside the state, and only a deletion lets the cleanup touch anything.
-- Forward-only; ROLLBACK.md drops the column and re-applies the tombstone function.

alter table public.team_materials
  add column if not exists missing_reason text
    check (missing_reason is null or missing_reason in ('removed', 'out_of_root'));

create or replace function public.service_tombstone_catalog_files(p_connection uuid, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_team uuid;
  affected integer;
begin
  if pg_catalog.jsonb_typeof(p_items) <> 'array' or pg_catalog.jsonb_array_length(p_items) > 1000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select team_id into resolved_team from public.team_drive_connections where id = p_connection;
  if resolved_team is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  update public.team_materials as material
  set lifecycle = item.lifecycle,
      trashed_at = case when item.lifecycle = 'trashed' then clock_timestamp() else null end,
      missing_at = case when item.lifecycle = 'missing' then clock_timestamp() else null end,
      missing_reason = case
        when item.lifecycle <> 'missing' then null
        when item.reason in ('removed', 'out_of_root') then item.reason
        else 'removed'
      end,
      transcript_text = null,
      transcript_ingest_state = 'unavailable',
      transcript_truncated = false,
      transcript_indexed_bytes = 0,
      transcript_error_code = case when item.lifecycle = 'trashed' then 'SOURCE_TRASHED' else 'SOURCE_MISSING' end,
      updated_at = clock_timestamp()
  from pg_catalog.jsonb_to_recordset(p_items) as item(file_id text, lifecycle text, reason text)
  where material.connection_id = p_connection
    and material.drive_file_id = item.file_id
    and item.lifecycle in ('trashed', 'missing');
  get diagnostics affected = row_count;
  if affected > 0 then
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    values (resolved_team, null, 'tombstoned');
  end if;
  return affected;
end;
$$;

revoke all on function public.service_tombstone_catalog_files(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.service_tombstone_catalog_files(uuid, jsonb) to service_role;

/*
 * The cleanup follows the reason: a video in Drive's bin, or one that is gone for good. A video
 * moved out of the watched folder is left alone — with its sheet, its text and its copies.
 */
create or replace function private.queue_orphan_cleanups(p_grace interval default interval '24 hours')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  queued integer;
begin
  delete from private.orphan_cleanups as item
  using public.team_materials as companion
  where companion.id = item.material_id
    and (
      companion.lifecycle <> 'active'
      or not exists (
        select 1 from public.team_materials as video
        where video.id = companion.companion_of
          and private.is_gone_for_good(video.lifecycle, video.missing_reason)
      )
    );

  insert into private.orphan_cleanups (material_id, team_id)
  select companion.id, companion.team_id
  from public.team_materials as companion
  join public.team_materials as video on video.id = companion.companion_of
  where companion.lifecycle = 'active'
    and companion.companion_kind in ('product_catalog', 'transcript')
    and private.is_gone_for_good(video.lifecycle, video.missing_reason)
    and coalesce(video.trashed_at, video.missing_at) < clock_timestamp() - p_grace
  on conflict (material_id) do nothing;
  get diagnostics queued = row_count;

  -- The re-stitched copies of a catalog nobody can use again: retired, so the deletion queue
  -- that already runs every tick takes them off Drive.
  update public.team_catalog_restitch_copies as copy
     set role = 'retired',
         retired_at = clock_timestamp(),
         next_delete_at = clock_timestamp()
   where copy.role in ('spare', 'in_use')
     and exists (
       select 1
       from public.team_product_catalogs as record
       join public.team_materials as sheet on sheet.id = record.material_id
       left join public.team_materials as video on video.id = record.video_material_id
       where record.material_id = copy.catalog_material_id
         and (
           private.is_gone_for_good(video.lifecycle, video.missing_reason)
           or private.is_gone_for_good(sheet.lifecycle, sheet.missing_reason)
         )
         and coalesce(video.trashed_at, video.missing_at, sheet.trashed_at, sheet.missing_at)
             < clock_timestamp() - p_grace
     );

  return queued;
end;
$$;

/** Deleted, not merely moved somewhere Soty does not watch. */
create or replace function private.is_gone_for_good(p_lifecycle text, p_reason text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_lifecycle = 'trashed' or (p_lifecycle = 'missing' and p_reason = 'removed');
$$;

revoke all on function private.is_gone_for_good(text, text) from public, anon, authenticated;
revoke all on function private.queue_orphan_cleanups(interval) from public, anon, authenticated;
