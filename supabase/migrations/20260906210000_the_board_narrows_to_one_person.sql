-- Feature 018, part 2: the board narrows to one person.
--
-- A task already carries an assignee; the list could not be asked for one. On
-- a board of fifty cards "what is on me today" was a thing a person did by
-- eye, and paging made even that unreliable — the fifty rows on screen are not
-- the fifty the question was about.
--
-- Two arguments rather than one magic value: `p_assignee` names a person, and
-- `p_unassigned` asks for the tasks nobody is on. A uuid cannot express "no
-- one", and a sentinel uuid would be a rule every future caller has to know.
-- Asking for both at once is a caller that has not decided, and is refused.

drop function if exists public.list_team_tasks(
  uuid, timestamptz, timestamptz, uuid, integer, text, uuid, uuid, date, date, uuid[], text
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
  p_day_to date default null,
  p_labels uuid[] default null,
  p_sort text default 'date',
  p_assignee uuid default null,
  p_unassigned boolean default false
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
  labels jsonb,
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
  sort text := coalesce(nullif(btrim(coalesce(p_sort, '')), ''), 'date');
  unassigned boolean := coalesce(p_unassigned, false);
  cursor_sort timestamptz;
  cursor_key text;
  cursor_untagged boolean;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if (p_created_from is null) <> (p_created_to is null)
     or (p_created_from is not null and p_created_from >= p_created_to)
     or (p_day_from is null) <> (p_day_to is null)
     or (p_day_from is not null and (p_created_from is null or p_day_from > p_day_to))
     or p_page_size not between 1 and 100
     or (p_status is not null and p_status not in ('todo', 'in_progress', 'done'))
     or sort not in ('date', 'label')
     or (p_labels is not null and coalesce(array_length(p_labels, 1), 0) not between 1 and 20)
     -- One person, or nobody: asking for both is asking for nothing.
     or (p_assignee is not null and unassigned) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_cursor is not null then
    select private.team_task_sort_at(task.task_date, task.created_at),
           private.team_task_label_key(task.id)
      into cursor_sort, cursor_key
    from public.team_tasks as task
    where task.id = p_cursor and task.team_id = p_team;
    if cursor_sort is null then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    cursor_untagged := cursor_key is null;
    cursor_key := coalesce(cursor_key, '');
  end if;
  return query
  select task.id, task.team_id, task.created_by, task.title, task.note,
         task.assignee_id, task.assignee_label_snapshot, task.status,
         task.progress_max, task.progress_value, task.progress_manually_set,
         count(attachment.id) as attachment_count,
         private.team_task_agent_tags(task.id) as agents,
         private.team_task_labels(task.id) as labels,
         task.task_date,
         task.created_at, task.updated_at, task.completed_at
  from public.team_tasks as task
  left join public.team_task_attachments as attachment on attachment.task_id = task.id
  where task.team_id = p_team
    and (p_status is null or task.status = p_status)
    and (p_assignee is null or task.assignee_id = p_assignee)
    and (not unassigned or task.assignee_id is null)
    and (
      p_created_from is null
      or case
           when p_day_from is not null and task.task_date is not null
             then task.task_date between p_day_from and p_day_to
           else task.created_at >= p_created_from and task.created_at < p_created_to
         end
    )
    and (p_cursor is null or case
      when sort = 'label' then
        (private.team_task_label_key(task.id) is null,
         coalesce(private.team_task_label_key(task.id), ''))
          > (cursor_untagged, cursor_key)
        or (
          (private.team_task_label_key(task.id) is null) = cursor_untagged
          and coalesce(private.team_task_label_key(task.id), '') = cursor_key
          and (private.team_task_sort_at(task.task_date, task.created_at), task.id)
              < (cursor_sort, p_cursor)
        )
      else
        (private.team_task_sort_at(task.task_date, task.created_at), task.id)
          < (cursor_sort, p_cursor)
    end)
    and (p_labels is null or exists (
      select 1 from public.team_task_label_links as link
      where link.task_id = task.id and link.label_id = any(p_labels)
    ))
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
  order by
    case when sort = 'label' then (private.team_task_label_key(task.id) is null) end asc,
    case when sort = 'label' then private.team_task_label_key(task.id) end asc,
    private.team_task_sort_at(task.task_date, task.created_at) desc,
    task.id desc
  limit p_page_size;
end;
$$;

-- The list is read by assignee often enough to deserve its own index; the
-- filter is one of four a person combines, so it has to be cheap on its own.
create index if not exists team_tasks_assignee_idx
  on public.team_tasks (team_id, assignee_id);

comment on function public.list_team_tasks(
  uuid, timestamptz, timestamptz, uuid, integer, text, uuid, uuid, date, date, uuid[], text,
  uuid, boolean
) is
  'Team tasks newest-first by the date they are for, or by tag when p_sort is '
  '''label''. p_labels keeps the tasks carrying any of the given tags (018); '
  'p_assignee keeps one person''s, p_unassigned those nobody is on.';

revoke all on function public.list_team_tasks(
  uuid, timestamptz, timestamptz, uuid, integer, text, uuid, uuid, date, date, uuid[], text,
  uuid, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.list_team_tasks(
  uuid, timestamptz, timestamptz, uuid, integer, text, uuid, uuid, date, date, uuid[], text,
  uuid, boolean
) to authenticated;
