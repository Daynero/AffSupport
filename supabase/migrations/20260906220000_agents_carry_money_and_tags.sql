-- Feature 019: an agent carries money and tags, and the list can be copied out.
--
-- Three things, one migration, because they are one job on screen: a media
-- buyer walks the accounts list, writes how much each agent has left and how
-- much to top it up, and then copies the day's top-ups out — grouped by social
-- account when the list is read by a person, grouped by agent tag when it is
-- handed to whoever pays.
--
-- The tags are the 018 dictionary with a second set in it rather than a second
-- dictionary: the shape (a name, a colour, a space, a case-insensitive unique
-- name) was identical, and two tables would have meant two of every function.
-- `team_task_labels` is therefore renamed to `team_labels` and gains a scope.
-- Nothing outside this feature has shipped against the old name.

-- ---------------------------------------------------------------------------
-- 1. One dictionary, two sets
-- ---------------------------------------------------------------------------
alter table public.team_task_labels rename to team_labels;

alter table public.team_labels
  add column scope text not null default 'task',
  add constraint team_labels_scope check (scope in ('task', 'agent'));

-- Uniqueness is per set: a task tag "Hot" and an agent tag "Hot" are two
-- different things a team may well want at once.
drop index if exists public.team_task_labels_name_idx;
create unique index team_labels_name_idx
  on public.team_labels (team_id, scope, lower(name));

-- The links a task carries keep their table and their foreign keys — the
-- rename followed them — and gain nothing. What they do gain is a guard: a
-- task may only carry a tag from the task set.
create or replace function private.team_label_scope(p_label uuid, p_scope text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.team_labels as label
    where label.id = p_label and label.scope = p_scope
  );
$$;

revoke all on function private.team_label_scope(uuid, text)
from public, anon, authenticated, service_role;

-- The tags an agent carries. Same shape as the task links, anchored on the
-- same composite so a tag can never cross into another space.
create table public.team_agent_labels (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  agent_row_id uuid not null,
  label_id uuid not null,
  attached_by uuid not null references auth.users(id) on delete restrict,
  attached_at timestamptz not null default now(),
  foreign key (agent_row_id, team_id)
    references public.team_account_agents(id, team_id) on delete cascade,
  foreign key (label_id, team_id)
    references public.team_labels(id, team_id) on delete cascade,
  unique (agent_row_id, label_id)
);

create index team_agent_labels_agent_idx on public.team_agent_labels (agent_row_id, label_id);
create index team_agent_labels_label_idx on public.team_agent_labels (label_id, agent_row_id);
create index team_agent_labels_team_idx on public.team_agent_labels (team_id);

alter table public.team_agent_labels enable row level security;
alter table public.team_agent_labels force row level security;

-- The task-side helpers now read the renamed table. Same names: they return a
-- *task's* labels and a task's sort key, which is still what they are called.
create or replace function private.team_task_labels(p_task uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (
      select jsonb_agg(
        jsonb_build_object('id', label.id, 'name', label.name, 'color', label.color)
        order by lower(label.name), label.id
      )
      from public.team_task_label_links as link
      join public.team_labels as label on label.id = link.label_id
      where link.task_id = p_task
    ),
    '[]'::jsonb
  );
$$;

create or replace function private.team_task_label_key(p_task uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select min(lower(label.name))
  from public.team_task_label_links as link
  join public.team_labels as label on label.id = link.label_id
  where link.task_id = p_task;
$$;

create or replace function private.team_agent_labels(p_agent uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (
      select jsonb_agg(
        jsonb_build_object('id', label.id, 'name', label.name, 'color', label.color)
        order by lower(label.name), label.id
      )
      from public.team_agent_labels as link
      join public.team_labels as label on label.id = link.label_id
      where link.agent_row_id = p_agent
    ),
    '[]'::jsonb
  );
$$;

revoke all on function private.team_task_labels(uuid)
from public, anon, authenticated, service_role;
revoke all on function private.team_task_label_key(uuid)
from public, anon, authenticated, service_role;
revoke all on function private.team_agent_labels(uuid)
from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The dictionary's functions, now over both sets
-- ---------------------------------------------------------------------------
-- The name normalizer loses its "task": it normalizes a tag's name, and there
-- are two kinds of tag now.
create or replace function private.team_label_name(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), '');
$$;

revoke all on function private.team_label_name(text)
from public, anon, authenticated, service_role;
drop function if exists private.team_task_label_name(text);

drop function if exists public.list_team_task_labels(uuid);
drop function if exists public.create_team_task_label(uuid, text, text);
drop function if exists public.update_team_task_label(uuid, uuid, text, text);
drop function if exists public.delete_team_task_label(uuid, uuid);

