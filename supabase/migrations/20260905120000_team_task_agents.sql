-- Feature 017, part 2: tags on tasks. A task carries zero or more agents from
-- the space's accounts; the tag `[v31-434]` is derived from the account name
-- and the agent id at read time, so a rename follows and nothing is
-- snapshotted. Removing an agent removes its tag from every task (cascade).
--
-- Marking a run *from* a task is not automatic and has no server-side
-- coupling here: it is the ordinary `update_team_account_agent` call, made
-- by the person who decides the task was a launch.

-- ---------------------------------------------------------------------------
-- 1. The link table
-- ---------------------------------------------------------------------------
-- The composite the link anchors on, so a tag can never point across spaces.
alter table public.team_account_agents
  add constraint team_account_agents_id_team_unique unique (id, team_id);

create table public.team_task_agents (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  task_id uuid not null,
  agent_row_id uuid not null,
  attached_by uuid not null references auth.users(id) on delete restrict,
  attached_at timestamptz not null default now(),
  foreign key (task_id, team_id)
    references public.team_tasks(id, team_id) on delete cascade,
  foreign key (agent_row_id, team_id)
    references public.team_account_agents(id, team_id) on delete cascade,
  unique (task_id, agent_row_id)
);

create index team_task_agents_agent_idx on public.team_task_agents (agent_row_id, task_id);
create index team_task_agents_team_idx on public.team_task_agents (team_id);

alter table public.team_task_agents enable row level security;
alter table public.team_task_agents force row level security;

-- ---------------------------------------------------------------------------
-- 2. The tags a task carries, as one JSON list
-- ---------------------------------------------------------------------------
create or replace function private.team_task_agent_tags(p_task uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', link.id,
          'agent_row_id', agent.id,
          'account_id', account.id,
          'account_name', account.name,
          'agent_id', agent.agent_id,
          'note', agent.note
        )
        order by account.name, agent.created_at, agent.id
      )
      from public.team_task_agents as link
      join public.team_account_agents as agent on agent.id = link.agent_row_id
      join public.team_accounts as account on account.id = agent.account_id
      where link.task_id = p_task
    ),
    '[]'::jsonb
  );
$$;

revoke all on function private.team_task_agent_tags(uuid)
from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Reads: the list gains the tags and two scopes; the detail gains the tags
-- ---------------------------------------------------------------------------
drop function if exists public.list_team_tasks(uuid, timestamptz, timestamptz, uuid, integer, text);

-- `p_agent` keeps the tasks tagged with one agent; `p_account` those tagged
-- with any agent of one account. Both are how the Accounts tab links into
-- the task list ("2 tasks" on an agent row).
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
        'position', page.position
      ) order by page.position, page.id)
      from (
        select attachment.id, attachment.task_id, attachment.material_id,
               attachment.position, material.name, material.category,
               material.lifecycle, render.render_state
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

-- The accounts list says how many tasks carry each agent, so the Accounts tab
-- can link into the task list. Same signature; the count rides in the JSON.
create or replace function public.list_team_accounts(p_team uuid)
returns table (
  id uuid,
  team_id uuid,
  name text,
  created_at timestamptz,
  updated_at timestamptz,
  agents jsonb
)
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
  select account.id, account.team_id, account.name, account.created_at, account.updated_at,
         coalesce(
           (
             select jsonb_agg(
               jsonb_build_object(
                 'id', agent.id,
                 'account_id', agent.account_id,
                 'team_id', agent.team_id,
                 'agent_id', agent.agent_id,
                 'note', agent.note,
                 'task_count', (
                   select count(*) from public.team_task_agents as link
                   where link.agent_row_id = agent.id
                 ),
                 'created_at', agent.created_at,
                 'updated_at', agent.updated_at
               )
               order by agent.created_at, agent.id
             )
             from public.team_account_agents as agent
             where agent.account_id = account.id
           ),
           '[]'::jsonb
         ) as agents
  from public.team_accounts as account
  where account.team_id = p_team
  order by account.name, account.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Writes
-- ---------------------------------------------------------------------------
-- Tagging is a link, not a task edit: it neither bumps the task's updated_at
-- nor takes part in its optimistic-concurrency check, so two people can tag
-- and retitle at once without one of them being told the task moved.
create or replace function public.attach_team_task_agent(p_team uuid, p_task uuid, p_agent uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.team_tasks as task where task.id = p_task and task.team_id = p_team
  ) or not exists (
    select 1 from public.team_account_agents as agent
    where agent.id = p_agent and agent.team_id = p_team
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Tagging twice is the same tag: idempotent on purpose, so a double press
  -- or a second person's press is not an error anyone has to read.
  insert into public.team_task_agents (team_id, task_id, agent_row_id, attached_by)
  values (p_team, p_task, p_agent, actor)
  on conflict (task_id, agent_row_id) do nothing;

  return private.team_task_agent_tags(p_task);
end;
$$;

create or replace function public.detach_team_task_agent(p_team uuid, p_task uuid, p_agent uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.team_tasks as task where task.id = p_task and task.team_id = p_team
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  delete from public.team_task_agents as link
  where link.team_id = p_team and link.task_id = p_task and link.agent_row_id = p_agent;

  return private.team_task_agent_tags(p_task);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Policies, grants, realtime
-- ---------------------------------------------------------------------------
create policy team_task_agents_select_team
on public.team_task_agents for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

do $$
declare
  feature_function record;
begin
  for feature_function in
    select p.oid::regprocedure::text as signature
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and (p.proname like '%team_task_agent%' or p.proname = 'list_team_tasks')
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated, service_role',
      feature_function.signature
    );
  end loop;
end;
$$;

grant execute on function public.list_team_tasks(
  uuid, timestamptz, timestamptz, uuid, integer, text, uuid, uuid
) to authenticated;
grant execute on function public.attach_team_task_agent(uuid, uuid, uuid) to authenticated;
grant execute on function public.detach_team_task_agent(uuid, uuid, uuid) to authenticated;

grant select (id, team_id, task_id, agent_row_id, attached_at)
on table public.team_task_agents to authenticated;

alter publication supabase_realtime add table public.team_task_agents (
  id, team_id, task_id, agent_row_id, attached_at
);

comment on table public.team_task_agents is
  'Feature 017: the agents a task is tagged with; the tag text is derived at read time.';
