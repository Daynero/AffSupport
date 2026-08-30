-- The task progress bar is a manual marker only: moving a task to Done no longer
-- snaps it to the maximum. It changes solely when someone drags it (an explicit
-- progressValue patch). Paired with the client no longer re-syncing the marker
-- on a status change.
CREATE OR REPLACE FUNCTION public.update_team_task(p_team uuid, p_task uuid, p_patch jsonb)
 RETURNS team_tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := auth.uid();
  current_task public.team_tasks%rowtype;
  updated_task public.team_tasks%rowtype;
  next_title text;
  next_note text;
  next_assignee uuid;
  next_status text;
  next_max integer;
  next_value integer;
  next_manual boolean;
  explicit_value boolean;
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb
     or exists (
       select 1 from jsonb_object_keys(p_patch) as key
       where key not in (
         'title','note','assigneeId','status','progressMax','progressValue','expectedUpdatedAt'
       )
     ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  select * into current_task
  from public.team_tasks as task
  where task.id = p_task and task.team_id = p_team
  for update;
  if current_task.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p_patch ? 'expectedUpdatedAt'
     and (p_patch ->> 'expectedUpdatedAt')::timestamptz is distinct from current_task.updated_at then
    raise exception 'SOURCE_CHANGED' using errcode = '40001';
  end if;

  next_title := current_task.title;
  if p_patch ? 'title' then
    if jsonb_typeof(p_patch -> 'title') <> 'string'
       or char_length(btrim(p_patch ->> 'title')) not between 1 and 160 then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    next_title := btrim(p_patch ->> 'title');
  end if;

  next_note := current_task.note;
  if p_patch ? 'note' then
    if jsonb_typeof(p_patch -> 'note') = 'null' then
      next_note := null;
    elsif jsonb_typeof(p_patch -> 'note') = 'string'
          and char_length(p_patch ->> 'note') <= 2000 then
      next_note := nullif(btrim(p_patch ->> 'note'), '');
    else
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
  end if;

  next_assignee := current_task.assignee_id;
  if p_patch ? 'assigneeId' then
    if jsonb_typeof(p_patch -> 'assigneeId') = 'null' then
      next_assignee := null;
    elsif jsonb_typeof(p_patch -> 'assigneeId') = 'string'
          and (p_patch ->> 'assigneeId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      next_assignee := (p_patch ->> 'assigneeId')::uuid;
    else
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
  end if;
  if next_assignee is not null and not private.team_task_assignee_is_active(p_team, next_assignee) then
    raise exception 'INVALID_ASSIGNEE' using errcode = '22023';
  end if;

  next_status := current_task.status;
  if p_patch ? 'status' then
    next_status := p_patch ->> 'status';
    if jsonb_typeof(p_patch -> 'status') <> 'string'
       or next_status not in ('todo','in_progress','done') then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
  end if;

  next_max := current_task.progress_max;
  if p_patch ? 'progressMax' then
    if jsonb_typeof(p_patch -> 'progressMax') <> 'number'
       or (p_patch ->> 'progressMax') !~ '^[0-9]+$' then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    next_max := (p_patch ->> 'progressMax')::integer;
  end if;

  explicit_value := p_patch ? 'progressValue';
  next_value := current_task.progress_value;
  next_manual := current_task.progress_manually_set;
  if explicit_value then
    if jsonb_typeof(p_patch -> 'progressValue') <> 'number'
       or (p_patch ->> 'progressValue') !~ '^[0-9]+$' then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    next_value := (p_patch ->> 'progressValue')::integer;
    next_manual := true;
  end if;
  if next_max not between 1 and 10000 or next_value not between 0 and next_max then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  update public.team_tasks as task
     set title = next_title,
         note = next_note,
         assignee_id = next_assignee,
         assignee_label_snapshot = case
           when next_assignee is null then task.assignee_label_snapshot
           else private.team_task_assignee_label(next_assignee) end,
         status = next_status,
         progress_max = next_max,
         progress_value = next_value,
         progress_manually_set = next_manual,
         completed_at = case
           when next_status = 'done' then coalesce(task.completed_at, clock_timestamp())
           else null end
   where task.id = p_task and task.team_id = p_team
   returning * into updated_task;

  if current_task.status <> 'done' and updated_task.status = 'done' then
    perform private.append_library_contribution(
      p_team, actor, 'human_activity', 'task_completed', 'success', null
    );
  end if;
  return updated_task;
exception
  when invalid_text_representation or datetime_field_overflow then
    raise exception 'INVALID_INPUT' using errcode = '22023';
end;
$function$;
