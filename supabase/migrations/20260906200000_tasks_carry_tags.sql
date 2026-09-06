-- Feature 018: tags on tasks.
--
-- A space keeps a small dictionary of tags — created and deleted in its
-- settings — and a task carries any number of them. The board then narrows to
-- a set of tags, and can be ordered by tag instead of by date.
--
-- Deliberately not the agent tags of 017. Those are derived from an account
-- and an agent id and cannot be typed; these are free text a team invents for
-- itself, with a colour from a closed palette. Two link tables, no shared
-- vocabulary, so neither feature can rename the other's rows.
--
-- Shape mirrors team_accounts / team_task_agents exactly: a per-space parent
-- with a composite (id, team_id) unique, a link anchored on that composite so
-- a tag can never cross into another space, select-only RLS for viewers, and
-- every write behind a security-definer function gated on private.can.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.team_task_labels (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  name text not null,
  color text not null default 'purple',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_task_labels_name_length check (char_length(name) between 1 and 24),
  constraint team_task_labels_color check (
    color in ('purple', 'blue', 'teal', 'green', 'honey', 'orange', 'red', 'pink', 'slate')
  ),
  unique (id, team_id)
);

-- One name per space, however it is cased: two tags that read the same are one
-- tag to the people pressing them.
create unique index team_task_labels_name_idx
  on public.team_task_labels (team_id, lower(name));

create table public.team_task_label_links (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  task_id uuid not null,
  label_id uuid not null,
  attached_by uuid not null references auth.users(id) on delete restrict,
  attached_at timestamptz not null default now(),
  foreign key (task_id, team_id)
    references public.team_tasks(id, team_id) on delete cascade,
  foreign key (label_id, team_id)
    references public.team_task_labels(id, team_id) on delete cascade,
  unique (task_id, label_id)
);

-- The two reads: every tag of one task (the chips), and every task of one tag
-- (the filter and the counts).
create index team_task_label_links_task_idx on public.team_task_label_links (task_id, label_id);
create index team_task_label_links_label_idx on public.team_task_label_links (label_id, task_id);
create index team_task_label_links_team_idx on public.team_task_label_links (team_id);

alter table public.team_task_labels enable row level security;
alter table public.team_task_labels force row level security;
alter table public.team_task_label_links enable row level security;
alter table public.team_task_label_links force row level security;

create trigger team_task_labels_set_updated_at
before update on public.team_task_labels
for each row execute function private.team_set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------
create or replace function private.team_task_label_name(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), '');
$$;

-- The tags one task carries, as one JSON list, ordered the way the chips are
-- drawn. Derived at read time, so renaming or recolouring a tag follows
-- everywhere at once and nothing is snapshotted onto a task.
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
      join public.team_task_labels as label on label.id = link.label_id
      where link.task_id = p_task
    ),
    '[]'::jsonb
  );
$$;

