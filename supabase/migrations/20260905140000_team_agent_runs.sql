-- Feature 017, part 3: an agent carries any number of runs, not one note.
--
-- The owner's first model was one run per agent ("Pro Caps | TR 02/09"); in
-- use an agent turned out to carry several at once. Runs become rows of their
-- own, each editable and removable, and "free" becomes "no runs". The
-- existing note on every agent becomes its first run, so nothing is lost.

-- ---------------------------------------------------------------------------
-- 1. The runs table, seeded from the old note
-- ---------------------------------------------------------------------------
create table public.team_agent_runs (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  agent_row_id uuid not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  note text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (agent_row_id, team_id)
    references public.team_account_agents(id, team_id) on delete cascade,
  constraint team_agent_runs_note_length check (char_length(note) between 1 and 120)
);

create index team_agent_runs_agent_idx on public.team_agent_runs (agent_row_id, created_at, id);
create index team_agent_runs_team_idx on public.team_agent_runs (team_id);

alter table public.team_agent_runs enable row level security;
alter table public.team_agent_runs force row level security;

create trigger team_agent_runs_set_updated_at
before update on public.team_agent_runs
for each row execute function private.team_set_updated_at();

insert into public.team_agent_runs (team_id, agent_row_id, created_by, note, created_at, updated_at)
select agent.team_id, agent.id, agent.created_by, agent.note, agent.updated_at, agent.updated_at
from public.team_account_agents as agent
where agent.note is not null and btrim(agent.note) <> '';

-- The column leaves the publication before it leaves the table.
alter publication supabase_realtime drop table public.team_account_agents;
alter table public.team_account_agents drop constraint team_account_agents_note_length;
alter table public.team_account_agents drop column note;
alter publication supabase_realtime add table public.team_account_agents (
  id, team_id, account_id, agent_id, created_at, updated_at
);

-- ---------------------------------------------------------------------------
-- 2. One JSON shape for an agent, everywhere it is returned
-- ---------------------------------------------------------------------------
create or replace function private.team_agent_runs_json(p_agent uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (
      select jsonb_agg(
        jsonb_build_object('id', run.id, 'note', run.note, 'created_at', run.created_at)
        order by run.created_at, run.id
      )
      from public.team_agent_runs as run
      where run.agent_row_id = p_agent
    ),
    '[]'::jsonb
  );
$$;

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
    'task_count', (
      select count(*) from public.team_task_agents as link where link.agent_row_id = agent.id
    ),
    'created_at', agent.created_at,
    'updated_at', agent.updated_at
  )
  from public.team_account_agents as agent
  where agent.id = p_agent;
$$;

revoke all on function private.team_agent_runs_json(uuid)
from public, anon, authenticated, service_role;
revoke all on function private.team_agent_json(uuid)
from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Reads
-- ---------------------------------------------------------------------------
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
             select jsonb_agg(private.team_agent_json(agent.id) order by agent.created_at, agent.id)
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
          'runs', private.team_agent_runs_json(agent.id)
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

-- ---------------------------------------------------------------------------
-- 4. Writes on agents: the id alone; an optional first run on creation
-- ---------------------------------------------------------------------------
drop function if exists public.add_team_account_agent(uuid, uuid, text, text);
drop function if exists public.update_team_account_agent(uuid, uuid, text, text);

create function public.add_team_account_agent(
  p_team uuid,
  p_account uuid,
  p_agent_id text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  clean_id text := nullif(btrim(coalesce(p_agent_id, '')), '');
  clean_note text := private.team_agent_note(p_note);
  created_id uuid;
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if clean_id is null or char_length(clean_id) > 64 or clean_id ~ '\s'
     or (clean_note is not null and char_length(clean_note) > 120) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.team_accounts as account
    where account.id = p_account and account.team_id = p_team
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.team_account_agents as existing
    where existing.account_id = p_account and existing.agent_id = clean_id
  ) then
    raise exception 'NAME_CONFLICT' using errcode = '23505';
  end if;

  insert into public.team_account_agents (team_id, account_id, created_by, agent_id)
  values (p_team, p_account, actor, clean_id)
  returning id into created_id;

  if clean_note is not null then
    insert into public.team_agent_runs (team_id, agent_row_id, created_by, note)
    values (p_team, created_id, actor, clean_note);
  end if;

  return private.team_agent_json(created_id);
