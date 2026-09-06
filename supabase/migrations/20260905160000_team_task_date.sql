-- Feature 017, part 4: a task carries a date of its own.
--
-- The board reads by date, and the date that matters is the one the work is
-- for — a launch dated the day it goes live, a re-cut dated the day it is
-- due — not the moment the row happened to be created. `created_at` stays
-- exactly what it is (an untouchable record of when the task was made, and
-- the key the list pages by); the new column is the one a person can move.
--
-- Null means "the day it was created", so every existing task already has the
-- right answer and nothing needs backfilling.
alter table public.team_tasks add column task_date date;

comment on column public.team_tasks.task_date is
  'The date the task is for; null falls back to created_at. Never used for paging.';

-- ---------------------------------------------------------------------------
-- 1. The patch gains one key
-- ---------------------------------------------------------------------------
create or replace function public.update_team_task(p_team uuid, p_task uuid, p_patch jsonb)
returns public.team_tasks
language plpgsql
security definer
set search_path = ''
as $$
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
  next_date date;
  explicit_value boolean;
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb
     or exists (
       select 1 from jsonb_object_keys(p_patch) as key
       where key not in (
         'title','note','assigneeId','status','progressMax','progressValue',
         'dateOn','expectedUpdatedAt'
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

  -- The date the task is for. `null` puts it back to the day it was created.
  next_date := current_task.task_date;
  if p_patch ? 'dateOn' then
    if jsonb_typeof(p_patch -> 'dateOn') = 'null' then
      next_date := null;
    elsif jsonb_typeof(p_patch -> 'dateOn') = 'string'
          and (p_patch ->> 'dateOn') ~ '^\d{4}-\d{2}-\d{2}$' then
      next_date := (p_patch ->> 'dateOn')::date;
      -- A date outside this range is a typo, not a plan.
      if next_date < date '2000-01-01' or next_date > date '2100-01-01' then
        raise exception 'INVALID_INPUT' using errcode = '22023';
      end if;
    else
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
         task_date = next_date,
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
$$;

-- ---------------------------------------------------------------------------
-- 2. The reads carry it
-- ---------------------------------------------------------------------------
drop function if exists public.list_team_tasks(
  uuid, timestamptz, timestamptz, uuid, integer, text, uuid, uuid
);

create function public.list_team_tasks(
  p_team uuid,
  p_created_from timestamptz default null,
  p_created_to timestamptz default null,
  p_cursor uuid default null,
  p_page_size integer default 50,
  p_status text default null,
  p_agent uuid default null,
  p_account uuid default null
)
returns table (
  id uuid,
  team_id uuid,
  created_by uuid,
  title text,
  note text,
  assignee_id uuid,
  assignee_label_snapshot text,
  status text,
  progress_max integer,
  progress_value integer,
  progress_manually_set boolean,
  attachment_count bigint,
  agents jsonb,
  task_date date,
  created_at timestamptz,
  updated_at timestamptz,
  completed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cursor_created_at timestamptz;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if (p_created_from is null) <> (p_created_to is null)
     or (p_created_from is not null and p_created_from >= p_created_to)
     or p_page_size not between 1 and 100
     or (p_status is not null and p_status not in ('todo', 'in_progress', 'done')) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_cursor is not null then
    select task.created_at into cursor_created_at
    from public.team_tasks as task
    where task.id = p_cursor and task.team_id = p_team;
    if cursor_created_at is null then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
  end if;
  return query
  select task.id, task.team_id, task.created_by, task.title, task.note,
         task.assignee_id, task.assignee_label_snapshot, task.status,
         task.progress_max, task.progress_value, task.progress_manually_set,
         count(attachment.id) as attachment_count,
         private.team_task_agent_tags(task.id) as agents,
         task.task_date,
         task.created_at, task.updated_at, task.completed_at
  from public.team_tasks as task
  left join public.team_task_attachments as attachment on attachment.task_id = task.id
  where task.team_id = p_team
    and (p_status is null or task.status = p_status)
    and (p_created_from is null or (task.created_at >= p_created_from and task.created_at < p_created_to))
    and (p_cursor is null or (task.created_at, task.id) < (cursor_created_at, p_cursor))
    and (p_agent is null or exists (
      select 1 from public.team_task_agents as link
      where link.task_id = task.id and link.agent_row_id = p_agent
    ))
    and (p_account is null or exists (
      select 1 from public.team_task_agents as link
      join public.team_account_agents as agent on agent.id = link.agent_row_id
      where link.task_id = task.id and agent.account_id = p_account
    ))
  group by task.id
  order by task.created_at desc, task.id desc
  limit p_page_size;
end;
$$;

-- `get_team_task` already returns `to_jsonb(task)`, so the column travels with
-- it; only its grants and the published columns have to learn about it.
grant select (task_date) on table public.team_tasks to authenticated;

alter publication supabase_realtime drop table public.team_tasks;
alter publication supabase_realtime add table public.team_tasks (
  id, team_id, title, assignee_id, status, progress_max, progress_value,
  progress_manually_set, task_date, created_at, updated_at, completed_at
);

revoke all on function public.list_team_tasks(
  uuid, timestamptz, timestamptz, uuid, integer, text, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.list_team_tasks(
  uuid, timestamptz, timestamptz, uuid, integer, text, uuid, uuid
) to authenticated;