-- The tag a task sorts under: its first one, lower-cased, or null when it
-- carries none. Same rule as the client's `teamTaskLabelKey`, so a page merged
-- on the client cannot reshuffle itself against the server's page.
create or replace function private.team_task_label_key(p_task uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select min(lower(label.name))
  from public.team_task_label_links as link
  join public.team_task_labels as label on label.id = link.label_id
  where link.task_id = p_task;
$$;

revoke all on function private.team_task_label_name(text)
from public, anon, authenticated, service_role;
revoke all on function private.team_task_labels(uuid)
from public, anon, authenticated, service_role;
revoke all on function private.team_task_label_key(uuid)
from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. The dictionary: read and write
-- ---------------------------------------------------------------------------
-- The whole dictionary in one round trip; a space holds tens of tags, so there
-- is nothing to page. The count is what the delete confirmation names.
create or replace function public.list_team_task_labels(p_team uuid)
returns table (
  id uuid,
  team_id uuid,
  name text,
  color text,
  task_count bigint,
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
  return query
  select label.id, label.team_id, label.name, label.color,
         (
           select count(*) from public.team_task_label_links as link
           where link.label_id = label.id
         ) as task_count,
         label.created_at, label.updated_at
  from public.team_task_labels as label
  where label.team_id = p_team
  order by lower(label.name), label.id;
end;
$$;

create or replace function public.create_team_task_label(
  p_team uuid,
  p_name text,
  p_color text default 'purple'
)
returns public.team_task_labels
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  clean_name text := private.team_task_label_name(p_name);
  clean_color text := coalesce(nullif(btrim(coalesce(p_color, '')), ''), 'purple');
  created public.team_task_labels%rowtype;
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if clean_name is null or char_length(clean_name) > 24
     or clean_color not in
        ('purple', 'blue', 'teal', 'green', 'honey', 'orange', 'red', 'pink', 'slate') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  -- A dictionary is a thing to scan; past sixty the tag is not what needs
  -- fixing, and an unbounded list would be pulled whole on every task read.
  -- The settings panel already refuses at the cap and says so, so this is the
  -- backstop for a race; `WRONG_STATE` is the registered code for it, and an
  -- unregistered one would reach the person as "something went wrong".
  if (select count(*) from public.team_task_labels as existing
      where existing.team_id = p_team) >= 60 then
    raise exception 'WRONG_STATE' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.team_task_labels as existing
    where existing.team_id = p_team and lower(existing.name) = lower(clean_name)
  ) then
    raise exception 'NAME_CONFLICT' using errcode = '23505';
  end if;

  insert into public.team_task_labels (team_id, created_by, name, color)
  values (p_team, actor, clean_name, clean_color)
  returning * into created;
  return created;
end;
$$;

-- Both fields every time: a tag is a name and a colour, and "which of them
-- changed" is not worth a patch grammar.
create or replace function public.update_team_task_label(
  p_team uuid,
  p_label uuid,
  p_name text,
  p_color text
)
returns public.team_task_labels
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  clean_name text := private.team_task_label_name(p_name);
  clean_color text := coalesce(nullif(btrim(coalesce(p_color, '')), ''), 'purple');
  updated public.team_task_labels%rowtype;
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if clean_name is null or char_length(clean_name) > 24
     or clean_color not in
        ('purple', 'blue', 'teal', 'green', 'honey', 'orange', 'red', 'pink', 'slate') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.team_task_labels as label
    where label.id = p_label and label.team_id = p_team
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.team_task_labels as existing
    where existing.team_id = p_team
      and existing.id <> p_label
      and lower(existing.name) = lower(clean_name)
  ) then
    raise exception 'NAME_CONFLICT' using errcode = '23505';
  end if;

  update public.team_task_labels as label
  set name = clean_name, color = clean_color
  where label.id = p_label and label.team_id = p_team
  returning * into updated;
  return updated;
end;
$$;

-- Deleting a tag takes it off every task it was on (cascade). Nothing else
-- references it, and no task is lost with it.
create or replace function public.delete_team_task_label(p_team uuid, p_label uuid)
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
    select 1 from public.team_task_labels as label
    where label.id = p_label and label.team_id = p_team
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  delete from public.team_task_labels as label
  where label.id = p_label and label.team_id = p_team;
  return query select true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Hanging a tag on a task
-- ---------------------------------------------------------------------------
-- Like tagging with an agent, this is a link and not a task edit: it neither
-- bumps the task's updated_at nor takes part in its optimistic-concurrency
-- check, so two people can tag and retitle at once.
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
    select 1 from public.team_task_labels as label
    where label.id = p_label and label.team_id = p_team
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Tagging twice is the same tag: idempotent, so a double press or a second
  -- person's press is not an error anyone has to read.
  insert into public.team_task_label_links (team_id, task_id, label_id, attached_by)
  values (p_team, p_task, p_label, actor)
  on conflict (task_id, label_id) do nothing;

  return private.team_task_labels(p_task);
end;
$$;

