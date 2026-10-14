begin;

create table private.team_task_copy_requests (
  team_id uuid not null references public.teams(id) on delete cascade,
  request_id uuid not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  source_ids uuid[] not null,
  result_ids uuid[] not null,
  created_at timestamptz not null default now(),
  primary key (team_id, request_id)
);

revoke all on private.team_task_copy_requests from public, anon, authenticated;

create function public.copy_team_tasks(p_team uuid, p_tasks uuid[], p_request_id uuid)
returns uuid[] language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  receipt private.team_task_copy_requests%rowtype;
  source public.team_tasks%rowtype;
  created public.team_tasks%rowtype;
  source_id uuid;
  result uuid[] := '{}';
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_request_id is null or p_tasks is null or cardinality(p_tasks) not between 1 and 100
     or array_position(p_tasks, null) is not null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  -- A transport retry must wait for the first transaction to commit before
  -- reading its receipt. This lock also serializes a conflicting key reuse.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_team::text || p_request_id::text, 0)
  );
  select * into receipt from private.team_task_copy_requests
  where team_id = p_team and request_id = p_request_id;
  if found then
    if receipt.actor_id <> actor or receipt.source_ids <> p_tasks then
      raise exception 'REQUEST_REUSE_CONFLICT' using errcode = '22023';
    end if;
    return receipt.result_ids;
  end if;

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
    update public.team_tasks set progress_max = source.progress_max where id = created.id;
    insert into public.team_task_label_links(team_id, task_id, label_id, attached_by)
      select p_team, created.id, label_id, actor from public.team_task_label_links
      where team_id = p_team and task_id = source.id;
    insert into public.team_task_attachments(team_id, task_id, material_id, position, attached_by)
      select p_team, created.id, material_id, position, actor from public.team_task_attachments
      where team_id = p_team and task_id = source.id;
    result := array_append(result, created.id);
  end loop;
  insert into private.team_task_copy_requests(team_id, request_id, actor_id, source_ids, result_ids)
    values (p_team, p_request_id, actor, p_tasks, result);
  return result;
end $$;

revoke all on function public.copy_team_tasks(uuid, uuid[], uuid) from public, anon;
grant execute on function public.copy_team_tasks(uuid, uuid[], uuid) to authenticated;
commit;
