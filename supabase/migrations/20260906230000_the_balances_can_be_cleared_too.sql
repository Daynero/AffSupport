-- Feature 019, part 2: the balances can be cleared too.
--
-- The top-ups are cleared once they are paid; the balances go stale for the
-- other reason — a new round starts and last round's figures are noise. One
-- press each, and each says what it took away, so either can be put back.
--
-- Two functions rather than one with a column name in a parameter: a caller
-- that can name the column is a caller that can name the wrong one, and there
-- are exactly two.
create function public.clear_team_agent_balances(p_team uuid)
returns table (agent_row_id uuid, balance integer)
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

  -- Read before the write, as the top-ups are: `RETURNING` would hand back the
  -- nulls we just wrote, and an undo built on that restores nothing.
  return query
  with targets as (
    select agent.id, agent.balance
    from public.team_account_agents as agent
    where agent.team_id = p_team and agent.balance is not null
  ), cleared as (
    update public.team_account_agents as agent
    set balance = null
    from targets
    where agent.id = targets.id
    returning agent.id
  )
  select targets.id, targets.balance from targets;
end;
$$;

revoke all on function public.clear_team_agent_balances(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.clear_team_agent_balances(uuid) to authenticated;
