-- Feature 024 — a task's attachments say which folder their files are in.
--
-- Three files called Gs2_2.mp4 in three folders were one name three times on a task, and a
-- launch could go out with the wrong one. `list_task_attachment_folders` returns each attached
-- file's parent folder (a Drive id), which the web turns into a path. It is a function of its
-- own rather than a new key on `get_team_task`, whose attachment rows a web build already in
-- users' hands checks key by key: a migration deployed before the web would have emptied every
-- task of its attachments until the web caught up.
--
-- `get_team_task` is re-applied to bring back `kind`, which 20260906190000 added and
-- 20260906200000's rewrite dropped, so a folder attachment read "File" again.
-- ROLLBACK.md: drop the new function; re-apply `get_team_task` from 20260906200000.

create or replace function public.get_team_task(
  p_team uuid,
  p_task uuid,
  p_attachment_cursor bigint default null,
  p_attachment_page_size integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  payload jsonb;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_attachment_page_size not between 1 and 100 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select jsonb_build_object(
    'task', to_jsonb(task) || jsonb_build_object(
      'attachment_count', (
        select count(*) from public.team_task_attachments as total
        where total.task_id = task.id
      ),
      'agents', private.team_task_agent_tags(task.id),
      'labels', private.team_task_labels(task.id)
    ),
    'attachments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', page.id,
        'taskId', page.task_id,
        'materialId', page.material_id,
        'name', page.name,
        'category', page.category,
        'kind', page.kind,
        'availability', case
          when page.lifecycle = 'active' then 'ready'
          when page.lifecycle = 'trashed' then 'trashed'
          when page.lifecycle = 'missing' then 'missing'
          else 'unavailable' end,
        'previewState', case
          when page.lifecycle <> 'active' then 'unavailable'
          when page.category = 'landing' and page.render_state = 'ready' then 'ready'
          when page.category in ('image','video') then 'ready'
          else 'unavailable' end,
        'position', page.position,
        'driveVersion', page.drive_version
      ) order by page.position, page.id)
      from (
        select attachment.id, attachment.task_id, attachment.material_id,
               attachment.position, material.name, material.category, material.kind,
               material.lifecycle, render.render_state, material.drive_version
        from public.team_task_attachments as attachment
        join public.team_materials as material
          on material.id = attachment.material_id and material.team_id = attachment.team_id
        left join public.team_landing_renders as render
          on render.team_id = material.team_id and render.material_id = material.id
         and render.preset = 'default' and render.render_state = 'ready'
        where attachment.task_id = task.id
          and (p_attachment_cursor is null or attachment.position > p_attachment_cursor)
        order by attachment.position, attachment.id
        limit p_attachment_page_size
      ) as page
    ), '[]'::jsonb)
  ) into payload
  from public.team_tasks as task
  where task.id = p_task and task.team_id = p_team;
  if payload is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  return payload;
end;
$$;


create or replace function public.list_task_attachment_folders(p_team uuid, p_task uuid)
returns table (material_id uuid, parent_folder_id text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
  select attachment.material_id, material.parent_folder_id
  from public.team_task_attachments as attachment
  join public.team_materials as material
    on material.id = attachment.material_id and material.team_id = attachment.team_id
  join public.team_tasks as task on task.id = attachment.task_id and task.team_id = p_team
  where attachment.task_id = p_task;
end;
$$;

revoke all on function public.list_task_attachment_folders(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_task_attachment_folders(uuid, uuid) to authenticated;