end;
$$;

create function public.update_team_account_agent(p_team uuid, p_agent uuid, p_agent_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  clean_id text := nullif(btrim(coalesce(p_agent_id, '')), '');
  current_account uuid;
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if clean_id is null or char_length(clean_id) > 64 or clean_id ~ '\s' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  select agent.account_id into current_account
  from public.team_account_agents as agent
  where agent.id = p_agent and agent.team_id = p_team
  for update;
  if current_account is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.team_account_agents as existing
    where existing.account_id = current_account
      and existing.id <> p_agent
      and existing.agent_id = clean_id
  ) then
    raise exception 'NAME_CONFLICT' using errcode = '23505';
  end if;

  update public.team_account_agents as agent
  set agent_id = clean_id
  where agent.id = p_agent and agent.team_id = p_team;

  return private.team_agent_json(p_agent);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Writes on runs. Each returns the agent, with all its runs, so the caller
--    replaces one thing and never merges.
-- ---------------------------------------------------------------------------
create function public.add_team_agent_run(p_team uuid, p_agent uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  clean_note text := private.team_agent_note(p_note);
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if clean_note is null or char_length(clean_note) > 120 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.team_account_agents as agent
    where agent.id = p_agent and agent.team_id = p_team
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.team_agent_runs (team_id, agent_row_id, created_by, note)
  values (p_team, p_agent, actor, clean_note);

  return private.team_agent_json(p_agent);
end;
$$;

create function public.update_team_agent_run(p_team uuid, p_run uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  clean_note text := private.team_agent_note(p_note);
  agent_row uuid;
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if clean_note is null or char_length(clean_note) > 120 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  update public.team_agent_runs as run
  set note = clean_note
  where run.id = p_run and run.team_id = p_team
  returning run.agent_row_id into agent_row;
  if agent_row is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  return private.team_agent_json(agent_row);
end;
$$;

create function public.delete_team_agent_run(p_team uuid, p_run uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  agent_row uuid;
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  delete from public.team_agent_runs as run
  where run.id = p_run and run.team_id = p_team
  returning run.agent_row_id into agent_row;
  if agent_row is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  return private.team_agent_json(agent_row);
end;
$$;

-- "Free": every run on the agent goes at once.
create function public.clear_team_agent_runs(p_team uuid, p_agent uuid)
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

  delete from public.team_agent_runs as run
  where run.agent_row_id = p_agent and run.team_id = p_team;

  return private.team_agent_json(p_agent);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Policies, grants, realtime
-- ---------------------------------------------------------------------------
create policy team_agent_runs_select_team
on public.team_agent_runs for select to authenticated
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
      and (p.proname like '%team_agent%' or p.proname like '%team_account_agent%')
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated, service_role',
      feature_function.signature
    );
  end loop;
end;
$$;

grant execute on function public.add_team_account_agent(uuid, uuid, text, text) to authenticated;
grant execute on function public.update_team_account_agent(uuid, uuid, text) to authenticated;
grant execute on function public.delete_team_account_agent(uuid, uuid) to authenticated;
grant execute on function public.add_team_agent_run(uuid, uuid, text) to authenticated;
grant execute on function public.update_team_agent_run(uuid, uuid, text) to authenticated;
grant execute on function public.delete_team_agent_run(uuid, uuid) to authenticated;
grant execute on function public.clear_team_agent_runs(uuid, uuid) to authenticated;

grant select (id, team_id, agent_row_id, note, created_at, updated_at)
on table public.team_agent_runs to authenticated;

alter publication supabase_realtime add table public.team_agent_runs (
  id, team_id, agent_row_id, note, created_at, updated_at
);

comment on table public.team_agent_runs is
  'Feature 017: the runs on an agent, one row each; an agent with none is free.';
