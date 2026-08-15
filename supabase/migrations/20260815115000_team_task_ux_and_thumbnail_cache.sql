-- Status filtering is intentionally server-side so large workspaces do not
-- download every task merely to hide three of the four status groups.
drop function if exists public.list_team_tasks(uuid, timestamptz, timestamptz, uuid, integer);

create function public.list_team_tasks(
  p_team uuid,
  p_created_from timestamptz default null,
  p_created_to timestamptz default null,
  p_cursor uuid default null,
  p_page_size integer default 50,
  p_status text default null
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
         task.created_at, task.updated_at, task.completed_at
  from public.team_tasks as task
  left join public.team_task_attachments as attachment on attachment.task_id = task.id
  where task.team_id = p_team
    and (p_status is null or task.status = p_status)
    and (p_created_from is null or (task.created_at >= p_created_from and task.created_at < p_created_to))
    and (p_cursor is null or (task.created_at, task.id) < (cursor_created_at, p_cursor))
  group by task.id
  order by task.created_at desc, task.id desc
  limit p_page_size;
end;
$$;

revoke all on function public.list_team_tasks(uuid, timestamptz, timestamptz, uuid, integer, text)
from public, anon, authenticated, service_role;
grant execute on function public.list_team_tasks(uuid, timestamptz, timestamptz, uuid, integer, text)
to authenticated;

-- A thumbnail is an access-controlled derivative. Keep it private in Storage,
-- and let the Edge relay authorize every read before returning its bytes.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'team-thumbnail-cache',
  'team-thumbnail-cache',
  false,
  4194304,
  array['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
