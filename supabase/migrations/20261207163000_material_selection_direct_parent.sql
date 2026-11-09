-- The immediate parent is already the nearest possible selection. Avoid
-- planning/executing a recursive material walk for every file in a root batch.
-- In an initially empty catalog a cached sequential plan otherwise revisits
-- the growing material table once per inserted row. Preserve the exact bounded
-- ancestry lookup for descendants that do need it; no planner settings change.
create or replace function private.team_material_selection_for(
  p_team uuid, p_connection uuid, p_parent_folder_id text
) returns uuid language plpgsql stable security definer set search_path = '' as $$
declare selected uuid;
begin
  select selection.id into selected
  from public.team_drive_selections selection
  where selection.connection_id = p_connection
    and selection.drive_folder_id = p_parent_folder_id
    and selection.state <> 'removed';
  if found then return selected; end if;

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
  select selection.id into selected
  from ancestry
  join public.team_drive_selections as selection
    on selection.connection_id = p_connection
   and selection.drive_folder_id = ancestry.folder_id
   and selection.state <> 'removed'
  order by ancestry.depth
  limit 1;
  return selected;
end;
$$;
-- CREATE OR REPLACE retains existing ACLs; keep the internal helper closed.
revoke all on function private.team_material_selection_for(uuid, uuid, text)
  from public, anon, authenticated, service_role;
