-- Feature 011: one folder for everything dropped on a task.
--
-- A task's attachments could only ever be files that were already in the
-- space, so anything on a person's desktop had to be uploaded somewhere first
-- and then found again — two screens and a decision ("which folder does this
-- belong in?") for a screenshot that belongs to one task and nowhere else.
--
-- Dropping straight onto the task needs somewhere for the bytes to land, and
-- the answer is one folder in the space's root: everything dropped on any task
-- goes there, in a heap, the way a drawer works. It is found by the mark this
-- application writes into the folder's `appProperties` — see
-- `supabase/functions/drive-ops/workspace-folder.ts` for the same pattern —
-- so renaming or moving it never loses it.
--
-- This is the catalogue half: an upload's destination must be a folder the
-- catalogue knows, and a folder created a second ago has not been indexed yet.

create function public.service_commit_task_drop_folder(
  p_team uuid,
  p_connection uuid,
  p_parent_folder_id text,
  p_drive_folder_id text,
  p_resource_key text,
  p_name text
)
returns table (material_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean_name text := btrim(coalesce(p_name, ''));
  committed uuid;
begin
  if char_length(clean_name) not between 1 and 200
     or char_length(coalesce(p_drive_folder_id, '')) not between 1 and 1024
     or char_length(coalesce(p_parent_folder_id, '')) not between 1 and 1024
     or not exists (
       select 1 from public.team_drive_connections as connection
       where connection.id = p_connection
         and connection.team_id = p_team
         and connection.state = 'connected'
     ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  -- The same upsert the library's folders use: the row is the folder's place
  -- in the catalogue, and a second call on the same drive id is not a second
  -- folder.
  insert into public.team_materials (
    team_id, connection_id, drive_file_id, resource_key, parent_folder_id,
    name, mime_type, kind, category, lifecycle, preview_state
  ) values (
    p_team, p_connection, p_drive_folder_id, p_resource_key, p_parent_folder_id,
    clean_name, 'application/vnd.google-apps.folder', 'folder', null, 'active', 'ready'
  )
  on conflict (team_id, drive_file_id) do update
    set parent_folder_id = excluded.parent_folder_id,
        name = excluded.name,
        resource_key = excluded.resource_key,
        lifecycle = 'active',
        trashed_at = null,
        missing_at = null
  returning id into committed;

  return query select committed;
end;
$$;

revoke all on function public.service_commit_task_drop_folder(uuid, uuid, text, text, text, text)
from public, anon, authenticated, service_role;
grant execute on function public.service_commit_task_drop_folder(uuid, uuid, text, text, text, text)
to service_role;
