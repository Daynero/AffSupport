-- Copy selected tasks as one transaction; attachments reference the same files.
begin;
create function public.copy_team_tasks(p_team uuid, p_tasks uuid[])
returns uuid[] language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  source public.team_tasks%rowtype;
  created public.team_tasks%rowtype;
  source_id uuid;
  result uuid[] := '{}';
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_tasks is null or cardinality(p_tasks) not between 1 and 100
     or array_position(p_tasks, null) is not null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  -- Lock in a stable order. A missing or foreign task fails the entire paste.
  perform 1 from public.team_tasks where team_id = p_team and id = any(p_tasks)
  order by id for update;
  if (select count(*) from public.team_tasks where team_id = p_team and id = any(p_tasks))
     <> (select count(distinct id) from unnest(p_tasks) as input(id)) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  for source_id in
    select id from unnest(p_tasks) with ordinality as input(id, ordinal)
    group by id order by min(ordinal)
  loop
    select * into source from public.team_tasks where team_id = p_team and id = source_id;
    select * into created from public.create_team_task(
      p_team, source.title, source.note, source.assignee_id, null
    );
    -- Date follows a newly created task (created_at); workflow state starts over.
    update public.team_tasks set progress_max = source.progress_max where id = created.id;
    insert into public.team_task_label_links(team_id, task_id, label_id, attached_by)
      select p_team, created.id, label_id, actor from public.team_task_label_links
      where team_id = p_team and task_id = source.id;
    insert into public.team_task_attachments(team_id, task_id, material_id, position, attached_by)
      select p_team, created.id, material_id, position, actor from public.team_task_attachments
      where team_id = p_team and task_id = source.id;
    -- No team_task_agents: copied tasks start without ad accounts.
    result := array_append(result, created.id);
  end loop;
  return result;
end $$;
revoke all on function public.copy_team_tasks(uuid, uuid[]) from public, anon;
grant execute on function public.copy_team_tasks(uuid, uuid[]) to authenticated;
commit;
