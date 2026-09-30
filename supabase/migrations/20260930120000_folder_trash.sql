-- A folder is one Drive object, but its indexed descendants must leave and
-- return with it. Remember which active descendants this particular trash hid;
-- items already in the bin must stay there after the folder is restored.
alter table public.team_materials
  add column if not exists folder_trash_root uuid references public.team_materials(id);

create or replace function private.cascade_team_folder_trash()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_trigger_depth() > 1 or new.kind <> 'folder'
     or new.lifecycle = old.lifecycle then
    return new;
  end if;

  if new.lifecycle = 'trashed' then
    with recursive descendants as (
      select child.id, child.drive_file_id
      from public.team_materials as child
      where child.team_id = new.team_id
        and child.parent_folder_id = new.drive_file_id
      union all
      select child.id, child.drive_file_id
      from public.team_materials as child
      join descendants as parent on child.parent_folder_id = parent.drive_file_id
      where child.team_id = new.team_id
    ), changed as (
      update public.team_materials as material
         set lifecycle = 'trashed', trashed_at = new.trashed_at,
             folder_trash_root = new.id, placement_state = 'ready'
       where material.team_id = new.team_id
         and material.id in (select id from descendants)
         and material.lifecycle = 'active'
      returning material.id
    )
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    select new.team_id, id, 'tombstoned' from changed;
  elsif new.lifecycle = 'active' then
    with changed as (
      update public.team_materials as material
         set lifecycle = 'active', trashed_at = null,
             folder_trash_root = null, missing_at = null,
             placement_state = 'ready'
       where material.team_id = new.team_id
         and material.folder_trash_root = new.id
      returning material.id
    )
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    select new.team_id, id, 'upserted' from changed;
  end if;
  return new;
end;
$$;

revoke all on function private.cascade_team_folder_trash()
from public, anon, authenticated, service_role;

create trigger cascade_team_folder_trash
after update of lifecycle on public.team_materials
for each row execute function private.cascade_team_folder_trash();

-- Folder lifecycle uses the same checked Drive saga as files, with one source
-- member. The root remains protected by the live mutation guard in drive-ops.
create or replace function public.service_create_folder_lifecycle_intent(
  p_team uuid, p_actor uuid, p_operation uuid, p_material uuid,
  p_action text, p_destination_parent_id text default null
)
returns table (
  intent_id uuid, team_id uuid, operation_id uuid, source_material_id uuid,
  action text, members jsonb, applied_member_ids uuid[]
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  source public.team_materials%rowtype;
  existing private.team_material_group_intents%rowtype;
  created_id uuid;
begin
  if p_action not in ('trash', 'restore') or not private.can(p_team, 'delete', p_actor)
     or not exists (
       select 1 from public.team_operations as operation
       where operation.id = p_operation and operation.team_id = p_team
         and operation.actor_id = p_actor and operation.kind = p_action
         and operation.source_material_id = p_material
         and operation.state in ('pending', 'running')
     ) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  select * into existing from private.team_material_group_intents as intent
  where intent.operation_id = p_operation for update;
  if existing.id is not null then
    return query select existing.id, existing.team_id, existing.operation_id,
      existing.source_material_id, existing.action, existing.member_snapshot,
      existing.applied_member_ids;
    return;
  end if;

  select * into source from public.team_materials as material
  where material.id = p_material and material.team_id = p_team for update;
  if source.id is null or source.kind <> 'folder'
     or (p_action = 'restore' and source.lifecycle <> 'trashed')
     or (p_action = 'trash' and source.lifecycle <> 'active')
     or source.folder_trash_root is not null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into private.team_material_group_intents (
    team_id, source_material_id, operation_id, action, destination_parent_id,
    member_snapshot, state
  ) values (
    p_team, p_material, p_operation, p_action, p_destination_parent_id,
    jsonb_build_array(jsonb_build_object(
      'material_id', source.id,
      'drive_file_id', source.drive_file_id,
      'resource_key', source.resource_key,
      'parent_folder_id', source.parent_folder_id,
      'role', 'source'
    )), 'running'
  ) returning id into created_id;
  update public.team_materials as material set placement_state = 'moving'
  where material.id = p_material and material.team_id = p_team;
  return query select intent.id, intent.team_id, intent.operation_id,
    intent.source_material_id, intent.action, intent.member_snapshot,
    intent.applied_member_ids
  from private.team_material_group_intents as intent where intent.id = created_id;
end;
$$;

revoke all on function public.service_create_folder_lifecycle_intent(
  uuid, uuid, uuid, uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.service_create_folder_lifecycle_intent(
  uuid, uuid, uuid, uuid, text, text
) to service_role;

-- Only show the top folder in the bin; its children travel and restore with it.
create or replace function public.list_team_trashed_materials(
  p_team uuid, p_limit int default 50, p_before timestamptz default null
)
returns table (id uuid, name text, kind text, trashed_at timestamptz, parent_path_hint text)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return query
  select material.id, material.name, material.kind, material.trashed_at, parent.name
  from public.team_materials as material
  left join public.team_materials as parent
    on parent.team_id = material.team_id
   and parent.drive_file_id = material.parent_folder_id
   and parent.kind = 'folder'
  where material.team_id = p_team and material.lifecycle = 'trashed'
    and material.trashed_at is not null and material.folder_trash_root is null
    and (p_before is null or material.trashed_at < p_before)
  order by material.trashed_at desc, material.id desc
  limit p_limit;
end;
$$;
