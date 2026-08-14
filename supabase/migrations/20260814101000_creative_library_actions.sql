-- Feature 005 caller/service actions. Every function is SECURITY DEFINER with an empty path;
-- grants are applied explicitly in the following security migration.

create or replace function private.normalize_team_task()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  explicit_progress boolean := false;
begin
  new.title := btrim(new.title);
  new.note := nullif(btrim(new.note), '');

  if tg_op = 'UPDATE' then
    explicit_progress := new.progress_value is distinct from old.progress_value;
    if old.progress_manually_set and not new.progress_manually_set then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    if explicit_progress then
      new.progress_manually_set := true;
    end if;
  end if;

  if new.progress_value > new.progress_max then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  if new.status = 'done' and not new.progress_manually_set and not explicit_progress then
    new.progress_value := new.progress_max;
  end if;
  if new.status = 'done' then
    new.completed_at := coalesce(new.completed_at, clock_timestamp());
  else
    new.completed_at := null;
  end if;
  return new;
end;
$$;

revoke all on function private.normalize_team_task() from public, anon, authenticated, service_role;

create trigger team_tasks_normalize
before insert or update on public.team_tasks
for each row execute function private.normalize_team_task();

create trigger team_upload_batches_set_updated_at
before update on public.team_upload_batches
for each row execute function private.team_set_updated_at();
create trigger team_upload_batch_items_set_updated_at
before update on public.team_upload_batch_items
for each row execute function private.team_set_updated_at();
create trigger team_library_folders_set_updated_at
before update on private.team_library_folders
for each row execute function private.team_set_updated_at();
create trigger team_material_enrichments_set_updated_at
before update on private.team_material_enrichments
for each row execute function private.team_set_updated_at();
create trigger team_library_requirements_set_updated_at
before update on public.team_library_requirements
for each row execute function private.team_set_updated_at();
create trigger team_library_attempts_set_updated_at
before update on private.team_library_attempts
for each row execute function private.team_set_updated_at();
create trigger team_material_group_intents_set_updated_at
before update on private.team_material_group_intents
for each row execute function private.team_set_updated_at();
create trigger team_tasks_set_updated_at
before update on public.team_tasks
for each row execute function private.team_set_updated_at();
create trigger team_share_preferences_set_updated_at
before update on public.team_share_preferences
for each row execute function private.team_set_updated_at();

