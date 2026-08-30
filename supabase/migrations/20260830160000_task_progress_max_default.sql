-- A per-account default for a new task's "Maximum" (progress ceiling). The
-- editor lets someone save the current maximum as their default, and new tasks
-- they create start from it. Mirrors the transcript_delete_pref pattern.
alter table public.profiles
  add column if not exists task_progress_max_default integer;

alter table public.profiles
  drop constraint if exists profiles_task_progress_max_default_check;
alter table public.profiles
  add constraint profiles_task_progress_max_default_check
  check (task_progress_max_default is null
    or (task_progress_max_default between 1 and 10000));

create or replace function public.get_task_progress_max_default()
returns integer
language sql
stable
security definer
set search_path to ''
as $function$
  select coalesce(
    (select task_progress_max_default from public.profiles where id = auth.uid()),
    100
  );
$function$;

create or replace function public.set_task_progress_max_default(p_value integer)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if auth.uid() is null then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_value is null or p_value < 1 or p_value > 10000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update public.profiles set task_progress_max_default = p_value where id = auth.uid();
end;
$function$;

-- A new task starts from the creator's saved default (falling back to 100).
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
    (select task_progress_max_default from public.profiles where id = actor),
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
