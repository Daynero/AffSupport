-- 076: launches in tasks — a task lists the launches that are its work, and a
-- launch says which task it belongs to.
--
-- A link is a pair (task, launch) inside one space. Writing goes only through the
-- functions below (security definer); members read their space's links. Deleting a
-- task or a launch takes its links with it. The table's name starts with team_, so it
-- carries the attachment-cleanup fence like every other table in the inventory
-- (private.task_cleanup_reference_tables(); rule 20261218210000).
begin;

create table public.team_task_launches (
  team_id uuid not null references public.teams(id) on delete cascade,
  task_id uuid not null,
  launch_id uuid not null,
  attached_by uuid references auth.users(id) on delete set null,
  attached_at timestamptz not null default now(),
  primary key (task_id, launch_id),
  foreign key (task_id, team_id) references public.team_tasks(id, team_id) on delete cascade,
  foreign key (launch_id, team_id) references public.team_launches(id, team_id) on delete cascade
);

create index team_task_launches_launch_idx on public.team_task_launches (team_id, launch_id);

alter table public.team_task_launches enable row level security;
alter table public.team_task_launches force row level security;

create policy team_task_launches_select_team
on public.team_task_launches for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

revoke all on public.team_task_launches from public, anon, authenticated;
grant select on public.team_task_launches to authenticated;

create or replace trigger task_cleanup_reference_fence
  before insert or update on public.team_task_launches
  for each row execute function private.guard_task_cleanup_reference();

-- The launches a caller may link: this space's, not deleted, distinct, 1..100.
create or replace function private.task_launch_ids(p_team uuid, p_launches uuid[])
returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
declare
  wanted uuid[];
begin
  if p_launches is null or cardinality(p_launches) not between 1 and 100
     or array_position(p_launches, null) is not null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select array_agg(distinct id) into wanted from unnest(p_launches) as input(id);
  if (select count(*) from public.team_launches
      where team_id = p_team and id = any(wanted) and archived_at is null)
     <> cardinality(wanted) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  return wanted;
end $$;
revoke all on function private.task_launch_ids(uuid, uuid[]) from public, anon, authenticated;

create or replace function public.attach_team_task_launches(
  p_team uuid, p_task uuid, p_launches uuid[]
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  wanted uuid[];
  added uuid[];
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  perform 1 from public.team_tasks where team_id = p_team and id = p_task for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  wanted := private.task_launch_ids(p_team, p_launches);
  with inserted as (
    insert into public.team_task_launches (team_id, task_id, launch_id, attached_by)
    select p_team, p_task, id, actor from unnest(wanted) as input(id)
    on conflict (task_id, launch_id) do nothing
    returning launch_id
  )
  select coalesce(array_agg(launch_id), '{}') into added from inserted;
  update public.team_tasks set updated_at = now() where id = p_task and team_id = p_team;
  return jsonb_build_object(
    'attached', to_jsonb(added),
    'alreadyAttached', to_jsonb(array(select id from unnest(wanted) as w(id) where id <> all(added)))
  );
end $$;
revoke all on function public.attach_team_task_launches(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.attach_team_task_launches(uuid, uuid, uuid[]) to authenticated;

-- A new task made of these launches, in one transaction: no empty task is left
-- behind when a launch turns out to be gone.
create or replace function public.create_team_task_with_launches(
  p_team uuid, p_title text, p_launches uuid[]
) returns public.team_tasks
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  wanted uuid[];
  created public.team_tasks%rowtype;
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  wanted := private.task_launch_ids(p_team, p_launches);
  select * into created from public.create_team_task(p_team, p_title, null, null, null);
  insert into public.team_task_launches (team_id, task_id, launch_id, attached_by)
  select p_team, created.id, id, actor from unnest(wanted) as input(id);
  return created;
end $$;
revoke all on function public.create_team_task_with_launches(uuid, text, uuid[]) from public, anon;
grant execute on function public.create_team_task_with_launches(uuid, text, uuid[]) to authenticated;

create or replace function public.detach_team_task_launch(
  p_team uuid, p_task uuid, p_launch uuid
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  delete from public.team_task_launches
  where team_id = p_team and task_id = p_task and launch_id = p_launch;
  if found then
    update public.team_tasks set updated_at = now() where id = p_task and team_id = p_team;
  end if;
end $$;
revoke all on function public.detach_team_task_launch(uuid, uuid, uuid) from public, anon;
grant execute on function public.detach_team_task_launch(uuid, uuid, uuid) to authenticated;

-- The task's launches, oldest link first; deleted launches are not listed.
create or replace function public.list_team_task_launch_ids(p_team uuid, p_task uuid)
returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  result uuid[];
begin
  if actor is null or not private.can(p_team, 'view', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select coalesce(array_agg(link.launch_id order by link.attached_at, link.launch_id), '{}')
  into result
  from public.team_task_launches link
  join public.team_launches launch on launch.id = link.launch_id and launch.team_id = link.team_id
  where link.team_id = p_team and link.task_id = p_task and launch.archived_at is null;
  return result;
end $$;
revoke all on function public.list_team_task_launch_ids(uuid, uuid) from public, anon;
grant execute on function public.list_team_task_launch_ids(uuid, uuid) to authenticated;

-- The tasks these launches are in, for the chips on launch cards.
create or replace function public.list_team_launch_tasks(p_team uuid, p_launches uuid[])
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  result jsonb;
begin
  if actor is null or not private.can(p_team, 'view', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_launches is null or cardinality(p_launches) > 100 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'launchId', link.launch_id,
    'taskId', task.id,
    'title', task.title,
    'status', task.status
  ) order by link.attached_at, task.id), '[]')
  into result
  from public.team_task_launches link
  join public.team_tasks task on task.id = link.task_id and task.team_id = link.team_id
  where link.team_id = p_team and link.launch_id = any(p_launches);
  return result;
end $$;
revoke all on function public.list_team_launch_tasks(uuid, uuid[]) from public, anon;
grant execute on function public.list_team_launch_tasks(uuid, uuid[]) to authenticated;

commit;
