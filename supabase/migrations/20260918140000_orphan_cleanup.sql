-- Feature 024 US24 — a catalog or a transcript whose video is gone is rubbish, and rubbish goes.
--
-- Deleting a video in Drive, outside Soty, left its sheet, its text and its re-stitched copies
-- behind: the updater quietly dropped the catalog and nothing ever removed the files. They are of
-- no use to anyone — a catalog sells a video that no longer exists — so the space clears them.
--
-- A day's grace first: a video trashed by mistake and restored within the day keeps everything.
-- After that the sheet and the transcript go to Drive's own bin (recoverable, as any deletion in
-- Drive is), the re-stitched copies join the deletion queue that already exists, and the history
-- says what happened, signed by Soty.
-- Forward-only; ROLLBACK.md drops the table and the three functions.

create table if not exists private.orphan_cleanups (
  material_id uuid primary key references public.team_materials(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  queued_at timestamptz not null default clock_timestamp(),
  attempts integer not null default 0,
  lease_owner text,
  lease_expires_at timestamptz
);

create index if not exists orphan_cleanups_free_idx
  on private.orphan_cleanups (queued_at)
  where lease_owner is null;

/*
 * What is left of a video that is gone: its catalog sheets and its transcript, still active, a
 * day or more after the video was trashed or went missing. Queued here; the copies of a dead
 * catalog are retired instead, because the updater already knows how to delete those.
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
  -- A video that came back takes its companions off the list.
  delete from private.orphan_cleanups as item
  using public.team_materials as companion
  where companion.id = item.material_id
    and (
      companion.lifecycle <> 'active'
      or not exists (
        select 1 from public.team_materials as video
        where video.id = companion.companion_of and video.lifecycle <> 'active'
      )
    );

  insert into private.orphan_cleanups (material_id, team_id)
  select companion.id, companion.team_id
  from public.team_materials as companion
  join public.team_materials as video on video.id = companion.companion_of
  where companion.lifecycle = 'active'
    and companion.companion_kind in ('product_catalog', 'transcript')
    and video.lifecycle <> 'active'
    and coalesce(video.trashed_at, video.missing_at) < clock_timestamp() - p_grace
  on conflict (material_id) do nothing;
  get diagnostics queued = row_count;

  -- The re-stitched copies of a catalog whose video is gone: retired, so the deletion queue
  -- that already runs every tick takes them off Drive.
  update public.team_catalog_restitch_copies as copy
     set role = 'retired',
         retired_at = clock_timestamp(),
         next_delete_at = clock_timestamp()
   where copy.role in ('spare', 'in_use')
     and exists (
       select 1
       from public.team_product_catalogs as record
       join public.team_materials as video on video.id = record.video_material_id
       where record.material_id = copy.catalog_material_id
         and video.lifecycle <> 'active'
         and coalesce(video.trashed_at, video.missing_at) < clock_timestamp() - p_grace
     );

  return queued;
end;
$$;

/** The next files to clear, leased like every other queue here. */
create or replace function public.service_claim_orphan_cleanups(
  p_worker text, p_limit integer default 10, p_lease_seconds integer default 60
)
returns table (
  material_id uuid,
  team_id uuid,
  drive_file_id text,
  resource_key text,
  credential_id uuid,
  companion_kind text,
  name text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.queue_orphan_cleanups();
  return query
  with due as (
    select item.material_id
    from private.orphan_cleanups as item
    where (item.lease_owner is null or item.lease_expires_at < clock_timestamp())
      and item.attempts < 5
    order by item.queued_at
    for update of item skip locked
    limit least(greatest(p_limit, 1), 50)
  ), leased as (
    update private.orphan_cleanups as item
       set lease_owner = p_worker,
           lease_expires_at = clock_timestamp()
             + make_interval(secs => least(greatest(p_lease_seconds, 10), 600)),
           attempts = item.attempts + 1
      from due
     where item.material_id = due.material_id
    returning item.material_id, item.team_id
  )
  select leased.material_id,
         leased.team_id,
         file.drive_file_id,
         file.resource_key,
         connection.credential_id,
         file.companion_kind,
         file.name
  from leased
  join public.team_materials as file on file.id = leased.material_id
  join public.team_drive_connections as connection on connection.id = file.connection_id;
end;
$$;

/** Cleared: the row reads as trashed, the queue forgets it, and the history says so. */
create or replace function public.service_complete_orphan_cleanup(
  p_material uuid, p_worker text, p_trashed boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  cleared public.team_materials;
begin
  if not p_trashed then
    update private.orphan_cleanups as item
       set lease_owner = null, lease_expires_at = null
     where item.material_id = p_material and item.lease_owner = p_worker;
    return false;
  end if;
  delete from private.orphan_cleanups as item where item.material_id = p_material;
  update public.team_materials as file
     set lifecycle = 'trashed', trashed_at = clock_timestamp(), updated_at = clock_timestamp()
   where file.id = p_material and file.lifecycle = 'active'
  returning * into cleared;
  if cleared.id is null then return false; end if;
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (cleared.team_id, p_material, 'tombstoned');
  perform private.record_team_system_audit(
    cleared.team_id,
    case when cleared.companion_kind = 'product_catalog'
      then 'catalog.orphan_removed' else 'material.orphan_removed' end,
    jsonb_build_object('material_id', p_material)
  );
  return true;
end;
$$;

revoke all on function private.queue_orphan_cleanups(interval) from public, anon, authenticated;
revoke all on function public.service_claim_orphan_cleanups(text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.service_complete_orphan_cleanup(uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.service_claim_orphan_cleanups(text, integer, integer)
  to service_role;
grant execute on function public.service_complete_orphan_cleanup(uuid, text, boolean)
  to service_role;
