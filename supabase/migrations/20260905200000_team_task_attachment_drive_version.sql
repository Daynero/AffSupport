-- A task's attachments carry the Drive revision of the file behind them.
--
-- Downloading a video re-stitched reuses a preparation record — where the
-- screens are, what the keyframes look like — and that record is keyed by the
-- file's Drive revision, because a new revision is a different file. Started
-- from the explorer, the row already knew its revision; started from a task,
-- nothing did, so every download from a task paid the six-to-fourteen seconds
-- of inspection again and threw away what it learned. One more column in the
-- payload, and the two doors reach the same cache.
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
      'agents', private.team_task_agent_tags(task.id)
    ),
    'attachments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', page.id,
        'taskId', page.task_id,
        'materialId', page.material_id,
        'name', page.name,
        'category', page.category,
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
               attachment.position, material.name, material.category,
               material.lifecycle, material.drive_version, render.render_state
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
