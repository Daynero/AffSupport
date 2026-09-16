-- A new task's "Maximum" is the space's, not the person's.
--
-- 20260830160000 kept the default on `profiles`: saving it from a task fixed it for the person who
-- pressed the button, and a teammate creating the next task still got 100. The owner's model is the
-- other one — the space settles how its tasks are measured, and every task anyone makes there starts
-- from that figure. The value moves onto `teams`; changing it is a manage_metadata act, as the
-- re-stitch and catalog defaults are. The personal functions stay for clients that still call them,
-- but nothing reads the profile column any more.
-- Forward-only; ROLLBACK.md re-applies 20260830160000's create_team_task.

alter table public.teams
  add column if not exists task_progress_max_default integer;

alter table public.teams
  drop constraint if exists teams_task_progress_max_default_check;
alter table public.teams
  add constraint teams_task_progress_max_default_check
  check (task_progress_max_default is null
    or (task_progress_max_default between 1 and 10000));

-- What the owner had saved for themselves becomes the space's starting point, so nobody's existing
-- choice silently turns back into 100.
update public.teams as team
set task_progress_max_default = profile.task_progress_max_default
from public.profiles as profile
where profile.id = team.owner_id
  and profile.task_progress_max_default is not null
  and team.task_progress_max_default is null;

create or replace function public.get_team_task_progress_max_default(p_team uuid)
returns integer
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  value integer;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select coalesce(team.task_progress_max_default, 100) into value
  from public.teams as team
  where team.id = p_team;
  if value is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  return value;
end;
$function$;

create or replace function public.set_team_task_progress_max_default(p_team uuid, p_value integer)
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if auth.uid() is null or not private.can(p_team, 'manage_metadata', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_value is null or p_value < 1 or p_value > 10000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update public.teams set task_progress_max_default = p_value where id = p_team;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  return p_value;
end;
$function$;

-- A new task starts from the space's default (falling back to 100), whoever creates it.
create or replace function public.create_team_task(p_team uuid, p_title text, p_note text DEFAULT NULL::text, p_assignee uuid DEFAULT NULL::uuid, p_initial_material uuid DEFAULT NULL::uuid)
 RETURNS team_tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := auth.uid();
  created public.team_tasks%rowtype;
  default_max integer;
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_title is null or char_length(btrim(p_title)) not between 1 and 160
     or (p_note is not null and char_length(p_note) > 2000) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_assignee is not null and not private.team_task_assignee_is_active(p_team, p_assignee) then
    raise exception 'INVALID_ASSIGNEE' using errcode = '22023';
  end if;
  if p_initial_material is not null and not exists (
    select 1 from public.team_materials as material
    where material.id = p_initial_material
      and material.team_id = p_team
      and material.lifecycle = 'active'
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  select coalesce(
    (select team.task_progress_max_default from public.teams as team where team.id = p_team),
    100
  ) into default_max;

  insert into public.team_tasks (
    team_id, created_by, title, note, assignee_id, assignee_label_snapshot, progress_max
  ) values (
    p_team, actor, p_title, p_note, p_assignee,
    private.team_task_assignee_label(p_assignee), default_max
  ) returning * into created;

  if p_initial_material is not null then
    insert into public.team_task_attachments (
      team_id, task_id, material_id, position, attached_by
    ) values (p_team, created.id, p_initial_material, 0, actor);
  end if;

  perform private.append_library_contribution(
    p_team, actor, 'human_activity', 'task_created', 'success', null
  );
  return created;
end;
$function$;

revoke all on function public.get_team_task_progress_max_default(uuid) from public, anon;
grant execute on function public.get_team_task_progress_max_default(uuid) to authenticated;

revoke all on function public.set_team_task_progress_max_default(uuid, integer) from public, anon;
grant execute on function public.set_team_task_progress_max_default(uuid, integer) to authenticated;