-- The count beside a tag counts the things it is on, which is a different
-- table per set — so the set decides which one is asked.
create function public.list_team_labels(p_team uuid, p_scope text default 'task')
returns table (
  id uuid,
  team_id uuid,
  scope text,
  name text,
  color text,
  usage_count bigint,
  created_at timestamptz,
  updated_at timestamptz
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
  if p_scope not in ('task', 'agent') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return query
  select label.id, label.team_id, label.scope, label.name, label.color,
         case
           when label.scope = 'task' then (
             select count(*) from public.team_task_label_links as link
             where link.label_id = label.id
           )
           else (
             select count(*) from public.team_agent_labels as link
             where link.label_id = label.id
           )
         end as usage_count,
         label.created_at, label.updated_at
  from public.team_labels as label
  where label.team_id = p_team and label.scope = p_scope
  order by lower(label.name), label.id;
end;
$$;

create function public.create_team_label(
  p_team uuid,
  p_name text,
  p_color text default 'purple',
  p_scope text default 'task'
)
returns public.team_labels
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  clean_name text := private.team_label_name(p_name);
  clean_color text := coalesce(nullif(btrim(coalesce(p_color, '')), ''), 'purple');
  created public.team_labels%rowtype;
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if clean_name is null or char_length(clean_name) > 24
     or clean_color not in
        ('purple', 'blue', 'teal', 'green', 'honey', 'orange', 'red', 'pink', 'slate')
     or p_scope not in ('task', 'agent') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  -- Sixty per set, not sixty in total: the two sets are read in different
  -- places and neither should be able to crowd the other out.
  if (select count(*) from public.team_labels as existing
      where existing.team_id = p_team and existing.scope = p_scope) >= 60 then
    raise exception 'WRONG_STATE' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.team_labels as existing
    where existing.team_id = p_team
      and existing.scope = p_scope
      and lower(existing.name) = lower(clean_name)
  ) then
    raise exception 'NAME_CONFLICT' using errcode = '23505';
  end if;

  insert into public.team_labels (team_id, created_by, name, color, scope)
  values (p_team, actor, clean_name, clean_color, p_scope)
  returning * into created;
  return created;
end;
$$;

-- A tag's set is fixed at birth: moving "Hot" from tasks to agents would take
-- it off everything it is on, which is a delete wearing an edit's clothes.
create function public.update_team_label(
  p_team uuid,
  p_label uuid,
  p_name text,
  p_color text
)
returns public.team_labels
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  clean_name text := private.team_label_name(p_name);
  clean_color text := coalesce(nullif(btrim(coalesce(p_color, '')), ''), 'purple');
  current_scope text;
  updated public.team_labels%rowtype;
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if clean_name is null or char_length(clean_name) > 24
     or clean_color not in
        ('purple', 'blue', 'teal', 'green', 'honey', 'orange', 'red', 'pink', 'slate') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select label.scope into current_scope
  from public.team_labels as label
  where label.id = p_label and label.team_id = p_team;
  if current_scope is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.team_labels as existing
    where existing.team_id = p_team
      and existing.scope = current_scope
      and existing.id <> p_label
      and lower(existing.name) = lower(clean_name)
  ) then
    raise exception 'NAME_CONFLICT' using errcode = '23505';
  end if;

  update public.team_labels as label
  set name = clean_name, color = clean_color
  where label.id = p_label and label.team_id = p_team
  returning * into updated;
  return updated;
end;
$$;

create function public.delete_team_label(p_team uuid, p_label uuid)
returns table (ok boolean)
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
    select 1 from public.team_labels as label
    where label.id = p_label and label.team_id = p_team
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  delete from public.team_labels as label
  where label.id = p_label and label.team_id = p_team;
  return query select true;
end;
$$;

-- The task links keep their own functions; only the table under them moved.
create or replace function public.attach_team_task_label(p_team uuid, p_task uuid, p_label uuid)
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
    select 1 from public.team_labels as label
    where label.id = p_label and label.team_id = p_team and label.scope = 'task'
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.team_task_label_links (team_id, task_id, label_id, attached_by)
  values (p_team, p_task, p_label, actor)
  on conflict (task_id, label_id) do nothing;

  return private.team_task_labels(p_task);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Tagging an agent
