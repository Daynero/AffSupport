-- Re-stitched copies nobody uses any more leave Drive, whatever path made them.
--
-- The updater already retires the copy a round replaces, and its worker deletes retired copies.
-- Two kinds of copy never reached that queue, and the `Restitched` folder grew by a 20–30 MB
-- video at a time — five copies of one creative in the space where it was found:
--
--   * a catalog re-created over an old one: the old sheet goes to the bin, but its in-use copy
--     (without re-stitch) and its spare (either way) stayed behind. The day-long orphan sweep
--     would have retired them, but it only runs inside a worker tick, and the worker only wakes
--     for an updater round or a copy already retired — a space without an updater never got one;
--   * a copy the catalog dialog made that never became a catalog's: the create failed, was
--     retried with other options, or the dialog was closed. Nothing recorded it at all.
--
-- The folder is the application's own (024, US26): every file in it is machinery. So a copy in
-- it that no catalog, task or later file refers to, an hour after it was made, is retired here,
-- and the existing queue deletes it. The hour is the dialog's window: a create links its copy
-- within minutes of the upload.

-- The folder, as the edge function found it by its appProperties mark. A row per folder ever
-- resolved: a space whose folder was deleted and re-created keeps sweeping the old one's files.
create table private.team_restitched_folders (
  team_id uuid not null references public.teams(id) on delete cascade,
  drive_folder_id text not null,
  noted_at timestamptz not null default now(),
  primary key (team_id, drive_folder_id)
);

revoke all on private.team_restitched_folders from public, anon, authenticated;

-- Folders already in use: the parent of a copy the updater or a catalog tracks, named the way
-- the application names it. Both, because the updater falls back to the folder beside the video
-- when the cache folder cannot be resolved, and that folder is a person's own.
insert into private.team_restitched_folders (team_id, drive_folder_id)
select distinct copy_file.team_id, copy_file.parent_folder_id
from public.team_catalog_restitch_copies as copy
join public.team_materials as copy_file on copy_file.id = copy.material_id
join public.team_materials as folder
  on folder.team_id = copy_file.team_id
 and folder.drive_file_id = copy_file.parent_folder_id
 and folder.kind = 'folder'
 and folder.name = 'Restitched'
where copy_file.parent_folder_id is not null
on conflict do nothing;

create function public.service_note_restitched_folder(p_team uuid, p_drive_folder_id text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.team_restitched_folders (team_id, drive_folder_id)
  values (p_team, p_drive_folder_id)
  on conflict (team_id, drive_folder_id) do update set noted_at = excluded.noted_at;
$$;

revoke all on function public.service_note_restitched_folder(uuid, text)
  from public, anon, authenticated;
grant execute on function public.service_note_restitched_folder(uuid, text) to service_role;

-- A copy found in the folder belongs to no catalog: the queue needs the file, not its owner.
alter table public.team_catalog_restitch_copies alter column catalog_material_id drop not null;

create function private.retire_unused_restitch_copies(
  p_grace interval default interval '1 hour',
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
  select file.id, null, file.team_id, 'retired', file.drive_file_id,
         clock_timestamp(), clock_timestamp()
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
    -- What a sheet links to: the in-use copy has a row, but a link is the thing that must not
    -- break, so it is checked as well.
    and not exists (
      select 1 from public.team_product_catalogs as record
      where record.team_id = file.team_id
        and (
          record.video_material_id = file.id
          or strpos(coalesce(record.current_video_link, ''), file.drive_file_id) > 0
          or strpos(coalesce(record.video_link, ''), file.drive_file_id) > 0
        )
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
  order by file.created_at
  limit greatest(p_limit, 1)
  on conflict (material_id) do nothing;
  get diagnostics found = row_count;
  return retired + found;
end;
$$;

revoke all on function private.retire_unused_restitch_copies(interval, integer)
  from public, anon, authenticated;

-- The sweep runs where the worker is woken: a copy it retires is itself a reason to wake it, so
-- a space without an updater gets its folder cleaned too.
create or replace function private.invoke_catalog_updater_worker()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  endpoint text;
  worker_secret text;
  request_id bigint;
begin
  begin
    perform private.retire_unused_restitch_copies();
  exception when others then
    -- Housekeeping never stops a round from being dispatched.
    null;
  end;

  if not exists (
    select 1 from public.team_catalog_updater_items as item
    where item.update_interval is not null
      and item.next_run_at <= clock_timestamp()
      and item.round_due_at is null
  ) and not exists (
    select 1 from public.team_catalog_updater_items as item
    where item.round_due_at is not null
      and item.next_attempt_at <= clock_timestamp()
      and (item.lease_expires_at is null or item.lease_expires_at <= clock_timestamp())
  ) and not exists (
    select 1 from public.team_catalog_restitch_copies as copy
    where copy.role = 'retired' and copy.next_delete_at <= clock_timestamp()
  ) then return null; end if;
  if (select count(*) from public.team_catalog_updater_items
      where lease_expires_at > clock_timestamp()) >= 12
  then return null; end if;

  select private.catalog_updater_endpoint(secret.decrypted_secret) into endpoint
  from vault.decrypted_secrets as secret where secret.name = 'wishly_catalog_sync_url'
  order by secret.created_at desc limit 1;
  select secret.decrypted_secret into worker_secret
  from vault.decrypted_secrets as secret where secret.name = 'wishly_catalog_sync_secret'
  order by secret.created_at desc limit 1;
  if endpoint is null or worker_secret is null or char_length(worker_secret) < 32 then
    return null;
  end if;

  select net.http_post(
    url := endpoint,
    headers := pg_catalog.jsonb_build_object('content-type', 'application/json',
      'x-catalog-sync-secret', worker_secret),
    body := '{"scheduled":true}'::jsonb, timeout_milliseconds := 60000
  ) into request_id;
  return request_id;
end;
$$;
