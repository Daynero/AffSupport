-- 011 (T011): explicit storage selections.
--
-- A space's storage is one or more folders the owner picked in the provider's
-- own chooser. The root is always the first selection; under research R1
-- outcome A it is the only one. The table exists in both outcomes so the
-- interface, the sync worker and the previews are shaped once.
--
-- Same template as every team table: RLS on, revoke all, column-scoped grant,
-- definer functions with an empty search_path, an audit row per mutation.
-- Forward-only. Reverse steps are in ROLLBACK.md.

create table public.team_drive_selections (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  connection_id uuid not null references public.team_drive_connections(id) on delete cascade,
  drive_folder_id text not null,
  resource_key text,
  name text not null,
  is_root boolean not null default false,
  state text not null default 'active',
  selected_by uuid references auth.users(id) on delete set null,
  selected_at timestamptz not null default now(),
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_drive_selections_folder_length check (
    char_length(drive_folder_id) between 1 and 1024
  ),
  constraint team_drive_selections_name_length check (char_length(name) between 1 and 255),
  constraint team_drive_selections_state_check check (state in ('active', 'missing', 'removed')),
  constraint team_drive_selections_removed_shape check (
    (state = 'removed') = (removed_at is not null)
  ),
  constraint team_drive_selections_root_not_removed check (not (is_root and state = 'removed')),
  constraint team_drive_selections_folder_unique unique (connection_id, drive_folder_id)
);

create unique index team_drive_selections_one_root
  on public.team_drive_selections (connection_id)
  where is_root;
create index team_drive_selections_team_idx
  on public.team_drive_selections (team_id, connection_id)
  where state <> 'removed';

create trigger team_drive_selections_set_updated_at
before update on public.team_drive_selections
for each row execute function private.team_set_updated_at();

alter table public.team_drive_selections enable row level security;
alter table public.team_drive_selections force row level security;
revoke all on table public.team_drive_selections from public, anon, authenticated;
grant select (id, team_id, connection_id, drive_folder_id, name, is_root, state, selected_at, removed_at)
  on public.team_drive_selections to authenticated;
create policy team_drive_selections_select_team
on public.team_drive_selections for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

-- ---------------------------------------------------------------------------
-- The root selection follows the connection.
-- ---------------------------------------------------------------------------
-- Every connect and reconnect path already writes team_drive_connections; a
-- trigger keeps the root selection in step rather than editing each of them.
create or replace function private.team_sync_root_selection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state = 'detached' then
    return new;
  end if;
  update public.team_drive_selections
  set is_root = false
  where connection_id = new.id
    and is_root
    and drive_folder_id <> new.root_folder_id;
  insert into public.team_drive_selections (
    team_id, connection_id, drive_folder_id, resource_key, name, is_root, state
  ) values (
    new.team_id, new.id, new.root_folder_id, new.root_resource_key, new.root_folder_name, true,
    case when new.state = 'root_missing' then 'missing' else 'active' end
  )
  on conflict (connection_id, drive_folder_id) do update
  set is_root = true,
      name = excluded.name,
      resource_key = excluded.resource_key,
      state = excluded.state,
      removed_at = null;
  return new;
end;
$$;

create trigger team_drive_connections_sync_root_selection
after insert or update of root_folder_id, root_folder_name, root_resource_key, state
on public.team_drive_connections
for each row execute function private.team_sync_root_selection();

-- Backfill one root selection per live connection.
insert into public.team_drive_selections (
  team_id, connection_id, drive_folder_id, resource_key, name, is_root, state
)
select connection.team_id, connection.id, connection.root_folder_id,
       connection.root_resource_key, connection.root_folder_name, true, 'active'
from public.team_drive_connections as connection
where connection.state <> 'detached'
on conflict (connection_id, drive_folder_id) do nothing;

