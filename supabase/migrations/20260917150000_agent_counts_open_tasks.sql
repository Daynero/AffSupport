-- Feature 024 — an agent counts the tasks still open on it.
--
-- "2 tasks" on an agent counted a launch finished last week the same as today's, so a lead
-- handing out capacity was told an agent carried work it no longer did. The count leaves done
-- tasks out; the link still opens every task on the agent. ROLLBACK.md re-applies
-- 20260906220000's definition.

create or replace function private.team_agent_json(p_agent uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', agent.id,
    'account_id', agent.account_id,
    'team_id', agent.team_id,
    'agent_id', agent.agent_id,
    'runs', private.team_agent_runs_json(agent.id),
    'labels', private.team_agent_labels(agent.id),
    'balance', agent.balance,
    'topup', agent.topup,
    'task_count', (
      select count(*)
      from public.team_task_agents as link
      join public.team_tasks as task on task.id = link.task_id and task.team_id = link.team_id
      where link.agent_row_id = agent.id and task.status <> 'done'
    ),
    'created_at', agent.created_at,
    'updated_at', agent.updated_at
  )
  from public.team_account_agents as agent
  where agent.id = p_agent;
$$;
