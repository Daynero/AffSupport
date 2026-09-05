-- Feature 017: team accounts — the social accounts a space runs from, each
-- holding the agents attached to it, with one run note per agent.
--
-- Shape mirrors team_tasks / team_task_attachments: a per-space parent with a
-- composite (id, team_id) unique, a child anchored to that composite so it can
-- never drift into another space, select-only RLS for viewers, and every write
-- behind a security-definer function gated on private.can(team, 'edit').

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.team_accounts (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_accounts_name_length check (char_length(name) between 1 and 40),
  constraint team_accounts_name_no_brackets check (name !~ '[\[\]]'),
  unique (id, team_id)
);

-- One name per space, however it is cased: "V31" and "v31" are the same
-- account to the people typing them, and the tag a task carries must resolve
-- to exactly one.
create unique index team_accounts_name_idx
  on public.team_accounts (team_id, lower(name));

create table public.team_account_agents (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  account_id uuid not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  agent_id text not null,
  -- The run this agent is on; null is "free". Blank is normalized to null by
  -- the functions, and the check keeps a stray write from inventing a third
  -- state.
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (account_id, team_id)
    references public.team_accounts(id, team_id) on delete cascade,
  constraint team_account_agents_agent_id_length
    check (char_length(agent_id) between 1 and 64),
  constraint team_account_agents_agent_id_no_space check (agent_id !~ '\s'),
  constraint team_account_agents_note_length
    check (note is null or char_length(note) between 1 and 120),
  unique (account_id, agent_id)
);

create index team_account_agents_list_idx
  on public.team_account_agents (account_id, created_at, id);

-- The select policy and the realtime filter both key on the space.
create index team_account_agents_team_idx
  on public.team_account_agents (team_id);

alter table public.team_accounts enable row level security;
alter table public.team_accounts force row level security;
alter table public.team_account_agents enable row level security;
alter table public.team_account_agents force row level security;

create trigger team_accounts_set_updated_at
before update on public.team_accounts
for each row execute function private.team_set_updated_at();

create trigger team_account_agents_set_updated_at
before update on public.team_account_agents
for each row execute function private.team_set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Normalization helpers
-- ---------------------------------------------------------------------------
create or replace function private.team_account_name(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), '');
$$;

create or replace function private.team_agent_note(p_note text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(btrim(regexp_replace(coalesce(p_note, ''), '\s+', ' ', 'g')), '');
$$;

revoke all on function private.team_account_name(text)
from public, anon, authenticated, service_role;
revoke all on function private.team_agent_note(text)
from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Read
-- ---------------------------------------------------------------------------
-- The whole list in one round trip: accounts with their agents nested as JSON.
-- A space holds tens of accounts and a few agents each, so there is nothing to
-- page; the client sorts (natural order) and filters.
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
-- 4. Accounts
-- ---------------------------------------------------------------------------
create or replace function public.create_team_account(p_team uuid, p_name text)
returns public.team_accounts
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  clean_name text := private.team_account_name(p_name);
  created public.team_accounts%rowtype;
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if clean_name is null or char_length(clean_name) > 40 or clean_name ~ '[\[\]]' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.team_accounts as existing
    where existing.team_id = p_team and lower(existing.name) = lower(clean_name)
  ) then
    raise exception 'NAME_CONFLICT' using errcode = '23505';
  end if;

  insert into public.team_accounts (team_id, created_by, name)
  values (p_team, actor, clean_name)
  returning * into created;
  return created;
end;
$$;

create or replace function public.rename_team_account(p_team uuid, p_account uuid, p_name text)
returns public.team_accounts
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  clean_name text := private.team_account_name(p_name);
  updated public.team_accounts%rowtype;
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if clean_name is null or char_length(clean_name) > 40 or clean_name ~ '[\[\]]' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.team_accounts as account
    where account.id = p_account and account.team_id = p_team
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.team_accounts as existing
    where existing.team_id = p_team
      and existing.id <> p_account
      and lower(existing.name) = lower(clean_name)
  ) then
    raise exception 'NAME_CONFLICT' using errcode = '23505';
  end if;

  update public.team_accounts as account
  set name = clean_name
  where account.id = p_account and account.team_id = p_team
  returning * into updated;
  return updated;
