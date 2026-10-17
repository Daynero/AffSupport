-- A social can leave active pickers without losing its agents, placements or launches.
begin;

alter table public.team_accounts
  add column archived_at timestamptz,
  add column archive_version bigint not null default 0 check (archive_version >= 0);
create index team_accounts_archived on public.team_accounts(team_id, archived_at, sort_rank);

create table private.team_account_archive_requests (
  team_id uuid not null references public.teams(id) on delete cascade,
  request_id uuid not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  account_id uuid not null,
  desired_archived boolean not null,
  expected_version bigint not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(team_id, request_id)
);
revoke all on private.team_account_archive_requests from public, anon, authenticated;

-- The account row lock is shared with the launch trigger below. It closes the
-- check/write race when an editor creates or reactivates a launch concurrently.
create function public.set_team_account_archived(
  p_team uuid, p_account uuid, p_archived boolean, p_expected_version bigint, p_request_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  current_account public.team_accounts%rowtype;
  receipt private.team_account_archive_requests%rowtype;
  result jsonb;
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_account is null or p_archived is null or p_expected_version is null
    or p_expected_version < 0 or p_request_id is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into current_account from public.team_accounts
    where id = p_account and team_id = p_team for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  select * into receipt from private.team_account_archive_requests
    where team_id = p_team and request_id = p_request_id;
  if found then
    if receipt.actor_id <> actor or receipt.account_id <> p_account
      or receipt.desired_archived <> p_archived or receipt.expected_version <> p_expected_version then
      raise exception 'REQUEST_REUSE_CONFLICT' using errcode = '22023';
    end if;
    return receipt.result;
  end if;

  if current_account.archive_version <> p_expected_version then
    return jsonb_build_object('status', 'conflict', 'version', current_account.archive_version,
      'archivedAt', current_account.archived_at);
  end if;
  if p_archived and current_account.archived_at is null and exists (
    select 1 from public.team_launches l
    left join public.team_launch_revisions r
      on r.id = l.active_revision_id and r.team_id = l.team_id
    where l.team_id = p_team and l.archived_at is null
      and (l.work_status <> 'done' or exists (
        select 1 from public.team_launch_generations g
        where g.launch_id = l.id and g.team_id = p_team
          and g.state not in ('succeeded', 'canceled', 'failed', 'partial', 'interrupted')
      ))
      and (
        r.sources->>'accountId' = p_account::text
        or l.expected_source_snapshot->>'accountId' = p_account::text
        or exists (
          select 1 from public.team_account_agents a
          where a.team_id = p_team and a.account_id = p_account
            and a.id::text in (r.sources->>'agentRowId', r.config->>'agentRowId',
              l.draft_config->>'agentRowId')
        )
      )
  ) then
    raise exception 'ACTIVE_LAUNCH' using errcode = '23514';
  end if;

  if (current_account.archived_at is not null) <> p_archived then
    update public.team_accounts
      set archived_at = case when p_archived then clock_timestamp() else null end,
          archive_version = archive_version + 1
      where id = p_account and team_id = p_team
      returning * into current_account;
  end if;
  result := jsonb_build_object('status', 'applied', 'version', current_account.archive_version,
    'archivedAt', current_account.archived_at);
  insert into private.team_account_archive_requests
    (team_id, request_id, actor_id, account_id, desired_archived, expected_version, result)
    values (p_team, p_request_id, actor, p_account, p_archived, p_expected_version, result);
  return result;
end $$;
revoke all on function public.set_team_account_archived(uuid,uuid,boolean,bigint,uuid)
  from public, anon;
grant execute on function public.set_team_account_archived(uuid,uuid,boolean,bigint,uuid)
  to authenticated;

-- Even a direct Launches mutation must not create a newly active dependency on
-- an archived social. SHARE waits for an in-flight archive's row lock.
create function private.team_launch_active_social_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  social uuid;
begin
  if new.archived_at is not null or new.work_status = 'done' then return new; end if;
  for social in
    select distinct candidate.id from public.team_accounts candidate
    where candidate.team_id = new.team_id and (
      candidate.id::text = new.expected_source_snapshot->>'accountId'
      or exists (select 1 from public.team_account_agents a
        where a.team_id = new.team_id and a.account_id = candidate.id
          and a.id::text = new.draft_config->>'agentRowId')
      or exists (select 1 from public.team_launch_revisions r
        where r.id = new.active_revision_id and r.team_id = new.team_id
          and (r.sources->>'accountId' = candidate.id::text
            or exists (select 1 from public.team_account_agents a
              where a.team_id = new.team_id and a.account_id = candidate.id
                and a.id::text in (r.sources->>'agentRowId', r.config->>'agentRowId'))))
    ) order by candidate.id
  loop
    perform 1 from public.team_accounts where id = social and team_id = new.team_id
      and archived_at is null for share;
    if not found then raise exception 'ACCOUNT_ARCHIVED' using errcode = '23514'; end if;
  end loop;
  return new;
end $$;
create trigger team_launch_active_social_guard
  before insert or update of draft_config, expected_source_snapshot, active_revision_id,
    archived_at, work_status on public.team_launches
  for each row execute function private.team_launch_active_social_guard();

create function private.team_account_agent_active_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.team_accounts
    where id = new.account_id and team_id = new.team_id and archived_at is null for share;
  if not found then raise exception 'ACCOUNT_ARCHIVED' using errcode = '23514'; end if;
  return new;
end $$;
create trigger team_account_agent_active_guard
  before insert or update on public.team_account_agents
  for each row execute function private.team_account_agent_active_guard();

-- Active lists stay active; the separate reader preserves archived history.
create or replace function public.list_team_accounts(p_team uuid)
returns table (
  id uuid, team_id uuid, name text, created_at timestamptz,
  updated_at timestamptz, agents jsonb, task_count bigint
) language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
  select account.id, account.team_id, account.name, account.created_at, account.updated_at,
    coalesce((select jsonb_agg(private.team_agent_json(agent.id) order by agent.sort_rank, agent.id)
      from public.team_account_agents agent where agent.account_id = account.id), '[]'::jsonb),
    (select count(distinct link.task_id) from public.team_task_agents link
      join public.team_tasks task on task.id = link.task_id and task.team_id = link.team_id
      where link.account_id = account.id and link.team_id = p_team and task.status <> 'done')
  from public.team_accounts account
  where account.team_id = p_team and account.archived_at is null
  order by account.sort_rank, account.id;
end $$;

create function public.list_team_accounts_by_state(p_team uuid, p_state text)
returns table (
  id uuid, team_id uuid, name text, created_at timestamptz, updated_at timestamptz,
  archived_at timestamptz, archive_version bigint, agents jsonb, task_count bigint
) language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_state not in ('active', 'archived', 'all') or p_state is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return query
  select account.id, account.team_id, account.name, account.created_at, account.updated_at,
    account.archived_at, account.archive_version,
    coalesce((select jsonb_agg(private.team_agent_json(agent.id) order by agent.sort_rank, agent.id)
      from public.team_account_agents agent where agent.account_id = account.id), '[]'::jsonb),
    (select count(distinct link.task_id) from public.team_task_agents link
      join public.team_tasks task on task.id = link.task_id and task.team_id = link.team_id
      where link.account_id = account.id and link.team_id = p_team and task.status <> 'done')
  from public.team_accounts account
  where account.team_id = p_team
    and (p_state = 'all' or (account.archived_at is null) = (p_state = 'active'))
  order by account.sort_rank, account.id;
end $$;
revoke all on function public.list_team_accounts_by_state(uuid,text) from public, anon;
grant execute on function public.list_team_accounts_by_state(uuid,text) to authenticated;

-- A deleted archived account would silently erase its agent rows via cascade.
create or replace function public.delete_team_account(p_team uuid, p_account uuid)
returns table (ok boolean) language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  perform 1 from public.team_accounts where id = p_account and team_id = p_team for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if exists (select 1 from public.team_accounts where id = p_account and archived_at is not null)
    or exists (select 1 from public.team_launches l
      where l.team_id = p_team and (
        l.expected_source_snapshot->>'accountId' = p_account::text))
    or exists (select 1 from public.team_launch_revisions r
      where r.team_id = p_team and r.sources->>'accountId' = p_account::text)
    or exists (select 1 from public.team_account_agents a
      where a.team_id = p_team and a.account_id = p_account
        and (exists (select 1 from public.team_launches l
          where l.team_id = p_team and l.draft_config->>'agentRowId' = a.id::text)
        or exists (select 1 from public.team_launch_revisions r
          where r.team_id = p_team and a.id::text in
            (r.sources->>'agentRowId', r.config->>'agentRowId')))) then
    raise exception 'ACCOUNT_HAS_HISTORY' using errcode = '23514';
  end if;
  delete from public.team_accounts where id = p_account and team_id = p_team;
  return query select true;
end $$;

grant select (archived_at, archive_version) on public.team_accounts to authenticated;
alter publication supabase_realtime drop table public.team_accounts;
alter publication supabase_realtime add table public.team_accounts (
  id, team_id, name, sort_rank, archived_at, archive_version, created_at, updated_at
);
commit;
