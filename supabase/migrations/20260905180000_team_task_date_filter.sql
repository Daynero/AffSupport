-- Feature 017, part 4b: the board filters and orders by the date it shows.
--
-- Part 4 gave a task a date of its own but left the list reading `created_at`:
-- a task moved to the 18th still answered "Today", because the row was made
-- today. A board that shows one date and filters by another is a board that
-- lies. From here the whole list — the range, the order and the cursor — runs
-- on the date the card shows: `task_date` when there is one, `created_at`
-- otherwise.
--
-- Why two ranges instead of one. `created_at` is an instant and `task_date` is
-- a calendar day, and only the caller knows the timezone that joins them. So
-- the caller sends both forms of the same range — the instants it already sent
-- (exact for the tasks that have no date of their own) and the plain days
-- (exact for the tasks that do) — and each row is judged by the one that fits
-- it. No timezone is guessed server-side. A caller that sends only the
-- instants keeps the old `created_at` behaviour, so the database tests and any
-- older client are untouched.
-- The instant a task sorts at: its own date (read as that day) when it has
-- one, the moment it was created otherwise. One expression, so the order, the
-- cursor and any later reader cannot drift apart.
create or replace function private.team_task_sort_at(p_date date, p_created_at timestamptz)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select coalesce((p_date::timestamp) at time zone 'UTC', p_created_at);
$$;

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
  p_account uuid default null,
  p_day_from date default null,
  p_day_to date default null
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
  cursor_sort timestamptz;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if (p_created_from is null) <> (p_created_to is null)
     or (p_created_from is not null and p_created_from >= p_created_to)
     or (p_day_from is null) <> (p_day_to is null)
     -- The days name the same range as the instants; one without the other is
     -- a caller that has half a filter.
     or (p_day_from is not null and (p_created_from is null or p_day_from > p_day_to))
     or p_page_size not between 1 and 100
     or (p_status is not null and p_status not in ('todo', 'in_progress', 'done')) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_cursor is not null then
    select private.team_task_sort_at(task.task_date, task.created_at) into cursor_sort
    from public.team_tasks as task
    where task.id = p_cursor and task.team_id = p_team;
    if cursor_sort is null then
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
    and (
      p_created_from is null
      or case
           -- A task with a date of its own answers for that day, wherever the
           -- row happened to be created.
           when p_day_from is not null and task.task_date is not null
             then task.task_date between p_day_from and p_day_to
           else task.created_at >= p_created_from and task.created_at < p_created_to
         end
    )
    and (p_cursor is null or (
      private.team_task_sort_at(task.task_date, task.created_at), task.id
    ) < (cursor_sort, p_cursor))
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
  order by private.team_task_sort_at(task.task_date, task.created_at) desc, task.id desc
  limit p_page_size;
end;
$$;

comment on function public.list_team_tasks(
  uuid, timestamptz, timestamptz, uuid, integer, text, uuid, uuid, date, date
) is
  'Team tasks newest-first by the date they are for (task_date, else created_at). '
  'p_day_from/p_day_to carry the same range as p_created_from/p_created_to for '
  'tasks that carry their own date.';

revoke all on function public.list_team_tasks(
  uuid, timestamptz, timestamptz, uuid, integer, text, uuid, uuid, date, date
) from public, anon, authenticated, service_role;
grant execute on function public.list_team_tasks(
  uuid, timestamptz, timestamptz, uuid, integer, text, uuid, uuid, date, date
) to authenticated;