end;
$$;

-- The agents go with the account (cascade). Nothing else references either.
create or replace function public.delete_team_account(p_team uuid, p_account uuid)
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
    select 1 from public.team_accounts as account
    where account.id = p_account and account.team_id = p_team
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  delete from public.team_accounts as account
  where account.id = p_account and account.team_id = p_team;
  return query select true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Agents
-- ---------------------------------------------------------------------------
create or replace function public.add_team_account_agent(
  p_team uuid,
  p_account uuid,
  p_agent_id text,
  p_note text default null
)
returns public.team_account_agents
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  clean_id text := nullif(btrim(coalesce(p_agent_id, '')), '');
  clean_note text := private.team_agent_note(p_note);
  created public.team_account_agents%rowtype;
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

  insert into public.team_account_agents (team_id, account_id, created_by, agent_id, note)
  values (p_team, p_account, actor, clean_id, clean_note)
  returning * into created;
  return created;
end;
$$;

-- Both fields every time: the row is two values, and "which of them changed"
-- is not worth a patch grammar. Clearing the note is how an agent is freed.
create or replace function public.update_team_account_agent(
  p_team uuid,
  p_agent uuid,
  p_agent_id text,
  p_note text default null
)
returns public.team_account_agents
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  clean_id text := nullif(btrim(coalesce(p_agent_id, '')), '');
  clean_note text := private.team_agent_note(p_note);
  current_account uuid;
  updated public.team_account_agents%rowtype;
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if clean_id is null or char_length(clean_id) > 64 or clean_id ~ '\s'
     or (clean_note is not null and char_length(clean_note) > 120) then
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
  set agent_id = clean_id, note = clean_note
  where agent.id = p_agent and agent.team_id = p_team
  returning * into updated;
  return updated;
end;
$$;

create or replace function public.delete_team_account_agent(p_team uuid, p_agent uuid)
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
    select 1 from public.team_account_agents as agent
    where agent.id = p_agent and agent.team_id = p_team
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  delete from public.team_account_agents as agent
  where agent.id = p_agent and agent.team_id = p_team;
  return query select true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Policies, grants, realtime
-- ---------------------------------------------------------------------------
create policy team_accounts_select_team
on public.team_accounts for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

create policy team_account_agents_select_team
on public.team_account_agents for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

-- Restrict every function of the feature first, so a missed signature can
-- never keep PostgreSQL's default PUBLIC execute grant.
do $$
declare
  feature_function record;
begin
  for feature_function in
    select p.oid::regprocedure::text as signature
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and (p.proname like '%team_account%' or p.proname like '%team_agent%')
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated, service_role',
      feature_function.signature
    );
  end loop;
end;
$$;

grant execute on function public.list_team_accounts(uuid) to authenticated;
grant execute on function public.create_team_account(uuid, text) to authenticated;
grant execute on function public.rename_team_account(uuid, uuid, text) to authenticated;
grant execute on function public.delete_team_account(uuid, uuid) to authenticated;
grant execute on function public.add_team_account_agent(uuid, uuid, text, text) to authenticated;
grant execute on function public.update_team_account_agent(uuid, uuid, text, text)
to authenticated;
grant execute on function public.delete_team_account_agent(uuid, uuid) to authenticated;

-- `created_by` stays server-side, as on team_tasks.
grant select (id, team_id, name, created_at, updated_at)
on table public.team_accounts to authenticated;
grant select (id, team_id, account_id, agent_id, note, created_at, updated_at)
on table public.team_account_agents to authenticated;

alter publication supabase_realtime add table public.team_accounts (
  id, team_id, name, created_at, updated_at
);
alter publication supabase_realtime add table public.team_account_agents (
  id, team_id, account_id, agent_id, note, created_at, updated_at
);

comment on table public.team_accounts is
  'Feature 017: the social accounts a space runs from; agents hang off each one.';
comment on table public.team_account_agents is
  'Feature 017: an agent under an account. A null note means the agent is free.';
