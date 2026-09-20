-- Feature 024 — the history records the work, not only the files.
--
-- A buyer made a task, attached two creatives and marked a launch on an agent, and the space's
-- history showed none of it: only files, members, storage and invitations were ever written.
-- Triggers write the work as it happens, whichever function or screen did it:
--
--   task.created          a task is made               {task_id, task_title}
--   task.status_changed   its status moves             {task_id, task_title, from, to}
--   task.assigned         its assignee changes         {task_id, task_title, to}
--   task.file_attached    a file is put on it          {task_id, task_title, material_id}
--   task.agent_tagged     an agent is put on it        {task_id, task_title, agent}
--   agent.run_added       a launch is marked           {agent, note}
--   agent.run_removed     a launch is taken off        {agent, note}
--
-- Only what a signed-in person does is written (a service job has no actor). The target keys
-- grow by from/to/agent/note; `list_team_audit_events` names task and agent subjects.
-- Forward-only; ROLLBACK.md drops the triggers and re-applies the two functions.

create or replace function private.record_team_audit(
  p_team uuid,
  p_actor uuid,
  p_action text,
  p_target jsonb,
  p_result text,
  p_error_code text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  audit_id uuid;
  actor_label text;
begin
  if p_actor is null
     or p_action is null
     or char_length(p_action) not between 1 and 96
     or p_result not in ('succeeded', 'denied', 'failed', 'canceled')
     or jsonb_typeof(coalesce(p_target, '{}'::jsonb)) <> 'object'
     or exists (
       select 1
       from jsonb_object_keys(coalesce(p_target, '{}'::jsonb)) as target_key(key)
       where target_key.key not in (
         'member_id', 'invitation_id', 'connection_id', 'material_id',
         'operation_id', 'relation', 'role', 'state', 'warning_code',
         'task_id', 'task_title', 'from', 'to', 'agent', 'note'
       )
     ) then
    raise exception 'INVALID_AUDIT_EVENT' using errcode = '22023';
  end if;

  select left(profile.display_name, 120)
    into actor_label
  from public.profiles as profile
  where profile.id = p_actor;

  insert into public.team_audit_events (
    team_id,
    actor_id,
    actor_label_snapshot,
    action,
    target,
    result,
    error_code
  ) values (
    p_team,
    p_actor,
    actor_label,
    p_action,
    coalesce(p_target, '{}'::jsonb),
    p_result,
    p_error_code
  )
  returning id into audit_id;
  return audit_id;
end;
$$;
revoke all on function private.record_team_audit(uuid, uuid, text, jsonb, text, text)
from public, anon, authenticated;
grant execute on function private.record_team_audit(uuid, uuid, text, jsonb, text, text)
to service_role;

create or replace function private.team_agent_label(p_agent uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select account.name || '-' || right(agent.agent_id, 3)
  from public.team_account_agents as agent
  join public.team_accounts as account
    on account.id = agent.account_id and account.team_id = agent.team_id
  where agent.id = p_agent;
$$;
revoke all on function private.team_agent_label(uuid) from public, anon, authenticated, service_role;

create or replace function private.audit_team_task_work()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then
    return null;
  end if;
  if tg_op = 'INSERT' then
    perform private.record_team_audit(new.team_id, actor, 'task.created',
      jsonb_build_object('task_id', new.id, 'task_title', new.title), 'succeeded', null);
  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      perform private.record_team_audit(new.team_id, actor, 'task.status_changed',
        jsonb_build_object('task_id', new.id, 'task_title', new.title,
                           'from', old.status, 'to', new.status), 'succeeded', null);
    end if;
    if new.assignee_id is distinct from old.assignee_id then
      perform private.record_team_audit(new.team_id, actor, 'task.assigned',
        jsonb_build_object('task_id', new.id, 'task_title', new.title,
                           'to', coalesce(new.assignee_label_snapshot, '')), 'succeeded', null);
    end if;
  end if;
  return null;
end;
$$;
revoke all on function private.audit_team_task_work() from public, anon, authenticated, service_role;

drop trigger if exists team_tasks_audit_work on public.team_tasks;
create trigger team_tasks_audit_work
after insert or update of status, assignee_id on public.team_tasks
for each row execute function private.audit_team_task_work();

create or replace function private.audit_team_task_links()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  title text;
begin
  if actor is null then
    return null;
  end if;
  select task.title into title from public.team_tasks as task where task.id = new.task_id;
  if tg_table_name = 'team_task_attachments' then
    perform private.record_team_audit(new.team_id, actor, 'task.file_attached',
      jsonb_build_object('task_id', new.task_id, 'task_title', title, 'material_id', new.material_id),
      'succeeded', null);
  else
    perform private.record_team_audit(new.team_id, actor, 'task.agent_tagged',
      jsonb_build_object('task_id', new.task_id, 'task_title', title,
                         'agent', private.team_agent_label(new.agent_row_id)),
      'succeeded', null);
  end if;
  return null;
end;
$$;
revoke all on function private.audit_team_task_links() from public, anon, authenticated, service_role;

drop trigger if exists team_task_attachments_audit on public.team_task_attachments;
create trigger team_task_attachments_audit
after insert on public.team_task_attachments
for each row execute function private.audit_team_task_links();

drop trigger if exists team_task_agents_audit on public.team_task_agents;
create trigger team_task_agents_audit
after insert on public.team_task_agents
for each row execute function private.audit_team_task_links();

create or replace function private.audit_team_agent_runs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  run record;
begin
  if actor is null then
    return null;
  end if;
  if tg_op = 'INSERT' then
    run := new;
  else
    run := old;
  end if;
  -- An agent deleted with its runs is not a launch taken off; its own row says what happened.
  if tg_op = 'DELETE' and not exists (
    select 1 from public.team_account_agents as agent where agent.id = run.agent_row_id
  ) then
    return null;
  end if;
  perform private.record_team_audit(run.team_id, actor,
    case when tg_op = 'INSERT' then 'agent.run_added' else 'agent.run_removed' end,
    jsonb_build_object('agent', private.team_agent_label(run.agent_row_id), 'note', run.note),
    'succeeded', null);
  return null;
end;
$$;
revoke all on function private.audit_team_agent_runs() from public, anon, authenticated, service_role;

drop trigger if exists team_agent_runs_audit on public.team_agent_runs;
create trigger team_agent_runs_audit
after insert or delete on public.team_agent_runs
for each row execute function private.audit_team_agent_runs();

create or replace function public.list_team_audit_events(
  p_team uuid,
  p_limit integer default 50,
  -- The caller sends this only when paging, so it must keep its default: a
  -- drop-and-create loses them, and the panel's first read stopped matching any
  -- signature at all.
  p_before timestamptz default null
)
returns table (
  id uuid,
  actor_label text,
  action text,
  target jsonb,
  result text,
  error_code text,
  occurred_at timestamptz,
  subject_label text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller_role text := private.team_role(p_team, auth.uid());
begin
  if caller_role not in ('owner', 'admin') then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  return query
  select event.id,
         event.actor_label_snapshot,
         event.action,
         event.target,
         event.result,
         event.error_code,
         event.occurred_at,
         -- Whichever of the things an entry can be about it actually names: a
         -- file, an invitation's address, a folder. Null when the row is about
         -- the space itself, which needs no subject.
         coalesce(
           (select material.name
            from public.team_materials as material
            where material.team_id = p_team
              and material.id = nullif(event.target->>'material_id', '')::uuid),
           (select invitation.target_email
            from public.team_invitations as invitation
            where invitation.team_id = p_team
              and invitation.id = nullif(event.target->>'invitation_id', '')::uuid),
           -- A stopped job names only the operation; the file it was working on
           -- is one more hop, and it is the whole difference between three
           -- identical "Роботу зупинено" lines and three readable ones.
           (select material.name
            from public.team_operations as operation
            join public.team_materials as material
              on material.id = operation.source_material_id
             and material.team_id = operation.team_id
            where operation.team_id = p_team
              and operation.id = nullif(event.target->>'operation_id', '')::uuid),
           nullif(event.target->>'task_title', ''),
           nullif(event.target->>'agent', ''),
           nullif(event.target->>'name', '')
         )
  from public.team_audit_events as event
  where event.team_id = p_team
    and (p_before is null or event.occurred_at < p_before)
  order by event.occurred_at desc, event.id desc
  limit p_limit;
end;
$$;

revoke all on function public.list_team_audit_events(uuid, integer, timestamptz) from public, anon;
grant execute on function public.list_team_audit_events(uuid, integer, timestamptz) to authenticated;