-- ---------------------------------------------------------------------------
create function public.attach_team_agent_label(p_team uuid, p_agent uuid, p_label uuid)
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
    select 1 from public.team_account_agents as agent
    where agent.id = p_agent and agent.team_id = p_team
  ) or not exists (
    select 1 from public.team_labels as label
    where label.id = p_label and label.team_id = p_team and label.scope = 'agent'
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.team_agent_labels (team_id, agent_row_id, label_id, attached_by)
  values (p_team, p_agent, p_label, actor)
  on conflict (agent_row_id, label_id) do nothing;

  return private.team_agent_json(p_agent);
end;
$$;

create function public.detach_team_agent_label(p_team uuid, p_agent uuid, p_label uuid)
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
    select 1 from public.team_account_agents as agent
    where agent.id = p_agent and agent.team_id = p_team
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  delete from public.team_agent_labels as link
  where link.team_id = p_team and link.agent_row_id = p_agent and link.label_id = p_label;

  return private.team_agent_json(p_agent);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The money on an agent
-- ---------------------------------------------------------------------------
-- Whole units, not cents: these are figures a person types in four characters
-- and reads back at a glance ("$50"), never a sum anything computes with.
alter table public.team_account_agents
  add column balance integer,
  add column topup integer,
  add constraint team_account_agents_balance_range
    check (balance is null or balance between 0 and 9999),
  add constraint team_account_agents_topup_range
    check (topup is null or topup between 0 and 9999);

-- The publication carries the two new columns, so a teammate's figure reaches
-- everyone's list the way a run does.
alter publication supabase_realtime drop table public.team_account_agents;
alter publication supabase_realtime add table public.team_account_agents (
  id, team_id, account_id, agent_id, balance, topup, created_at, updated_at
);

create or replace function private.team_agent_json(p_agent uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', agent.id,
    'account_id', agent.account_id,
    'team_id', agent.team_id,
    'agent_id', agent.agent_id,
    'runs', private.team_agent_runs_json(agent.id),
    'labels', private.team_agent_labels(agent.id),
    'balance', agent.balance,
    'topup', agent.topup,
    'task_count', (
      select count(*) from public.team_task_agents as link where link.agent_row_id = agent.id
    ),
    'created_at', agent.created_at,
    'updated_at', agent.updated_at
  )
  from public.team_account_agents as agent
  where agent.id = p_agent;
$$;

-- Both figures every time, like the agent's own two fields: "which of them
-- changed" is not worth a patch grammar, and null is how a figure is cleared.
create function public.set_team_agent_money(
  p_team uuid,
  p_agent uuid,
  p_balance integer,
  p_topup integer
)
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
  if (p_balance is not null and p_balance not between 0 and 9999)
     or (p_topup is not null and p_topup not between 0 and 9999) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.team_account_agents as agent
    where agent.id = p_agent and agent.team_id = p_team
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.team_account_agents as agent
  set balance = p_balance, topup = p_topup
  where agent.id = p_agent and agent.team_id = p_team;

  return private.team_agent_json(p_agent);
end;
$$;

-- The whole space's top-ups, in one press, once they have been paid. What they
-- were comes back with the call so the toast can put them back one by one —
-- the same shape `clear_team_agent_run_markers` returns for the same reason.
create function public.clear_team_agent_topups(p_team uuid)
returns table (agent_row_id uuid, topup integer)
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

  -- The figures are read *before* the update, not returned from it: RETURNING
  -- hands back the new row, which here is the null we just wrote — an undo
  -- built on that would restore nothing and say it had.
  return query
  with targets as (
    select agent.id, agent.topup
    from public.team_account_agents as agent
    where agent.team_id = p_team and agent.topup is not null
  ), cleared as (
    update public.team_account_agents as agent
    set topup = null
    from targets
    where agent.id = targets.id
    returning agent.id
  )
  select targets.id, targets.topup from targets;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Policies, grants, realtime
-- ---------------------------------------------------------------------------
create policy team_agent_labels_select_team
on public.team_agent_labels for select to authenticated
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
      and (p.proname like '%team_label%'
        or p.proname like '%team_agent_label%'
        or p.proname like '%team_agent_money%'
        or p.proname like '%team_agent_topup%'
        or p.proname = 'team_agent_json')
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated, service_role',
      feature_function.signature
    );
  end loop;
end;
$$;

grant execute on function public.list_team_labels(uuid, text) to authenticated;
grant execute on function public.create_team_label(uuid, text, text, text) to authenticated;
grant execute on function public.update_team_label(uuid, uuid, text, text) to authenticated;
grant execute on function public.delete_team_label(uuid, uuid) to authenticated;
grant execute on function public.attach_team_agent_label(uuid, uuid, uuid) to authenticated;
grant execute on function public.detach_team_agent_label(uuid, uuid, uuid) to authenticated;
grant execute on function public.set_team_agent_money(uuid, uuid, integer, integer) to authenticated;
grant execute on function public.clear_team_agent_topups(uuid) to authenticated;
grant execute on function public.attach_team_task_label(uuid, uuid, uuid) to authenticated;

grant select (id, team_id, scope, name, color, created_at, updated_at)
on table public.team_labels to authenticated;
grant select (id, team_id, agent_row_id, label_id, attached_at)
on table public.team_agent_labels to authenticated;

alter publication supabase_realtime add table public.team_agent_labels (
  id, team_id, agent_row_id, label_id, attached_at
);

comment on table public.team_labels is
  'Features 018/019: the tags a space keeps, in two sets — task tags and agent tags.';
comment on table public.team_agent_labels is
  'Feature 019: the tags an agent carries; the copy-out groups by them.';
comment on column public.team_account_agents.balance is
  'Feature 019: what the agent has left, in whole units. Null is unknown.';
comment on column public.team_account_agents.topup is
  'Feature 019: what to add to the agent. Null is nothing to add; the copy-out '
  'lists only the agents that carry one.';
