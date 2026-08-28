-- 011 (T013): what the explorer reads per material — which selection it
-- descends from, whether its folder has been fully listed, and the state of
-- its thumbnail. Both derived columns are maintained by triggers so the
-- existing catalog upsert is untouched.
-- Forward-only. Reverse steps are in ROLLBACK.md.

alter table public.team_materials
  add column selection_id uuid references public.team_drive_selections(id) on delete set null,
  add column folder_indexed_at timestamptz,
  add column provider_thumbnail_state text not null default 'not_applicable',
  add column provider_thumbnail_reason text,
  add column provider_thumbnail_version text,
  add column provider_thumbnail_claimed_at timestamptz;

alter table public.team_materials
  add constraint team_materials_provider_thumbnail_state_check check (
    provider_thumbnail_state in ('pending', 'ready', 'unavailable', 'not_applicable')
  ),
  add constraint team_materials_provider_thumbnail_reason_check check (
    provider_thumbnail_reason is null
    or provider_thumbnail_reason in ('unsupported', 'corrupt', 'protected', 'too_large', 'provider_missing')
  ),
  add constraint team_materials_provider_thumbnail_ready_shape_check check (
    provider_thumbnail_state <> 'ready' or provider_thumbnail_version is not null
  ),
  add constraint team_materials_folder_indexed_check check (
    folder_indexed_at is null or kind = 'folder'
  );

-- Keyset paging: folders first, then name, then id — the order the explorer
-- shows and the cursor it hands back.
create index team_materials_folder_page_idx
  on public.team_materials (
    team_id,
    parent_folder_id,
    (case when kind = 'folder' then '0' else '1' end),
    lower(name),
    id
  )
  where lifecycle = 'active';
create index team_materials_provider_thumbnail_pending_idx
  on public.team_materials (team_id, parent_folder_id)
  where provider_thumbnail_state = 'pending';
create index team_materials_folder_rows_idx
  on public.team_materials (team_id, connection_id, drive_file_id)
  where kind = 'folder' and lifecycle = 'active';

-- ---------------------------------------------------------------------------
-- Thumbnail state follows the material
-- ---------------------------------------------------------------------------
-- Only an active image, video or landing archive has a thumbnail to prepare.
-- A new version of the provider file invalidates whatever was prepared
-- (FR-019); a version the cache already holds keeps its state.
create or replace function private.team_material_thumbnail_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind <> 'file'
     or new.lifecycle <> 'active'
     or new.category is null
     or new.category not in ('image', 'video', 'landing') then
    new.provider_thumbnail_state := 'not_applicable';
    new.provider_thumbnail_reason := null;
    new.provider_thumbnail_version := null;
    new.provider_thumbnail_claimed_at := null;
  elsif tg_op = 'INSERT' then
    new.provider_thumbnail_state := 'pending';
    new.provider_thumbnail_reason := null;
    new.provider_thumbnail_version := null;
    new.provider_thumbnail_claimed_at := null;
  elsif old.provider_thumbnail_state = 'not_applicable'
        or new.drive_version is distinct from old.drive_version
        or (new.provider_thumbnail_state = 'ready'
            and new.provider_thumbnail_version is distinct from new.drive_version) then
    new.provider_thumbnail_state := 'pending';
    new.provider_thumbnail_reason := null;
    new.provider_thumbnail_version := null;
    new.provider_thumbnail_claimed_at := null;
  end if;
  return new;
end;
$$;

create trigger team_materials_thumbnail_state
before insert or update on public.team_materials
for each row execute function private.team_material_thumbnail_state();

-- ---------------------------------------------------------------------------
-- Selection follows the ancestry
-- ---------------------------------------------------------------------------
-- Walk parents until a picked folder (or the root) is met. Under outcome A this
-- meets the root within a few hops; under B it names the picked folder so a
-- removed selection can tombstone exactly its descendants.
create or replace function private.team_material_selection_for(
  p_team uuid,
  p_connection uuid,
  p_parent_folder_id text
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  with recursive ancestry as (
    select p_parent_folder_id as folder_id, 0 as depth
    union all
    select material.parent_folder_id, ancestry.depth + 1
    from ancestry
    join public.team_materials as material
      on material.team_id = p_team
     and material.connection_id = p_connection
     and material.drive_file_id = ancestry.folder_id
     and material.kind = 'folder'
    where ancestry.depth < 64 and ancestry.folder_id is not null
  )
  select selection.id
  from ancestry
  join public.team_drive_selections as selection
    on selection.connection_id = p_connection
   and selection.drive_folder_id = ancestry.folder_id
   and selection.state <> 'removed'
  order by ancestry.depth
  limit 1;
$$;

create or replace function private.team_material_assign_selection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.selection_id is null
     or (tg_op = 'UPDATE' and new.parent_folder_id is distinct from old.parent_folder_id) then
    new.selection_id := coalesce(
      private.team_material_selection_for(new.team_id, new.connection_id, new.parent_folder_id),
      (
        select selection.id from public.team_drive_selections as selection
        where selection.connection_id = new.connection_id and selection.is_root
      )
    );
  end if;
  return new;
end;
$$;

create trigger team_materials_assign_selection
before insert or update of parent_folder_id, connection_id on public.team_materials
for each row execute function private.team_material_assign_selection();

-- Backfill existing rows: selection by ancestry, thumbnails pending where a
-- provider thumbnail can exist. The triggers fire per row.
-- `connection_id = connection_id` touches a column the trigger watches.
update public.team_materials
set connection_id = connection_id
where selection_id is null;

update public.team_materials
set provider_thumbnail_state = 'pending'
where kind = 'file'
  and lifecycle = 'active'
  and category in ('image', 'video', 'landing');

-- ---------------------------------------------------------------------------
-- Owner / manager write: remove a picked folder (never the root)
-- ---------------------------------------------------------------------------
create or replace function public.remove_team_drive_selection(p_team uuid, p_selection uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target public.team_drive_selections%rowtype;
begin
  if actor is null or not private.can(p_team, 'manage_members', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select * into target
  from public.team_drive_selections as selection
  where selection.id = p_selection and selection.team_id = p_team
  for update;
  if target.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if target.is_root then
    raise exception 'ROOT_SELECTION_REQUIRED' using errcode = 'P0001';
  end if;
  if target.state = 'removed' then
    return;
  end if;

  update public.team_drive_selections
  set state = 'removed', removed_at = clock_timestamp()
  where id = target.id;

  update public.team_materials
  set lifecycle = 'missing', missing_at = clock_timestamp()
  where team_id = p_team
    and selection_id = target.id
    and lifecycle = 'active';

  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (p_team, null, 'tombstoned');
  perform private.record_team_audit(
    p_team, actor, 'storage.selection_removed',
    jsonb_build_object('connection_id', target.connection_id, 'state', 'removed'),
    'succeeded', null
  );
end;
$$;

revoke all on function public.remove_team_drive_selection(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.remove_team_drive_selection(uuid, uuid) to authenticated;