-- ---------------------------------------------------------------------------
-- Member read
-- ---------------------------------------------------------------------------
create or replace function public.list_team_drive_selections(p_team uuid)
returns table (id uuid, drive_folder_id text, name text, is_root boolean, state text)
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
  select selection.id, selection.drive_folder_id, selection.name, selection.is_root, selection.state
  from public.team_drive_selections as selection
  join public.team_drive_connections as connection on connection.id = selection.connection_id
  where selection.team_id = p_team
    and connection.state <> 'detached'
    and selection.state <> 'removed'
  order by selection.is_root desc, lower(selection.name), selection.id;
end;
$$;

revoke all on function public.list_team_drive_selections(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.list_team_drive_selections(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Owner / manager write: add a picked folder
-- ---------------------------------------------------------------------------
-- The provider-side proof that the folder lives in the connected drive happens
-- in the Edge Function before this is called; here the guards are membership,
-- a live connection and no duplicate. The new folder is walked by its own
-- initial-scan job seeded with just that folder.
create or replace function public.add_team_drive_selection(
  p_team uuid,
  p_drive_folder_id text,
  p_resource_key text default null,
  p_name text default null
)
returns table (id uuid, drive_folder_id text, name text, is_root boolean, state text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  actor uuid := auth.uid();
  active_connection uuid;
  change_token text;
  created uuid;
  folder_name text;
begin
  if actor is null or not private.can(p_team, 'manage_members', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_drive_folder_id is null or char_length(p_drive_folder_id) not between 1 and 1024 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  folder_name := left(coalesce(nullif(btrim(p_name), ''), 'Folder'), 255);

  select connection.id, connection.change_page_token
    into active_connection, change_token
  from public.team_drive_connections as connection
  where connection.team_id = p_team and connection.state = 'connected'
  limit 1;
  if active_connection is null then
    raise exception 'WRONG_STATE' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.team_drive_selections as selection
    where selection.connection_id = active_connection
      and selection.drive_folder_id = p_drive_folder_id
      and selection.state <> 'removed'
  ) then
    raise exception 'SELECTION_UNREACHABLE' using errcode = 'P0001';
  end if;

  insert into public.team_drive_selections (
    team_id, connection_id, drive_folder_id, resource_key, name, is_root, state, selected_by
  ) values (
    p_team, active_connection, p_drive_folder_id, nullif(p_resource_key, ''), folder_name,
    false, 'active', actor
  )
  on conflict (connection_id, drive_folder_id) do update
  set state = 'active',
      removed_at = null,
      name = excluded.name,
      resource_key = excluded.resource_key,
      selected_by = excluded.selected_by,
      selected_at = clock_timestamp()
  returning team_drive_selections.id into created;

  perform private.enqueue_catalog_sync(
    active_connection,
    'initial_scan',
    jsonb_build_object(
      'pageToken', null,
      'changePageToken', change_token,
      'discoveredFolders', '[]'::jsonb
    ),
    jsonb_build_array(p_drive_folder_id)
  );
  perform private.record_team_audit(
    p_team, actor, 'storage.selection_added',
    jsonb_build_object('connection_id', active_connection, 'state', 'active'),
    'succeeded', null
  );

  return query
  select selection.id, selection.drive_folder_id, selection.name, selection.is_root, selection.state
  from public.team_drive_selections as selection
  where selection.id = created;
end;
$$;

revoke all on function public.add_team_drive_selection(uuid, text, text, text)
from public, anon, authenticated, service_role;
grant execute on function public.add_team_drive_selection(uuid, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Worker read: which folders a connection's walk must treat as ancestors
-- ---------------------------------------------------------------------------
create or replace function public.service_list_connection_selections(p_connection uuid)
returns table (id uuid, drive_folder_id text, resource_key text, is_root boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select selection.id, selection.drive_folder_id, selection.resource_key, selection.is_root
  from public.team_drive_selections as selection
  where selection.connection_id = p_connection and selection.state = 'active'
  order by selection.is_root desc, selection.selected_at, selection.id;
$$;

revoke all on function public.service_list_connection_selections(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.service_list_connection_selections(uuid) to service_role;