create or replace function public.detach_team_task_label(p_team uuid, p_task uuid, p_label uuid)
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

  delete from public.team_task_label_links as link
  where link.team_id = p_team and link.task_id = p_task and link.label_id = p_label;

  return private.team_task_labels(p_task);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. The board reads the tags, filters by them, and can order by them
-- ---------------------------------------------------------------------------
drop function if exists public.list_team_tasks(
  uuid, timestamptz, timestamptz, uuid, integer, text, uuid, uuid, date, date
);

-- `p_labels` keeps the tasks carrying any of the given tags — "any", not
-- "all", because the filter is opened to gather work, not to intersect it.
-- `p_sort` orders by tag instead of by date: first tag in natural order,
-- untagged last, and the date order inside each tag so a tag's own column
-- still reads newest-first.
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
  p_sort text default 'date'
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
     or (p_labels is not null and coalesce(array_length(p_labels, 1), 0) not between 1 and 20) then
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
        -- The same tuple the order below walks: tag first (untagged last),
        -- then the date order inside it.
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
  -- Under 'date' both tag expressions are null for every row, so they cannot
  -- reorder anything and the clause is the one part 4b shipped.
  order by
    case when sort = 'label' then (private.team_task_label_key(task.id) is null) end asc,
    case when sort = 'label' then private.team_task_label_key(task.id) end asc,
    private.team_task_sort_at(task.task_date, task.created_at) desc,
    task.id desc
  limit p_page_size;
end;
$$;

comment on function public.list_team_tasks(
  uuid, timestamptz, timestamptz, uuid, integer, text, uuid, uuid, date, date, uuid[], text
) is
  'Team tasks newest-first by the date they are for, or by tag when p_sort is '
  '''label''. p_labels keeps the tasks carrying any of the given tags (018).';

-- The detail read gains the tags too, so an editor opened from a link draws
-- its chips without a second round trip.
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
      'agents', private.team_task_agent_tags(task.id),
      'labels', private.team_task_labels(task.id)
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
        'position', page.position,
        'driveVersion', page.drive_version
      ) order by page.position, page.id)
      from (
        select attachment.id, attachment.task_id, attachment.material_id,
               attachment.position, material.name, material.category,
               material.lifecycle, render.render_state, material.drive_version
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

-- ---------------------------------------------------------------------------
-- 6. Policies, grants, realtime
-- ---------------------------------------------------------------------------
create policy team_task_labels_select_team
on public.team_task_labels for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

create policy team_task_label_links_select_team
on public.team_task_label_links for select to authenticated
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
      and (p.proname like '%team_task_label%' or p.proname = 'list_team_tasks')
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated, service_role',
      feature_function.signature
    );
  end loop;
end;
$$;

grant execute on function public.list_team_tasks(
  uuid, timestamptz, timestamptz, uuid, integer, text, uuid, uuid, date, date, uuid[], text
) to authenticated;
grant execute on function public.list_team_task_labels(uuid) to authenticated;
grant execute on function public.create_team_task_label(uuid, text, text) to authenticated;
grant execute on function public.update_team_task_label(uuid, uuid, text, text) to authenticated;
grant execute on function public.delete_team_task_label(uuid, uuid) to authenticated;
grant execute on function public.attach_team_task_label(uuid, uuid, uuid) to authenticated;
grant execute on function public.detach_team_task_label(uuid, uuid, uuid) to authenticated;

-- `created_by` stays server-side, as on every other table of the space.
grant select (id, team_id, name, color, created_at, updated_at)
on table public.team_task_labels to authenticated;
grant select (id, team_id, task_id, label_id, attached_at)
on table public.team_task_label_links to authenticated;

alter publication supabase_realtime add table public.team_task_labels (
  id, team_id, name, color, created_at, updated_at
);
alter publication supabase_realtime add table public.team_task_label_links (
  id, team_id, task_id, label_id, attached_at
);

comment on table public.team_task_labels is
  'Feature 018: the tags a space keeps for its tasks; created in space settings.';
comment on table public.team_task_label_links is
  'Feature 018: the tags a task carries. Names and colours are read live from team_task_labels.';
