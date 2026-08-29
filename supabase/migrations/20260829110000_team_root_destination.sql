-- The space root, as a destination in its own right.
--
-- Found on the beta stack with a real Google account. The connected root folder
-- is deliberately not a material — catalog-sync says so in as many words — but
-- every file operation identified its destination or its parent by material id.
-- So the one folder the explorer opens on could not be named: uploading into
-- the space root, moving a file back to it, and renaming anything that sits
-- directly in it all failed, the last with `ROOT_ESCAPE`, which reads as a
-- security refusal rather than a gap.
--
-- `team_operations.destination_folder_id` was already nullable, so the root
-- needs no schema change: it is the destination with no material behind it.
-- These two reads are what the Edge function was missing to express that.
--
-- Forward-only. Reverse steps are in ROLLBACK.md.

/**
 * The connection behind a space, for an actor allowed to do `p_permission`.
 * Same shape as the material context minus the material: enough to reach the
 * provider and to prove where the root is.
 */
create or replace function public.service_get_root_operation_context(
  p_team uuid,
  p_actor uuid,
  p_permission text
)
returns table (
  team_id uuid,
  actor_id uuid,
  connection_id uuid,
  credential_id uuid,
  root_folder_id text,
  root_resource_key text,
  drive_id text
)
language sql
stable
security definer
set search_path = ''
as $$
  select connection.team_id,
         p_actor,
         connection.id,
         connection.credential_id,
         connection.root_folder_id,
         connection.root_resource_key,
         connection.drive_id
  from public.team_drive_connections as connection
  where connection.team_id = p_team
    and connection.state = 'connected'
    and p_permission in ('view','download','upload','edit','delete','process','manage_metadata')
    and private.can(p_team, p_permission, p_actor)
  order by connection.connected_at desc nulls last
  limit 1;
$$;

revoke all on function public.service_get_root_operation_context(uuid, uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.service_get_root_operation_context(uuid, uuid, text)
to service_role;

/**
 * Name conflicts among the children of a folder named by its provider id, so
 * the same check works for the root — which has no material row — as for any
 * indexed folder. The name key matches `service_find_team_name_conflicts`.
 */
create or replace function public.service_find_team_name_conflicts_in_folder(
  p_team uuid,
  p_drive_folder_id text,
  p_actor uuid,
  p_reserved_name_key text
)
returns table (material_id uuid, name text, drive_file_id text)
language sql
stable
security definer
set search_path = ''
as $$
  select material.id, material.name, material.drive_file_id
  from public.team_materials as material
  where material.team_id = p_team
    and material.parent_folder_id = p_drive_folder_id
    and material.lifecycle = 'active'
    and pg_catalog.lower(
      pg_catalog.regexp_replace(pg_catalog.btrim(material.name), '\s+', ' ', 'g')
    ) = p_reserved_name_key
    and private.can(p_team, 'view', p_actor)
  order by material.id;
$$;

revoke all on function public.service_find_team_name_conflicts_in_folder(uuid, text, uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.service_find_team_name_conflicts_in_folder(uuid, text, uuid, text)
to service_role;