create or replace function private.team_task_assignee_label(p_assignee uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select left(coalesce(nullif(profile.display_name, ''), nullif(profile.email, '')), 320)
  from public.profiles as profile
  where profile.id = p_assignee
    and profile.account_status = 'active';
$$;

revoke all on function private.team_task_assignee_label(uuid)
from public, anon, authenticated, service_role;

create or replace function private.team_task_assignee_is_active(p_team uuid, p_assignee uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_assignee is null or exists (
    select 1
    from public.team_members as member
    join public.profiles as profile on profile.id = member.user_id
    where member.team_id = p_team
      and member.user_id = p_assignee
      and member.status = 'active'
      and profile.account_status = 'active'
  );
$$;

revoke all on function private.team_task_assignee_is_active(uuid, uuid)
from public, anon, authenticated, service_role;

create or replace function private.clear_removed_team_task_assignee()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_team uuid;
  affected_user uuid;
begin
  affected_team := coalesce(new.team_id, old.team_id);
  affected_user := coalesce(new.user_id, old.user_id);
  if tg_op = 'DELETE' or new.status <> 'active' then
    update public.team_tasks as task
       set assignee_id = null
     where task.team_id = affected_team
       and task.assignee_id = affected_user;
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function private.clear_removed_team_task_assignee()
from public, anon, authenticated, service_role;

create trigger team_members_clear_task_assignee
after update of status or delete on public.team_members
for each row execute function private.clear_removed_team_task_assignee();

create or replace function private.append_library_contribution(
  p_team uuid,
  p_actor uuid,
  p_category text,
  p_action text,
  p_outcome text,
  p_agent_instance uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  contribution_id uuid;
begin
  if not private.can(p_team, 'view', p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  insert into public.team_contribution_records (
    team_id, actor_id, category, agent_instance_id, action_kind, outcome
  ) values (
    p_team, p_actor, p_category, p_agent_instance, p_action, p_outcome
  ) returning id into contribution_id;
  return contribution_id;
end;
$$;

revoke all on function private.append_library_contribution(uuid, uuid, text, text, text, uuid)
from public, anon, authenticated, service_role;

create or replace function public.service_append_library_contribution(
  p_team uuid,
  p_actor uuid,
  p_category text,
  p_action text,
  p_outcome text,
  p_agent_instance uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- PostgREST exposes the public schema only. ACLs below keep this adapter
  -- service-only while the allowlist and membership checks stay centralized.
  return private.append_library_contribution(
    p_team, p_actor, p_category, p_action, p_outcome, p_agent_instance
  );
end;
$$;

create or replace function public.create_team_task(
  p_team uuid,
  p_title text,
  p_note text default null,
  p_assignee uuid default null,
  p_initial_material uuid default null
)
returns public.team_tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  created public.team_tasks%rowtype;
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

  insert into public.team_tasks (
    team_id, created_by, title, note, assignee_id, assignee_label_snapshot
  ) values (
    p_team, actor, p_title, p_note, p_assignee,
    private.team_task_assignee_label(p_assignee)
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
$$;

create or replace function public.list_team_tasks(
  p_team uuid,
  p_created_from timestamptz default null,
  p_created_to timestamptz default null,
  p_cursor uuid default null,
  p_page_size integer default 50
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
  cursor_created_at timestamptz;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if (p_created_from is null) <> (p_created_to is null)
     or (p_created_from is not null and p_created_from >= p_created_to)
     or p_page_size not between 1 and 100 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_cursor is not null then
    select task.created_at into cursor_created_at
    from public.team_tasks as task
    where task.id = p_cursor and task.team_id = p_team;
    if cursor_created_at is null then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
  end if;
  return query
  select task.id, task.team_id, task.created_by, task.title, task.note,
         task.assignee_id, task.assignee_label_snapshot, task.status,
         task.progress_max, task.progress_value, task.progress_manually_set,
         count(attachment.id) as attachment_count,
         task.created_at, task.updated_at, task.completed_at
  from public.team_tasks as task
  left join public.team_task_attachments as attachment on attachment.task_id = task.id
  where task.team_id = p_team
    and (p_created_from is null or (task.created_at >= p_created_from and task.created_at < p_created_to))
    and (p_cursor is null or (task.created_at, task.id) < (cursor_created_at, p_cursor))
  group by task.id
  order by task.created_at desc, task.id desc
  limit p_page_size;
end;
$$;

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
      )
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
        'position', page.position
      ) order by page.position, page.id)
      from (
        select attachment.id, attachment.task_id, attachment.material_id,
               attachment.position, material.name, material.category,
               material.lifecycle, render.render_state
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

create or replace function public.update_team_task(
  p_team uuid,
  p_task uuid,
  p_patch jsonb
)
returns public.team_tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  current_task public.team_tasks%rowtype;
  updated_task public.team_tasks%rowtype;
  next_title text;
  next_note text;
  next_assignee uuid;
  next_status text;
  next_max integer;
  next_value integer;
  next_manual boolean;
  explicit_value boolean;
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb
     or exists (
       select 1 from jsonb_object_keys(p_patch) as key
       where key not in (
         'title','note','assigneeId','status','progressMax','progressValue','expectedUpdatedAt'
       )
     ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  select * into current_task
  from public.team_tasks as task
  where task.id = p_task and task.team_id = p_team
  for update;
  if current_task.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p_patch ? 'expectedUpdatedAt'
     and (p_patch ->> 'expectedUpdatedAt')::timestamptz is distinct from current_task.updated_at then
    raise exception 'SOURCE_CHANGED' using errcode = '40001';
  end if;

  next_title := current_task.title;
  if p_patch ? 'title' then
    if jsonb_typeof(p_patch -> 'title') <> 'string'
       or char_length(btrim(p_patch ->> 'title')) not between 1 and 160 then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    next_title := btrim(p_patch ->> 'title');
  end if;

  next_note := current_task.note;
  if p_patch ? 'note' then
    if jsonb_typeof(p_patch -> 'note') = 'null' then
      next_note := null;
    elsif jsonb_typeof(p_patch -> 'note') = 'string'
          and char_length(p_patch ->> 'note') <= 2000 then
      next_note := nullif(btrim(p_patch ->> 'note'), '');
    else
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
  end if;

  next_assignee := current_task.assignee_id;
  if p_patch ? 'assigneeId' then
    if jsonb_typeof(p_patch -> 'assigneeId') = 'null' then
      next_assignee := null;
    elsif jsonb_typeof(p_patch -> 'assigneeId') = 'string'
          and (p_patch ->> 'assigneeId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      next_assignee := (p_patch ->> 'assigneeId')::uuid;
    else
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
  end if;
  if next_assignee is not null and not private.team_task_assignee_is_active(p_team, next_assignee) then
    raise exception 'INVALID_ASSIGNEE' using errcode = '22023';
  end if;

  next_status := current_task.status;
  if p_patch ? 'status' then
    next_status := p_patch ->> 'status';
    if jsonb_typeof(p_patch -> 'status') <> 'string'
       or next_status not in ('todo','in_progress','done') then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
  end if;

  next_max := current_task.progress_max;
  if p_patch ? 'progressMax' then
    if jsonb_typeof(p_patch -> 'progressMax') <> 'number'
       or (p_patch ->> 'progressMax') !~ '^[0-9]+$' then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    next_max := (p_patch ->> 'progressMax')::integer;
  end if;

  explicit_value := p_patch ? 'progressValue';
  next_value := current_task.progress_value;
  next_manual := current_task.progress_manually_set;
  if explicit_value then
    if jsonb_typeof(p_patch -> 'progressValue') <> 'number'
       or (p_patch ->> 'progressValue') !~ '^[0-9]+$' then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    next_value := (p_patch ->> 'progressValue')::integer;
    next_manual := true;
  elsif next_status = 'done' and not next_manual then
    next_value := next_max;
  end if;
  if next_max not between 1 and 10000 or next_value not between 0 and next_max then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  update public.team_tasks as task
     set title = next_title,
         note = next_note,
         assignee_id = next_assignee,
         assignee_label_snapshot = case
           when next_assignee is null then task.assignee_label_snapshot
           else private.team_task_assignee_label(next_assignee) end,
         status = next_status,
         progress_max = next_max,
         progress_value = next_value,
         progress_manually_set = next_manual,
         completed_at = case
           when next_status = 'done' then coalesce(task.completed_at, clock_timestamp())
           else null end
   where task.id = p_task and task.team_id = p_team
   returning * into updated_task;

  if current_task.status <> 'done' and updated_task.status = 'done' then
    perform private.append_library_contribution(
      p_team, actor, 'human_activity', 'task_completed', 'success', null
    );
  end if;
  return updated_task;
exception
  when invalid_text_representation or datetime_field_overflow then
    raise exception 'INVALID_INPUT' using errcode = '22023';
end;
$$;

create or replace function public.attach_team_task_materials(
  p_team uuid,
  p_task uuid,
  p_materials uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  candidate_material_id uuid;
  next_position bigint;
  attached jsonb := '[]'::jsonb;
  already_attached jsonb := '[]'::jsonb;
  rejected jsonb := '[]'::jsonb;
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_materials is null or cardinality(p_materials) not between 1 and 100 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform 1 from public.team_tasks as task
  where task.id = p_task and task.team_id = p_team for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select coalesce(max(attachment.position) + 1, 0) into next_position
  from public.team_task_attachments as attachment where attachment.task_id = p_task;

  for candidate_material_id in
    select entry
    from unnest(p_materials) with ordinality as input(entry, ordinal)
    group by entry
    order by min(ordinal)
  loop
    if candidate_material_id is null or not exists (
      select 1 from public.team_materials as material
      where material.id = candidate_material_id and material.team_id = p_team
        and material.lifecycle = 'active'
    ) then
      rejected := rejected || jsonb_build_array(jsonb_build_object(
        'materialId', candidate_material_id, 'code', 'NOT_FOUND'
      ));
    elsif exists (
      select 1 from public.team_task_attachments as attachment
      where attachment.task_id = p_task and attachment.material_id = candidate_material_id
    ) then
      already_attached := already_attached || jsonb_build_array(to_jsonb(candidate_material_id));
    else
      insert into public.team_task_attachments (
        team_id, task_id, material_id, position, attached_by
      ) values (p_team, p_task, candidate_material_id, next_position, actor);
      attached := attached || jsonb_build_array(to_jsonb(candidate_material_id));
      next_position := next_position + 1;
    end if;
  end loop;
  return jsonb_build_object(
    'attached', attached,
    'alreadyAttached', already_attached,
    'rejected', rejected
  );
end;
$$;

create or replace function public.detach_team_task_material(
  p_team uuid,
  p_task uuid,
  p_material uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'edit', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  delete from public.team_task_attachments as attachment
  where attachment.team_id = p_team
    and attachment.task_id = p_task
    and attachment.material_id = p_material;
  return found;
end;
$$;

create or replace function public.scan_library_requirements(
  p_team uuid,
  p_interface_language text,
  p_source uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  inserted_transcriptions integer := 0;
  inserted_translations integer := 0;
  inserted_landings integer := 0;
  missing_transcriptions integer := 0;
  missing_translations integer := 0;
  missing_landings integer := 0;
  ready_count integer := 0;
begin
  if actor is null or not private.can(p_team, 'process', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if not exists (select 1 from public.language_options where code = p_interface_language) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  update public.team_library_requirements as requirement
     set state = 'stale'
   where requirement.team_id = p_team
     and requirement.state <> 'stale'
     and exists (
       select 1 from public.team_materials as material
       where material.id = requirement.source_material_id
         and material.team_id = requirement.team_id
         and coalesce(nullif(material.drive_version,''), nullif(material.checksum,''))
             is distinct from requirement.source_version
     );

  update public.team_library_results as result
     set state = 'stale', stale_at = clock_timestamp()
   where result.team_id = p_team
     and result.state = 'current'
     and exists (
       select 1 from public.team_library_requirements as requirement
       where requirement.id = result.requirement_id and requirement.state = 'stale'
     );

  with candidates as (
    select material.id,
           coalesce(nullif(material.drive_version,''), nullif(material.checksum,'')) as source_version
    from public.team_materials as material
    where material.team_id = p_team
      and (p_source is null or material.id = p_source)
      and material.library_stage = 'library'
      and material.lifecycle = 'active'
      and material.category = 'video'
      and coalesce(nullif(material.drive_version,''), nullif(material.checksum,'')) is not null
  ), inserted as (
    insert into public.team_library_requirements (
      team_id, source_material_id, source_version, kind, variant
    )
    select p_team, candidate.id, candidate.source_version, 'transcription', 'original'
    from candidates as candidate
    on conflict (team_id, source_material_id, source_version, kind, variant) do nothing
    returning 1
  ) select count(*)::integer into inserted_transcriptions from inserted;

  with candidates as (
    select material.id,
           coalesce(nullif(material.drive_version,''), nullif(material.checksum,'')) as source_version
    from public.team_materials as material
    where material.team_id = p_team
      and (p_source is null or material.id = p_source)
      and material.library_stage = 'library'
      and material.lifecycle = 'active'
      and material.category = 'video'
      and coalesce(nullif(material.drive_version,''), nullif(material.checksum,'')) is not null
      and coalesce(material.structural_language, material.language, 'unknown') <> p_interface_language
  ), inserted as (
    insert into public.team_library_requirements (
      team_id, source_material_id, source_version, kind, variant
    )
    select p_team, candidate.id, candidate.source_version, 'translation', p_interface_language
    from candidates as candidate
    on conflict (team_id, source_material_id, source_version, kind, variant) do nothing
    returning 1
  ) select count(*)::integer into inserted_translations from inserted;

  with candidates as (
    select material.id,
           coalesce(nullif(material.drive_version,''), nullif(material.checksum,'')) as source_version
    from public.team_materials as material
    where material.team_id = p_team
      and (p_source is null or material.id = p_source)
      and material.library_stage = 'library'
      and material.lifecycle = 'active'
      and material.category = 'landing'
      and coalesce(nullif(material.drive_version,''), nullif(material.checksum,'')) is not null
  ), inserted as (
    insert into public.team_library_requirements (
      team_id, source_material_id, source_version, kind, variant
    )
    select p_team, candidate.id, candidate.source_version, 'landing_optimization', p_interface_language
    from candidates as candidate
    on conflict (team_id, source_material_id, source_version, kind, variant) do nothing
    returning 1
  ) select count(*)::integer into inserted_landings from inserted;

  select count(*)::integer into ready_count
  from public.team_library_requirements as requirement
  where requirement.team_id = p_team and requirement.state = 'ready';

  select count(*) filter (where requirement.kind = 'transcription')::integer,
         count(*) filter (where requirement.kind = 'translation')::integer,
         count(*) filter (where requirement.kind = 'landing_optimization')::integer
    into missing_transcriptions, missing_translations, missing_landings
  from public.team_library_requirements as requirement
  where requirement.team_id = p_team
    and (p_source is null or requirement.source_material_id = p_source)
    and requirement.state in ('pending','leased','running','failed');

  return jsonb_build_object(
    'created', jsonb_build_object(
      'transcription', inserted_transcriptions,
      'translation', inserted_translations,
      'landingOptimization', inserted_landings
    ),
    'missing', jsonb_build_object(
      'transcription', missing_transcriptions,
      'translation', missing_translations,
      'landingOptimization', missing_landings
    ),
    'ready', ready_count,
    'started', false
  );
end;
$$;

create or replace function public.claim_library_job(
  p_team uuid,
  p_agent_instance uuid,
  p_supported_kinds text[],
  p_interface_language text,
  p_source uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  requirement public.team_library_requirements%rowtype;
  attempt_id uuid;
  lease_token text;
  lease_expires_at timestamptz;
begin
  if actor is null or not private.can(p_team, 'process', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_agent_instance is null or p_supported_kinds is null or cardinality(p_supported_kinds) not between 1 and 3
     or exists (select 1 from unnest(p_supported_kinds) as kind where kind not in ('transcription','translation','landing_optimization'))
     or cardinality(array(select distinct kind from unnest(p_supported_kinds) as kind)) <> cardinality(p_supported_kinds)
     or not exists (select 1 from public.language_options where code = p_interface_language) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  with expired as (
    update private.team_library_attempts as attempt
       set state = 'expired', finished_at = clock_timestamp()
     where attempt.team_id = p_team
       and attempt.state in ('leased','running')
       and attempt.lease_expires_at <= clock_timestamp()
     returning attempt.requirement_id
  )
  update public.team_library_requirements as candidate
     set state = 'pending'
   where candidate.id in (select requirement_id from expired)
     and candidate.state in ('leased','running');

  select candidate.* into requirement
  from public.team_library_requirements as candidate
  join public.team_materials as material
    on material.id = candidate.source_material_id and material.team_id = candidate.team_id
  where candidate.team_id = p_team
    and candidate.state = 'pending'
    and candidate.kind = any(p_supported_kinds)
    and (p_source is null or candidate.source_material_id = p_source)
    and material.lifecycle = 'active'
    and material.library_stage = 'library'
    and coalesce(nullif(material.drive_version,''), nullif(material.checksum,'')) = candidate.source_version
  order by candidate.created_at, candidate.id
  for update of candidate skip locked
  limit 1;
  if requirement.id is null then
    raise exception 'NO_WORK' using errcode = 'P0002';
  end if;

  lease_token := encode(extensions.gen_random_bytes(32), 'hex');
  lease_expires_at := clock_timestamp() + interval '90 seconds';
  insert into private.team_library_attempts (
    requirement_id, team_id, actor_id, agent_instance_id,
    lease_token_hash, lease_expires_at
  ) values (
    requirement.id, p_team, actor, p_agent_instance,
    extensions.digest(lease_token, 'sha256'), lease_expires_at
  ) returning id into attempt_id;
  update public.team_library_requirements
     set state = 'leased', last_error_code = null
   where id = requirement.id;

  return jsonb_build_object(
    'teamId', p_team,
    'requirementId', requirement.id,
    'attemptId', attempt_id,
    'sourceMaterialId', requirement.source_material_id,
    'sourceVersion', requirement.source_version,
    'kind', requirement.kind,
    'variant', requirement.variant,
    'leaseToken', lease_token,
    'leaseExpiresAt', lease_expires_at
  );
end;
$$;

create or replace function public.heartbeat_library_job(
  p_team uuid,
  p_attempt uuid,
  p_agent_instance uuid,
  p_lease_token text,
  p_progress integer,
  p_stage text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  updated_expiry timestamptz;
  requirement_id uuid;
begin
  if actor is null or not private.can(p_team, 'process', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_progress not between 0 and 100 or p_stage !~ '^[a-z][a-z0-9_:-]{0,63}$'
     or p_lease_token is null or char_length(p_lease_token) not between 24 and 2048 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update private.team_library_attempts as attempt
     set state = 'running', progress = p_progress, stage = p_stage,
         last_heartbeat_at = clock_timestamp(),
         lease_expires_at = clock_timestamp() + interval '90 seconds'
   where attempt.id = p_attempt
     and attempt.team_id = p_team
     and attempt.actor_id = actor
     and attempt.agent_instance_id = p_agent_instance
     and attempt.state in ('leased','running')
     and attempt.lease_expires_at > clock_timestamp()
     and attempt.lease_token_hash = extensions.digest(p_lease_token, 'sha256')
   returning attempt.lease_expires_at, attempt.requirement_id
   into updated_expiry, requirement_id;
  if requirement_id is null then
    if exists (
      select 1 from private.team_library_attempts as attempt
      where attempt.id = p_attempt and attempt.team_id = p_team
        and attempt.lease_expires_at <= clock_timestamp()
    ) then
      raise exception 'LEASE_EXPIRED' using errcode = '40001';
    end if;
    raise exception 'LEASE_MISMATCH' using errcode = '42501';
  end if;
  update public.team_library_requirements set state = 'running' where id = requirement_id;
  return jsonb_build_object(
    'attemptId', p_attempt,
    'progress', p_progress,
    'stage', p_stage,
    'leaseExpiresAt', updated_expiry
  );
end;
$$;

create or replace function public.cancel_library_job(
  p_team uuid,
  p_attempt uuid,
  p_agent_instance uuid,
  p_lease_token text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  requirement_id uuid;
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update private.team_library_attempts as attempt
     set state = 'canceled', finished_at = clock_timestamp()
   where attempt.id = p_attempt and attempt.team_id = p_team
     and attempt.actor_id = auth.uid() and attempt.agent_instance_id = p_agent_instance
     and attempt.state in ('leased','running')
     and attempt.lease_token_hash = extensions.digest(p_lease_token, 'sha256')
   returning attempt.requirement_id into requirement_id;
  if requirement_id is null then return false; end if;
  update public.team_library_requirements
     set state = 'pending'
   where id = requirement_id and state in ('leased','running');
  return true;
end;
$$;

create or replace function public.fail_library_job(
  p_team uuid,
  p_attempt uuid,
  p_agent_instance uuid,
  p_lease_token text,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  requirement_id uuid;
  requirement_kind text;
begin
  if actor is null or not private.can(p_team, 'process', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$'
     or p_lease_token is null or char_length(p_lease_token) not between 24 and 2048 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update private.team_library_attempts as attempt
     set state = 'failed', error_code = p_error_code, finished_at = clock_timestamp()
   where attempt.id = p_attempt and attempt.team_id = p_team
     and attempt.actor_id = actor and attempt.agent_instance_id = p_agent_instance
     and attempt.state in ('leased','running')
     and attempt.lease_token_hash = extensions.digest(p_lease_token, 'sha256')
   returning attempt.requirement_id into requirement_id;
  if requirement_id is null then return false; end if;
  update public.team_library_requirements as requirement
     set state = 'failed', last_error_code = p_error_code
   where requirement.id = requirement_id
   returning requirement.kind into requirement_kind;
  perform private.append_library_contribution(
    p_team, actor, 'local_processing', requirement_kind, 'failure', p_agent_instance
  );
  return true;
end;
$$;

create or replace function public.retry_failed_library_jobs(
  p_team uuid,
  p_source uuid default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  retried integer;
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.team_library_requirements as requirement
     set state = 'pending', last_error_code = null
   where requirement.team_id = p_team and requirement.state = 'failed'
     and (p_source is null or requirement.source_material_id = p_source);
  get diagnostics retried = row_count;
  return retried;
end;
$$;

create or replace function public.service_accept_library_result(
  p_team uuid,
  p_attempt uuid,
  p_actor uuid,
  p_agent_instance uuid,
  p_lease_token text,
  p_result_material uuid,
  p_source_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  attempt private.team_library_attempts%rowtype;
  requirement public.team_library_requirements%rowtype;
  result_id uuid;
  source_name text;
begin
  select * into attempt from private.team_library_attempts as candidate
  where candidate.id = p_attempt and candidate.team_id = p_team for update;
  if attempt.id is null or attempt.actor_id <> p_actor or attempt.agent_instance_id <> p_agent_instance
     or attempt.lease_token_hash <> extensions.digest(p_lease_token, 'sha256') then
    raise exception 'LEASE_MISMATCH' using errcode = '42501';
  end if;
  if attempt.state not in ('leased','running') or attempt.lease_expires_at <= clock_timestamp() then
    raise exception 'LEASE_EXPIRED' using errcode = '40001';
  end if;
  select * into requirement from public.team_library_requirements as candidate
  where candidate.id = attempt.requirement_id for update;
  if requirement.state = 'ready' then
    update private.team_library_attempts
       set state = 'skipped', finished_at = clock_timestamp()
     where id = p_attempt;
    return jsonb_build_object(
      'state', 'skipped', 'reason', 'already_completed',
      'materialId', (select material_id from public.team_library_results where id = requirement.current_result_id)
    );
  end if;
  if requirement.source_version <> p_source_version
     or not exists (
       select 1 from public.team_materials as source
       where source.id = requirement.source_material_id and source.team_id = p_team
         and source.lifecycle = 'active'
         and coalesce(nullif(source.drive_version,''), nullif(source.checksum,'')) = p_source_version
     ) then
    raise exception 'STALE_RESULT' using errcode = '40001';
  end if;
  if not exists (
    select 1 from public.team_materials as result
    where result.id = p_result_material and result.team_id = p_team and result.lifecycle = 'active'
      and (requirement.kind not in ('transcription','translation') or result.category = 'transcript')
  ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  insert into public.team_library_results (
    team_id, requirement_id, source_material_id, source_version,
    kind, variant, material_id, accepted_attempt_id, accepted_by
  ) values (
    p_team, requirement.id, requirement.source_material_id, requirement.source_version,
    requirement.kind, requirement.variant, p_result_material, p_attempt, p_actor
  ) returning id into result_id;
  select source.name into source_name from public.team_materials as source
  where source.id = requirement.source_material_id;
  insert into public.team_material_links (
    team_id, source_material_id, derivative_material_id, relation,
    source_name_snapshot, tool_id, tool_contract_version, created_by
  ) values (
    p_team, requirement.source_material_id, p_result_material, 'processed_from',
    source_name, requirement.kind, 1, p_actor
  ) on conflict (team_id, source_material_id, derivative_material_id, relation) do nothing;
  update public.team_materials as result
     set library_stage = source.library_stage,
         structural_offer = coalesce(source.structural_offer, source.offer, 'unknown'),
         structural_language = coalesce(source.structural_language, source.language, 'unknown'),
         structural_type = coalesce(source.structural_type, initcap(coalesce(source.category, 'unknown'))),
         placement_state = 'ready', placement_revision = result.placement_revision + 1
    from public.team_materials as source
   where result.id = p_result_material and result.team_id = p_team
     and source.id = requirement.source_material_id and source.team_id = p_team;
  update private.team_library_attempts
     set state = 'ready', progress = 100, result_material_id = p_result_material,
         finished_at = clock_timestamp()
   where id = p_attempt;
  update public.team_library_requirements
     set state = 'ready', current_result_id = result_id, completed_at = clock_timestamp()
   where id = requirement.id;
  perform private.append_library_contribution(
    p_team, p_actor, 'local_processing', requirement.kind, 'success', p_agent_instance
  );
  return jsonb_build_object('state', 'accepted', 'resultId', result_id, 'materialId', p_result_material);
exception
  when unique_violation then
    update private.team_library_attempts
       set state = 'skipped', finished_at = clock_timestamp()
     where id = p_attempt and state in ('leased','running');
    return jsonb_build_object('state', 'skipped', 'reason', 'already_completed', 'materialId', null);
end;
$$;

create or replace function public.list_video_text_variants(
  p_team uuid,
  p_video uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  source_version text;
  can_process boolean;
  variants jsonb;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select coalesce(nullif(video.drive_version,''), nullif(video.checksum,''))
    into source_version
  from public.team_materials as video
  where video.id = p_video and video.team_id = p_team
    and video.category = 'video' and video.lifecycle = 'active';
  if source_version is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'materialId', text_material.id,
    'kind', case when result.kind = 'transcription' then 'original' else 'translation' end,
    'language', case when result.kind = 'translation' then result.variant
      else coalesce(video.language, nullif(video.structural_language, 'unknown'), 'unknown') end,
    'ingestState', text_material.transcript_ingest_state,
    'truncated', text_material.transcript_truncated,
    'text', text_material.transcript_text,
    'updatedAt', text_material.updated_at
  ) order by case when result.kind = 'transcription' then 0 else 1 end, result.variant), '[]'::jsonb)
  into variants
  from public.team_library_results as result
  join public.team_materials as video
    on video.id = result.source_material_id and video.team_id = result.team_id
  join public.team_materials as text_material
    on text_material.id = result.material_id and text_material.team_id = result.team_id
  where result.team_id = p_team
    and result.source_material_id = p_video
    and result.source_version = source_version
    and result.state = 'current'
    and result.kind in ('transcription','translation')
    and text_material.lifecycle = 'active';
  can_process := private.can(p_team, 'process', auth.uid());
  return jsonb_build_object(
    'sourceVersion', source_version,
    'variants', variants,
    'canProcess', can_process
  );
end;
$$;

create or replace function public.get_library_processing_context(
  p_team uuid,
  p_source uuid
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
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'sourceMaterialId', source.id,
    'sourceName', source.name,
    'category', source.category,
    'destinationFolderId', folder.id
  ) into payload
  from public.team_materials as source
  join public.team_materials as folder
    on folder.team_id = source.team_id
   and folder.connection_id = source.connection_id
   and folder.drive_file_id = source.parent_folder_id
   and folder.kind = 'folder' and folder.lifecycle = 'active'
  where source.id = p_source and source.team_id = p_team
    and source.lifecycle = 'active' and source.library_stage = 'library';
  if payload is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  return payload;
end;
$$;

create or replace function public.get_share_preference(p_team uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  allowed boolean;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select preference.allow_link_on_copy into allowed
  from public.team_share_preferences as preference
  where preference.team_id = p_team and preference.user_id = auth.uid();
  return jsonb_build_object('allowLinkOnCopy', coalesce(allowed, false), 'remembered', allowed is not null);
end;
$$;

create or replace function public.set_share_preference(p_team uuid, p_allow boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) or p_allow is null then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  insert into public.team_share_preferences (team_id, user_id, allow_link_on_copy)
  values (p_team, auth.uid(), p_allow)
  on conflict (team_id, user_id) do update
    set allow_link_on_copy = excluded.allow_link_on_copy,
        updated_at = clock_timestamp();
  return p_allow;
end;
$$;

create or replace function public.reset_share_preference(p_team uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  delete from public.team_share_preferences
  where team_id = p_team and user_id = auth.uid();
  return found;
end;
$$;

create or replace function public.list_library_contribution_totals(
  p_team uuid,
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table (category text, action_kind text, outcome text, total bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or private.team_role(p_team, auth.uid()) not in ('owner','admin') then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if (p_from is null) <> (p_to is null) or (p_from is not null and p_from >= p_to) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return query
  select record.category, record.action_kind, record.outcome, count(*)
  from public.team_contribution_records as record
  where record.team_id = p_team
    and (p_from is null or (record.occurred_at >= p_from and record.occurred_at < p_to))
  group by record.category, record.action_kind, record.outcome
  order by record.category, record.action_kind, record.outcome;
end;
$$;

create or replace function public.create_upload_batch(
  p_team uuid,
  p_stage text,
  p_offer text,
  p_geo text,
  p_language_mode text,
  p_language text,
  p_type_hint text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  batch_id uuid;
  item_count integer;
  item_payload jsonb;
begin
  if actor is null or not private.can(p_team, 'upload', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_stage not in ('finds','library')
     or p_offer is null or char_length(btrim(p_offer)) not between 1 and 120
     or p_language_mode not in ('manual','auto')
     or (p_language_mode = 'manual' and p_language is null)
     or (p_language_mode = 'auto' and p_language is not null)
     or not exists (select 1 from public.geo_options where code = p_geo)
     or (p_language is not null and not exists (
       select 1 from public.language_options where code = p_language
     ))
     or (p_type_hint is not null and char_length(btrim(p_type_hint)) not between 1 and 64)
     or jsonb_typeof(p_items) <> 'array' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  item_count := jsonb_array_length(p_items);
  if item_count not between 1 and 500
     or exists (
       select 1
       from jsonb_array_elements(p_items) as item
       where jsonb_typeof(item) <> 'object'
          or exists (
            select 1 from jsonb_object_keys(item) as key
            where key not in ('clientItemKey','name','mimeType','sizeBytes')
          )
          or coalesce(item ->> 'clientItemKey', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
          or char_length(btrim(coalesce(item ->> 'name', ''))) not between 1 and 512
          or char_length(coalesce(item ->> 'mimeType', '')) not between 3 and 255
          or coalesce(item ->> 'sizeBytes', '') !~ '^[0-9]+$'
          or (item ->> 'sizeBytes')::numeric > 107374182400
     )
     or exists (
       select 1 from jsonb_array_elements(p_items) as item
       group by item ->> 'clientItemKey' having count(*) > 1
     ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  insert into public.team_upload_batches (
    team_id, actor_id, stage, offer, geo, language, language_mode, type_hint,
    state, total_items
  ) values (
    p_team, actor, p_stage, btrim(p_offer), p_geo, p_language, p_language_mode,
    nullif(btrim(p_type_hint), ''), 'running', item_count
  ) returning id into batch_id;

  insert into public.team_upload_batch_items (
    batch_id, team_id, client_item_key, requested_name, mime_type, size_bytes
  )
  select batch_id, p_team,
         item ->> 'clientItemKey', btrim(item ->> 'name'), lower(item ->> 'mimeType'),
         (item ->> 'sizeBytes')::bigint
  from jsonb_array_elements(p_items) with ordinality as input(item, ordinal)
  order by ordinal;

  select jsonb_agg(jsonb_build_object(
    'itemId', item.id,
    'clientItemKey', item.client_item_key,
    'state', item.state
  ) order by item.created_at, item.id) into item_payload
  from public.team_upload_batch_items as item where item.batch_id = batch_id;
  return jsonb_build_object('batchId', batch_id, 'state', 'running', 'items', item_payload);
end;
$$;

create or replace function public.get_upload_batch(p_team uuid, p_batch uuid)
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
  select jsonb_build_object(
    'batchId', batch.id,
    'state', batch.state,
    'totalItems', batch.total_items,
    'succeededItems', batch.succeeded_items,
    'failedItems', batch.failed_items,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'itemId', item.id,
        'clientItemKey', item.client_item_key,
        'requestedName', item.requested_name,
        'state', item.state,
        'progress', item.progress,
        'materialId', item.material_id,
        'errorCode', item.error_code
      ) order by item.created_at, item.id)
      from public.team_upload_batch_items as item where item.batch_id = batch.id
    ), '[]'::jsonb)
  ) into payload
  from public.team_upload_batches as batch
  where batch.id = p_batch and batch.team_id = p_team;
  if payload is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  return payload;
end;
$$;

create or replace function public.list_library_materials(
  p_team uuid,
  p_stage text,
  p_cursor uuid default null,
  p_page_size integer default 50
)
returns table (
  id uuid,
  team_id uuid,
  name text,
  category text,
  mime_type text,
  file_extension text,
  size_bytes bigint,
  lifecycle text,
  source_version text,
  stage text,
  offer text,
  language text,
  type text,
  placement_state text,
  language_decision_source text,
  thumbnail_state text,
  thumbnail_time_ms integer,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cursor_created_at timestamptz;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_stage not in ('finds','library') or p_page_size not between 1 and 100 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_cursor is not null then
    select material.created_at into cursor_created_at
    from public.team_materials as material
    where material.id = p_cursor and material.team_id = p_team
      and material.library_stage = p_stage;
    if cursor_created_at is null then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  end if;
  return query
  select material.id, material.team_id, material.name, material.category,
         material.mime_type, material.file_extension, material.size_bytes,
         material.lifecycle,
         coalesce(nullif(material.drive_version,''), nullif(material.checksum,'')),
         material.library_stage, coalesce(material.structural_offer, 'unknown'),
         coalesce(material.structural_language, 'unknown'),
         coalesce(material.structural_type, 'Unknown'), material.placement_state,
         material.language_decision_source, material.thumbnail_state,
         material.thumbnail_time_ms, material.created_at
  from public.team_materials as material
  where material.team_id = p_team and material.library_stage = p_stage
    and material.kind = 'file'
    and (p_cursor is null or (material.created_at, material.id) < (cursor_created_at, p_cursor))
  order by material.created_at desc, material.id desc
  limit p_page_size;
end;
$$;

create or replace function public.service_finalize_upload_batch_item(
  p_team uuid,
  p_actor uuid,
  p_batch uuid,
  p_client_item_key text,
  p_material uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  batch public.team_upload_batches%rowtype;
  item public.team_upload_batch_items%rowtype;
  succeeded integer;
  failed integer;
  next_state text;
  source_version text;
begin
  if not private.can(p_team, 'upload', p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select * into batch from public.team_upload_batches as candidate
  where candidate.id = p_batch and candidate.team_id = p_team for update;
  if batch.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select * into item from public.team_upload_batch_items as candidate
  where candidate.batch_id = p_batch and candidate.client_item_key = p_client_item_key
  for update;
  if item.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select coalesce(nullif(material.drive_version,''), nullif(material.checksum,''))
    into source_version
  from public.team_materials as material
  where material.id = p_material and material.team_id = p_team
    and material.lifecycle = 'active';
  if source_version is null then
    raise exception 'SOURCE_CHANGED' using errcode = '40001';
  end if;
  if item.state = 'succeeded' then
    if item.material_id <> p_material then raise exception 'SOURCE_CHANGED' using errcode = '40001'; end if;
    return jsonb_build_object(
      'state','succeeded','materialId',item.material_id,'sourceVersion',source_version,'reused',true
    );
  end if;
  if item.state = 'canceled' then raise exception 'WRONG_STATE' using errcode = '22023'; end if;

  update public.team_materials as material
     set library_stage = batch.stage,
         structural_offer = batch.offer,
         structural_language = coalesce(batch.language, 'unknown'),
         structural_type = coalesce(batch.type_hint, initcap(coalesce(material.category, 'unknown'))),
         placement_state = 'ready',
         placement_revision = material.placement_revision + 1,
         language_decision_source = case
           when batch.language_mode = 'manual' then 'manual' else 'unknown' end,
         language_decision_revision = material.language_decision_revision + 1,
         thumbnail_state = case when material.category in ('video','image') then 'pending'
           else material.thumbnail_state end,
         thumbnail_source_version = case when material.category in ('video','image')
           then source_version else material.thumbnail_source_version end,
         thumbnail_time_ms = case when material.category = 'video' then 1000 else null end,
         geo = batch.geo,
         language = coalesce(batch.language, material.language),
         offer = batch.offer
   where material.id = p_material and material.team_id = p_team;

  update public.team_upload_batch_items
     set state = 'succeeded', progress = 100, material_id = p_material,
         error_code = null, finished_at = clock_timestamp()
   where id = item.id;
  select count(*) filter (where state = 'succeeded')::integer,
         count(*) filter (where state = 'failed')::integer
    into succeeded, failed
  from public.team_upload_batch_items where batch_id = p_batch;
  next_state := case
    when succeeded = batch.total_items then 'succeeded'
    when failed > 0 then 'partial'
    else 'running' end;
  update public.team_upload_batches
     set succeeded_items = succeeded, failed_items = failed, state = next_state,
         finished_at = case when next_state = 'succeeded' then clock_timestamp() else null end
   where id = p_batch;
  if next_state = 'succeeded' then
    perform private.append_library_contribution(
      p_team, batch.actor_id, 'human_activity', 'batch_completed', 'success', null
    );
  end if;
  return jsonb_build_object(
    'state','succeeded','materialId',p_material,'sourceVersion',source_version,'reused',false
  );
end;
$$;

create or replace function public.service_get_library_asset_placement(
  p_team uuid,
  p_actor uuid,
  p_material uuid
)
returns table (
  material_id uuid,
  placement_revision bigint,
  stage text,
  offer text,
  language text,
  type text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.can(p_team, 'edit', p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
  select material.id, material.placement_revision, material.library_stage,
         coalesce(material.structural_offer, material.offer, 'unknown'),
         coalesce(material.structural_language, material.language, 'unknown'),
         coalesce(material.structural_type, initcap(coalesce(material.category, 'unknown')))
  from public.team_materials as material
  where material.id = p_material and material.team_id = p_team
    and material.kind = 'file' and material.lifecycle = 'active'
    and material.library_stage in ('finds','library');
end;
$$;

create or replace function public.service_create_material_lifecycle_intent(
  p_team uuid,
  p_actor uuid,
  p_operation uuid,
  p_material uuid,
  p_action text,
  p_destination_parent_id text default null
)
returns table (
  intent_id uuid,
  team_id uuid,
  operation_id uuid,
  source_material_id uuid,
  action text,
  members jsonb,
  applied_member_ids uuid[]
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  source public.team_materials%rowtype;
  existing private.team_material_group_intents%rowtype;
  snapshot jsonb;
  created_id uuid;
begin
  if p_action not in ('move','trash','restore')
     or not exists (
       select 1 from public.team_operations as operation
       where operation.id = p_operation and operation.team_id = p_team
         and operation.actor_id = p_actor and operation.kind = p_action
         and operation.source_material_id = p_material
         and operation.state in ('pending','running')
     )
     or (p_action = 'move' and (p_destination_parent_id is null
       or char_length(p_destination_parent_id) not between 1 and 1024))
     or (p_destination_parent_id is not null
       and char_length(p_destination_parent_id) not between 1 and 1024) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if not private.can(p_team, case when p_action = 'move' then 'edit' else 'delete' end, p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  select * into existing
  from private.team_material_group_intents as intent
  where intent.operation_id = p_operation for update;
  if existing.id is not null then
    return query select existing.id, existing.team_id, existing.operation_id,
      existing.source_material_id, existing.action, existing.member_snapshot,
      existing.applied_member_ids;
    return;
  end if;

  select * into source from public.team_materials as material
  where material.id = p_material and material.team_id = p_team for update;
  if source.id is null or source.kind <> 'file'
     or (p_action = 'restore' and source.lifecycle <> 'trashed')
     or (p_action <> 'restore' and source.lifecycle <> 'active') then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  select jsonb_agg(jsonb_build_object(
    'material_id', member.id,
    'drive_file_id', member.drive_file_id,
    'resource_key', member.resource_key,
    'parent_folder_id', member.parent_folder_id,
    'role', member.role
  ) order by case member.role when 'source' then 0 when 'transcript' then 1 else 2 end,
             member.id)
  into snapshot
  from (
    select material.id, material.drive_file_id, material.resource_key,
           material.parent_folder_id, 'source'::text as role
    from public.team_materials as material
    where material.id = p_material and material.team_id = p_team
    union all
    select sidecar.id, sidecar.drive_file_id, sidecar.resource_key,
           sidecar.parent_folder_id,
           case when result.kind = 'transcription' then 'transcript' else 'translation' end
    from public.team_library_results as result
    join public.team_materials as sidecar
      on sidecar.id = result.material_id and sidecar.team_id = result.team_id
    where result.team_id = p_team and result.source_material_id = p_material
      and result.state = 'current'
      and sidecar.lifecycle = case when p_action = 'restore' then 'trashed' else 'active' end
  ) as member;

  insert into private.team_material_group_intents (
    team_id, source_material_id, operation_id, action, destination_parent_id,
    member_snapshot, state
  ) values (
    p_team, p_material, p_operation, p_action, p_destination_parent_id, snapshot, 'running'
  ) returning id into created_id;
  update public.team_materials as material set placement_state = 'moving'
  where material.team_id = p_team and material.id in (
    select (entry ->> 'material_id')::uuid from jsonb_array_elements(snapshot) as entry
  );
  return query
  select intent.id, intent.team_id, intent.operation_id, intent.source_material_id,
         intent.action, intent.member_snapshot, intent.applied_member_ids
  from private.team_material_group_intents as intent where intent.id = created_id;
end;
$$;

create or replace function public.service_create_material_group_intent(
  p_team uuid,
  p_actor uuid,
  p_operation uuid,
  p_material uuid,
  p_expected_revision bigint,
  p_destination_material uuid,
  p_destination_parent_id text,
  p_stage text,
  p_offer text,
  p_language text,
  p_type text
)
returns table (
  intent_id uuid,
  team_id uuid,
  operation_id uuid,
  source_material_id uuid,
  action text,
  members jsonb,
  applied_member_ids uuid[]
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  source public.team_materials%rowtype;
  existing private.team_material_group_intents%rowtype;
  snapshot jsonb;
  created_id uuid;
begin
  if not private.can(p_team, 'edit', p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_stage not in ('finds','library')
     or char_length(btrim(p_offer)) not between 1 and 120
     or char_length(p_language) not between 1 and 35
     or char_length(btrim(p_type)) not between 1 and 64
     or char_length(p_destination_parent_id) not between 1 and 1024 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.team_operations as operation
    where operation.id = p_operation and operation.team_id = p_team
      and operation.actor_id = p_actor and operation.kind = 'move'
      and operation.source_material_id = p_material
      and operation.destination_folder_id = p_destination_material
      and operation.state in ('pending','running')
  ) or not exists (
    select 1 from public.team_materials as folder
    where folder.id = p_destination_material and folder.team_id = p_team
      and folder.kind = 'folder' and folder.lifecycle = 'active'
      and folder.drive_file_id = p_destination_parent_id
  ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  select * into existing
  from private.team_material_group_intents as intent
  where intent.operation_id = p_operation for update;
  if existing.id is not null then
    return query select existing.id, existing.team_id, existing.operation_id,
      existing.source_material_id, existing.action, existing.member_snapshot,
      existing.applied_member_ids;
    return;
  end if;

  select * into source
  from public.team_materials as material
  where material.id = p_material and material.team_id = p_team
  for update;
  if source.id is null or source.kind <> 'file' or source.lifecycle <> 'active' then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if source.placement_revision <> p_expected_revision
     or source.placement_state in ('moving','reconciling') then
    raise exception 'SOURCE_CHANGED' using errcode = '40001';
  end if;

  select jsonb_agg(jsonb_build_object(
    'material_id', member.id,
    'drive_file_id', member.drive_file_id,
    'resource_key', member.resource_key,
    'parent_folder_id', member.parent_folder_id,
    'role', member.role,
    'target_stage', p_stage,
    'target_offer', btrim(p_offer),
    'target_language', p_language,
    'target_type', btrim(p_type)
  ) order by case member.role when 'source' then 0 when 'transcript' then 1 else 2 end,
             member.id)
  into snapshot
  from (
    select material.id, material.drive_file_id, material.resource_key,
           material.parent_folder_id, 'source'::text as role
    from public.team_materials as material
    where material.id = p_material and material.team_id = p_team
    union all
    select sidecar.id, sidecar.drive_file_id, sidecar.resource_key,
           sidecar.parent_folder_id,
           case when result.kind = 'transcription' then 'transcript' else 'translation' end
    from public.team_library_results as result
    join public.team_materials as sidecar
      on sidecar.id = result.material_id and sidecar.team_id = result.team_id
    where result.team_id = p_team and result.source_material_id = p_material
      and result.state = 'current' and sidecar.lifecycle = 'active'
  ) as member;

  insert into private.team_material_group_intents (
    team_id, source_material_id, operation_id, action, destination_parent_id,
    member_snapshot, state
  ) values (
    p_team, p_material, p_operation, 'move', p_destination_parent_id,
    snapshot, 'running'
  ) returning id into created_id;

  update public.team_materials as material
     set placement_state = 'moving'
   where material.team_id = p_team
     and material.id in (
       select (entry ->> 'material_id')::uuid from jsonb_array_elements(snapshot) as entry
     );
  update public.team_operations
     set state = 'running', stage = 'moving_group', progress = 5,
         updated_at = clock_timestamp()
   where id = p_operation;

  return query
  select intent.id, intent.team_id, intent.operation_id, intent.source_material_id,
         intent.action, intent.member_snapshot, intent.applied_member_ids
  from private.team_material_group_intents as intent where intent.id = created_id;
end;
$$;

create or replace function public.service_checkpoint_material_group_intent(
  p_intent uuid,
  p_material uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  intent private.team_material_group_intents%rowtype;
begin
  select * into intent from private.team_material_group_intents as candidate
  where candidate.id = p_intent for update;
  if intent.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if intent.state not in ('running','reconciling') then
    return p_material = any(intent.applied_member_ids);
  end if;
  if not exists (
    select 1 from jsonb_array_elements(intent.member_snapshot) as member
    where (member ->> 'material_id')::uuid = p_material
  ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update private.team_material_group_intents
     set applied_member_ids = array(
       select distinct value from unnest(intent.applied_member_ids || p_material) as value
       order by value
     ), state = 'running', error_code = null
   where id = p_intent;
  return true;
end;
$$;

create or replace function public.service_mark_material_group_reconciling(
  p_intent uuid,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  intent private.team_material_group_intents%rowtype;
begin
  if p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into intent from private.team_material_group_intents as candidate
  where candidate.id = p_intent for update;
  if intent.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  update private.team_material_group_intents
     set state = 'reconciling', error_code = p_error_code
   where id = p_intent and state <> 'succeeded';
  update public.team_materials as material
     set placement_state = 'reconciling'
   where material.team_id = intent.team_id
     and material.id in (
       select (entry ->> 'material_id')::uuid
       from jsonb_array_elements(intent.member_snapshot) as entry
     );
  update public.team_operations
     set state = 'running', stage = 'group_reconciling', progress = 50,
         error_code = p_error_code, retryable = true, updated_at = clock_timestamp()
   where id = intent.operation_id and state not in ('succeeded','canceled');
  return true;
end;
$$;

create or replace function public.service_complete_material_group_intent(p_intent uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  intent private.team_material_group_intents%rowtype;
  source_payload jsonb;
  source_before_stage text;
  operation_actor uuid;
begin
  select * into intent from private.team_material_group_intents as candidate
  where candidate.id = p_intent for update;
  if intent.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if intent.state = 'succeeded' then
    return jsonb_build_object(
      'operationId', intent.operation_id, 'state','succeeded',
      'materialId',intent.source_material_id,'reused',true
    );
  end if;
  if cardinality(intent.applied_member_ids) <> jsonb_array_length(intent.member_snapshot) then
    raise exception 'GROUP_RECONCILING' using errcode = '40001';
  end if;
  select member into source_payload
  from jsonb_array_elements(intent.member_snapshot) as member
  where member ->> 'role' = 'source' limit 1;
  if source_payload is null then raise exception 'INVALID_RESPONSE' using errcode = '22023'; end if;
  select material.library_stage into source_before_stage
  from public.team_materials as material
  where material.id = intent.source_material_id and material.team_id = intent.team_id;
  select operation.actor_id into operation_actor
  from public.team_operations as operation
  where operation.id = intent.operation_id and operation.team_id = intent.team_id;

  if intent.action = 'move' then
    update public.team_materials as material
       set parent_folder_id = intent.destination_parent_id,
           library_stage = coalesce(source_payload ->> 'target_stage', material.library_stage),
           structural_offer = coalesce(source_payload ->> 'target_offer', material.structural_offer),
           structural_language = coalesce(source_payload ->> 'target_language', material.structural_language),
           structural_type = coalesce(source_payload ->> 'target_type', material.structural_type),
           offer = coalesce(source_payload ->> 'target_offer', material.offer),
           language = case
             when source_payload ->> 'target_language' is null then material.language
             when source_payload ->> 'target_language' = 'unknown' then material.language
             else source_payload ->> 'target_language' end,
           placement_state = 'ready', placement_revision = placement_revision + 1
     where material.team_id = intent.team_id
       and material.id in (
         select (entry ->> 'material_id')::uuid
         from jsonb_array_elements(intent.member_snapshot) as entry
       );
  else
    update public.team_materials as material
       set parent_folder_id = case when intent.action = 'restore'
              then coalesce(intent.destination_parent_id, material.parent_folder_id)
              else material.parent_folder_id end,
           lifecycle = case when intent.action = 'trash' then 'trashed' else 'active' end,
           trashed_at = case when intent.action = 'trash' then clock_timestamp() else null end,
           missing_at = case when intent.action = 'restore' then null else material.missing_at end,
           placement_state = 'ready', placement_revision = placement_revision + 1
     where material.team_id = intent.team_id
       and material.id in (
         select (entry ->> 'material_id')::uuid
         from jsonb_array_elements(intent.member_snapshot) as entry
       );
  end if;
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  select intent.team_id, (entry ->> 'material_id')::uuid,
         case when intent.action = 'trash' then 'tombstoned' else 'upserted' end
  from jsonb_array_elements(intent.member_snapshot) as entry;
  update private.team_material_group_intents
     set state = 'succeeded', error_code = null, finished_at = clock_timestamp()
   where id = intent.id;
  update public.team_operations
     set state = 'succeeded', stage = 'completed', progress = 100,
         result_material_id = intent.source_material_id, error_code = null,
         retryable = false, finished_at = clock_timestamp(), updated_at = clock_timestamp()
   where id = intent.operation_id;
  if intent.action = 'move'
     and source_before_stage = 'finds'
     and source_payload ->> 'target_stage' = 'library'
     and operation_actor is not null then
    perform private.append_library_contribution(
      intent.team_id, operation_actor, 'human_activity', 'find_selected', 'success', null
    );
  end if;
  return jsonb_build_object(
    'operationId', intent.operation_id, 'state','succeeded',
    'materialId',intent.source_material_id,'reused',false
  );
end;
$$;

create or replace function public.service_fail_upload_batch_item(
  p_team uuid,
  p_actor uuid,
  p_batch uuid,
  p_client_item_key text,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  total integer;
  succeeded integer;
  failed integer;
begin
  if not private.can(p_team, 'upload', p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update public.team_upload_batch_items as item
     set state = 'failed', error_code = p_error_code, finished_at = clock_timestamp()
   where item.team_id = p_team and item.batch_id = p_batch
     and item.client_item_key = p_client_item_key and item.state <> 'succeeded';
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select batch.total_items,
         count(*) filter (where item.state = 'succeeded')::integer,
         count(*) filter (where item.state = 'failed')::integer
    into total, succeeded, failed
  from public.team_upload_batches as batch
  join public.team_upload_batch_items as item on item.batch_id = batch.id
  where batch.id = p_batch and batch.team_id = p_team
  group by batch.total_items;
  update public.team_upload_batches
     set succeeded_items = succeeded, failed_items = failed,
         state = case
           when succeeded + failed < total then 'running'
           when succeeded > 0 then 'partial'
           else 'failed' end,
         finished_at = case when succeeded + failed = total then clock_timestamp() else null end
   where id = p_batch;
  return jsonb_build_object('state','failed','errorCode',p_error_code);
end;
$$;

create or replace function public.service_enqueue_material_enrichments(
  p_team uuid,
  p_material uuid,
  p_source_version text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_count integer;
begin
  if not exists (
    select 1 from public.team_materials as material
    where material.id = p_material and material.team_id = p_team
      and material.lifecycle = 'active'
      and coalesce(nullif(material.drive_version,''), nullif(material.checksum,'')) = p_source_version
  ) then
    raise exception 'SOURCE_CHANGED' using errcode = '40001';
  end if;
  insert into private.team_material_enrichments (
    team_id, material_id, source_version, kind, decision_revision
  )
  select material.team_id, material.id, p_source_version, kind.name,
         material.language_decision_revision
  from public.team_materials as material
  cross join lateral (
    select 'language'::text as name
      where material.category in ('video','landing')
        and material.language_decision_source <> 'manual'
    union all select 'thumbnail' where material.category = 'video'
    union all select 'landing_preview' where material.category = 'landing'
  ) as kind
  where material.id = p_material and material.team_id = p_team
  on conflict (team_id, material_id, source_version, kind) do nothing;
  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

create or replace function public.service_reserve_library_folder(
  p_team uuid,
  p_connection uuid,
  p_parent_folder_id text,
  p_segment text,
  p_value text
)
returns table (
  material_id uuid,
  segment text,
  value text,
  parent_folder_id text,
  drive_folder_id text,
  resource_key text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized text := lower(regexp_replace(btrim(p_value), '\s+', ' ', 'g'));
begin
  if p_segment not in ('stage','offer','language','type')
     or char_length(btrim(p_value)) not between 1 and 120
     or not exists (
       select 1 from public.team_drive_connections as connection
       where connection.id = p_connection and connection.team_id = p_team
         and connection.state = 'connected'
     ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return query
  select folder.material_id, folder.segment, folder.value, folder.parent_folder_id,
         folder.drive_folder_id, folder.resource_key
  from private.team_library_folders as folder
  where folder.team_id = p_team and folder.parent_folder_id = p_parent_folder_id
    and folder.segment = p_segment and folder.normalized_key = normalized
    and folder.state = 'ready';
end;
$$;

create or replace function public.service_get_library_connection_context(
  p_team uuid,
  p_actor uuid
)
returns table (
  connection_id uuid,
  credential_id uuid,
  root_folder_id text,
  root_resource_key text,
  drive_id text,
  drive_kind text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (private.can(p_team, 'upload', p_actor) or private.can(p_team, 'edit', p_actor)) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
  select connection.id, connection.credential_id, connection.root_folder_id,
         connection.root_resource_key, connection.drive_id, connection.drive_kind
  from public.team_drive_connections as connection
  where connection.team_id = p_team and connection.state = 'connected'
  order by connection.created_at desc limit 1;
end;
$$;

create or replace function public.service_commit_library_folder(
  p_team uuid,
  p_connection uuid,
  p_parent_folder_id text,
  p_segment text,
  p_value text,
  p_drive_folder_id text,
  p_resource_key text
)
returns table (
  material_id uuid,
  segment text,
  value text,
  parent_folder_id text,
  drive_folder_id text,
  resource_key text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized text := lower(regexp_replace(btrim(p_value), '\s+', ' ', 'g'));
  catalog_material uuid;
begin
  if p_segment not in ('stage','offer','language','type')
     or char_length(btrim(p_value)) not between 1 and 120
     or char_length(p_drive_folder_id) not between 1 and 1024
     or not exists (
       select 1 from public.team_drive_connections as connection
       where connection.id = p_connection and connection.team_id = p_team
         and connection.state = 'connected'
     ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  insert into public.team_materials (
    team_id, connection_id, drive_file_id, resource_key, parent_folder_id,
    name, mime_type, kind, category, lifecycle, preview_state
  ) values (
    p_team, p_connection, p_drive_folder_id, p_resource_key, p_parent_folder_id,
    btrim(p_value), 'application/vnd.google-apps.folder', 'folder', null, 'active', 'ready'
  )
  on conflict (team_id, drive_file_id) do update
    set parent_folder_id = excluded.parent_folder_id,
        name = excluded.name,
        resource_key = excluded.resource_key,
        lifecycle = 'active', trashed_at = null, missing_at = null
  returning id into catalog_material;

  insert into private.team_library_folders as folder (
    team_id, connection_id, material_id, parent_folder_id, segment, value,
    normalized_key, drive_folder_id, resource_key, state, verified_at
  ) values (
    p_team, p_connection, catalog_material, p_parent_folder_id, p_segment, btrim(p_value),
    normalized, p_drive_folder_id, p_resource_key, 'ready', clock_timestamp()
  )
  on conflict (team_id, parent_folder_id, segment, normalized_key) do update
    set state = 'ready', verified_at = clock_timestamp();

  return query
  select folder.material_id, folder.segment, folder.value, folder.parent_folder_id,
         folder.drive_folder_id, folder.resource_key
  from private.team_library_folders as folder
  where folder.team_id = p_team and folder.parent_folder_id = p_parent_folder_id
    and folder.segment = p_segment and folder.normalized_key = normalized;
end;
$$;
