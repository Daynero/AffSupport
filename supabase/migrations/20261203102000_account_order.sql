-- Shared, version-fenced order for socials and the agents inside each social.
begin;

create function private.team_natural_order_key(value text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  rest text := lower(coalesce(value, ''));
  part text;
  result text := '';
begin
  while rest <> '' loop
    part := substring(rest from '^[0-9]+');
    if part is not null then
      result := result || '#' || lpad(ltrim(part, '0'), 20, '0');
    else
      part := substring(rest from '^[^0-9]+');
      result := result || '~' || part;
    end if;
    rest := substring(rest from char_length(part) + 1);
  end loop;
  return result;
end $$;

alter table public.team_accounts add column sort_rank bigint;
alter table public.team_account_agents add column sort_rank bigint;

with ranked as (
  select id, row_number() over (
    partition by team_id order by private.team_natural_order_key(name), lower(name), id
  ) as rank from public.team_accounts
)
update public.team_accounts a set sort_rank = ranked.rank from ranked where ranked.id = a.id;

with ranked as (
  select a.id, row_number() over (
    partition by a.team_id, a.account_id
    order by exists (select 1 from public.team_agent_runs r where r.agent_row_id = a.id),
      private.team_natural_order_key(a.agent_id), lower(a.agent_id), a.id
  ) as rank from public.team_account_agents a
)
update public.team_account_agents a set sort_rank = ranked.rank from ranked where ranked.id = a.id;

alter table public.team_accounts alter column sort_rank set not null;
alter table public.team_account_agents alter column sort_rank set not null;
alter table public.team_accounts add constraint team_accounts_order_unique
  unique (team_id, sort_rank) deferrable initially deferred;
alter table public.team_account_agents add constraint team_account_agents_order_unique
  unique (team_id, account_id, sort_rank) deferrable initially deferred;

create table private.team_account_order_versions (
  team_id uuid not null references public.teams(id) on delete cascade,
  scope_id uuid not null,
  version bigint not null default 0 check (version >= 0),
  primary key (team_id, scope_id)
);
insert into private.team_account_order_versions(team_id, scope_id)
select id, id from public.teams;
insert into private.team_account_order_versions(team_id, scope_id)
select team_id, id from public.team_accounts;
revoke all on private.team_account_order_versions from public, anon, authenticated;

create table private.team_account_order_requests (
  team_id uuid not null references public.teams(id) on delete cascade,
  request_id uuid not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  scope_id uuid not null,
  ordered_ids uuid[] not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (team_id, request_id)
);
revoke all on private.team_account_order_requests from public, anon, authenticated;

create function private.team_account_order_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  scope uuid;
begin
  if tg_table_name = 'team_accounts' then
    scope := new.team_id;
  else
    scope := new.account_id;
  end if;
  insert into private.team_account_order_versions(team_id, scope_id)
    values (new.team_id, scope) on conflict do nothing;
  update private.team_account_order_versions set version = version + 1
    where team_id = new.team_id and scope_id = scope;
  if tg_table_name = 'team_accounts' then
    select coalesce(max(sort_rank), 0) + 1 into new.sort_rank
      from public.team_accounts where team_id = new.team_id;
    -- A new social needs a version row for its future agents.
    insert into private.team_account_order_versions(team_id, scope_id)
      values (new.team_id, new.id) on conflict do nothing;
  else
    select coalesce(max(sort_rank), 0) + 1 into new.sort_rank
      from public.team_account_agents where team_id = new.team_id and account_id = new.account_id;
  end if;
  return new;
end $$;

create function private.team_account_order_move()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  scope uuid;
begin
  if new.account_id = old.account_id then return new; end if;
  for scope in select unnest(array[old.account_id, new.account_id]) order by 1 loop
    insert into private.team_account_order_versions(team_id, scope_id)
      values (new.team_id, scope) on conflict do nothing;
    update private.team_account_order_versions set version = version + 1
      where team_id = new.team_id and scope_id = scope;
  end loop;
  select coalesce(max(sort_rank), 0) + 1 into new.sort_rank
    from public.team_account_agents where team_id = new.team_id and account_id = new.account_id;
  return new;
end $$;

create function private.team_account_order_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
declare scope uuid;
begin
  if tg_table_name = 'team_accounts' then
    scope := old.team_id;
  else
    scope := old.account_id;
  end if;
  update private.team_account_order_versions set version = version + 1
    where team_id = old.team_id and scope_id = scope;
  if tg_table_name = 'team_accounts' then
    delete from private.team_account_order_versions
      where team_id = old.team_id and scope_id = old.id;
  end if;
  return old;
end $$;

create trigger team_accounts_order_insert before insert on public.team_accounts
  for each row execute function private.team_account_order_insert();
create trigger team_account_agents_order_insert before insert on public.team_account_agents
  for each row execute function private.team_account_order_insert();
create trigger team_account_agents_order_move before update of account_id on public.team_account_agents
  for each row execute function private.team_account_order_move();
create trigger team_accounts_order_delete after delete on public.team_accounts
  for each row execute function private.team_account_order_delete();
create trigger team_account_agents_order_delete after delete on public.team_account_agents
  for each row execute function private.team_account_order_delete();

-- Canonical snapshot for two-client conflict recovery. No content is exposed.
create function public.get_team_account_order(p_team uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'socials_version', coalesce((select version from private.team_account_order_versions
      where team_id = p_team and scope_id = p_team), 0),
    'social_ids', coalesce((select jsonb_agg(id order by sort_rank, id)
      from public.team_accounts where team_id = p_team), '[]'::jsonb),
    'agents', coalesce((select jsonb_object_agg(a.id::text, jsonb_build_object(
      'version', v.version,
      'ids', coalesce((select jsonb_agg(g.id order by g.sort_rank, g.id)
        from public.team_account_agents g where g.team_id = p_team and g.account_id = a.id), '[]'::jsonb)
    )) from public.team_accounts a join private.team_account_order_versions v
      on v.team_id = p_team and v.scope_id = a.id where a.team_id = p_team), '{}'::jsonb)
  ) into result;
  return result;
end $$;
revoke all on function public.get_team_account_order(uuid) from public, anon;
grant execute on function public.get_team_account_order(uuid) to authenticated;

create function public.reorder_team_accounts(
  p_team uuid, p_scope uuid, p_ids uuid[], p_expected_version bigint, p_request_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  current_version bigint;
  canonical uuid[];
  receipt private.team_account_order_requests%rowtype;
  result jsonb;
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_scope is null or p_request_id is null or p_ids is null or p_expected_version is null
    or array_position(p_ids, null) is not null or cardinality(p_ids) > 1000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_scope <> p_team and not exists
    (select 1 from public.team_accounts where team_id = p_team and id = p_scope) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_scope = p_team then
    insert into private.team_account_order_versions(team_id, scope_id)
      values (p_team, p_team) on conflict do nothing;
  end if;
  perform 1 from private.team_account_order_versions
    where team_id = p_team and scope_id = p_scope for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select * into receipt from private.team_account_order_requests
    where team_id = p_team and request_id = p_request_id;
  if found then
    if receipt.actor_id <> actor or receipt.scope_id <> p_scope or receipt.ordered_ids <> p_ids then
      raise exception 'REQUEST_REUSE_CONFLICT' using errcode = '22023';
    end if;
    return receipt.result;
  end if;
  select version into current_version from private.team_account_order_versions
    where team_id = p_team and scope_id = p_scope;
  if p_scope = p_team then
    select coalesce(array_agg(id order by sort_rank, id), '{}'::uuid[]) into canonical
      from public.team_accounts where team_id = p_team;
  else
    select coalesce(array_agg(id order by sort_rank, id), '{}'::uuid[]) into canonical
      from public.team_account_agents where team_id = p_team and account_id = p_scope;
  end if;
  if current_version <> p_expected_version then
    return jsonb_build_object('status', 'conflict', 'version', current_version, 'ids', canonical);
  end if;
  if cardinality(p_ids) <> cardinality(canonical)
    or (select count(distinct id) from unnest(p_ids) ids(id)) <> cardinality(canonical)
    or exists (select id from unnest(p_ids) ids(id) except select id from unnest(canonical) ids(id)) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_scope = p_team then
    update public.team_accounts a set sort_rank = input.ordinal
      from unnest(p_ids) with ordinality input(id, ordinal)
      where a.team_id = p_team and a.id = input.id;
  else
    update public.team_account_agents a set sort_rank = input.ordinal
      from unnest(p_ids) with ordinality input(id, ordinal)
      where a.team_id = p_team and a.account_id = p_scope and a.id = input.id;
  end if;
  update private.team_account_order_versions set version = version + 1
    where team_id = p_team and scope_id = p_scope returning version into current_version;
  result := jsonb_build_object('status', 'applied', 'version', current_version, 'ids', p_ids);
  insert into private.team_account_order_requests(team_id, request_id, actor_id, scope_id, ordered_ids, result)
    values (p_team, p_request_id, actor, p_scope, p_ids, result);
  return result;
end $$;
revoke all on function public.reorder_team_accounts(uuid, uuid, uuid[], bigint, uuid) from public, anon;
grant execute on function public.reorder_team_accounts(uuid, uuid, uuid[], bigint, uuid) to authenticated;

-- Keep the established result shape; its order becomes authoritative.
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
  from public.team_accounts account where account.team_id = p_team
  order by account.sort_rank, account.id;
end $$;
revoke all on function public.list_team_accounts(uuid) from public, anon;
grant execute on function public.list_team_accounts(uuid) to authenticated;

grant select (sort_rank) on public.team_accounts to authenticated;
grant select (sort_rank) on public.team_account_agents to authenticated;
alter publication supabase_realtime drop table public.team_accounts;
alter publication supabase_realtime add table public.team_accounts (
  id, team_id, name, sort_rank, created_at, updated_at
);
alter publication supabase_realtime drop table public.team_account_agents;
alter publication supabase_realtime add table public.team_account_agents (
  id, team_id, account_id, agent_id, sort_rank, created_at, updated_at
);

commit;
