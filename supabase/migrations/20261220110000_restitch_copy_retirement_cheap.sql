-- Backend audit 2026-11-20: private.invoke_catalog_updater_worker was the heaviest statement
-- on the shared database — every minute, 1.04 s on average, a fifth of all database time.
--
-- A quarter of each run is private.retire_unused_restitch_copies looking for a video in a
-- «restitched» folder that nothing refers to. Measured on production: 1 440 candidate videos,
-- 189 749 buffer hits and 211 ms (plus 39 ms of planning) to retire nothing, because the plan
-- tested the expensive condition first. For every candidate it read all of the team's
-- catalogs — up to 376 wide rows — to run strpos over two link columns (130 ms), and only then
-- asked whether the file is a catalog video variant, which is what 1 266 of them are; that
-- probe walked the whole (video_set_id, output_material_id) index each time (59 ms), since no
-- index leads with output_material_id. The set of variants only grows.
--
-- The same answer, cheapest question first:
--
--  * the index-backed tests (a copy row, a variant output, a task attachment, a companion, a
--    running operation) run in a materialized step, so the planner cannot put the link scan
--    in front of them again;
--  * the link scan over the team's catalogs runs only for what survives — files that are
--    orphans by every other measure, normally none;
--  * catalog_video_variants gets an index on output_material_id for the variant probe.
--
-- The retired rows, their order and the limit are unchanged.
begin;

-- A statement that needs a lock on a table written many times a second must not wait for it
-- indefinitely: every writer queues behind a waiting DDL. Five seconds, then the whole file
-- fails cleanly and is applied again (as 20261218200000 does).
set local lock_timeout = '5s';

create index if not exists catalog_video_variants_output_material_idx
  on private.catalog_video_variants (output_material_id)
  where output_material_id is not null;

create or replace function private.retire_unused_restitch_copies(
  p_grace interval default '01:00:00'::interval,
  p_limit integer default 25
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  retired integer := 0;
  found integer;
begin
  -- A replaced catalog: its sheet is in the bin and no longer a companion of the video, so it
  -- cannot come back as a catalog. Its copies go now, not in a day.
  update public.team_catalog_restitch_copies as copy
     set role = 'retired',
         retired_at = clock_timestamp(),
         next_delete_at = clock_timestamp() + interval '2 minutes'
   where copy.role in ('spare', 'in_use')
     and exists (
       select 1 from public.team_materials as sheet
       where sheet.id = copy.catalog_material_id
         and sheet.lifecycle <> 'active'
         and sheet.companion_of is null
     );
  get diagnostics found = row_count;
  retired := retired + found;

  -- A copy in the folder that nothing refers to.
  insert into public.team_catalog_restitch_copies (
    material_id, catalog_material_id, team_id, role, drive_file_id,
    retired_at, next_delete_at
  )
  with unclaimed as materialized (
    select file.id, file.team_id, file.drive_file_id, file.created_at
    from private.team_restitched_folders as folder
    join public.team_materials as file
      on file.team_id = folder.team_id
     and file.parent_folder_id = folder.drive_folder_id
    where file.lifecycle = 'active'
      and file.kind = 'file'
      and file.category = 'video'
      and file.created_at < clock_timestamp() - p_grace
      and not exists (
        select 1 from public.team_catalog_restitch_copies as copy where copy.material_id = file.id
      )
      -- A catalog video variant is owned by its set and its catalog, linked or not yet.
      and not exists (
        select 1 from private.catalog_video_variants as variant
        where variant.team_id = file.team_id and variant.output_material_id = file.id
      )
      and not exists (
        select 1 from public.team_task_attachments as attachment where attachment.material_id = file.id
      )
      and not exists (
        select 1 from public.team_materials as companion where companion.companion_of = file.id
      )
      and not exists (
        select 1 from public.team_operations as operation
        where operation.source_material_id = file.id
          and operation.state in ('pending', 'running')
      )
  )
  select file.id, null, file.team_id, 'retired', file.drive_file_id,
         clock_timestamp(), clock_timestamp()
  from unclaimed as file
  -- What a sheet links to: the in-use copy has a row, but a link is the thing that must not
  -- break, so it is checked as well. No index can answer a substring test, which is why it is
  -- asked last and only of the few files nothing else claims.
  where not exists (
    select 1 from public.team_product_catalogs as record
    where record.team_id = file.team_id
      and (
        record.video_material_id = file.id
        or strpos(coalesce(record.current_video_link, ''), file.drive_file_id) > 0
        or strpos(coalesce(record.video_link, ''), file.drive_file_id) > 0
      )
  )
  order by file.created_at
  limit greatest(p_limit, 1)
  on conflict (material_id) do nothing;
  get diagnostics found = row_count;
  return retired + found;
end;
$$;

revoke all on function private.retire_unused_restitch_copies(interval, integer)
  from public, anon, authenticated, service_role;

commit;
