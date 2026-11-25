-- An ad account is busy or it is free (owner, beta 25.11: "it is either taken or it is not").
--
-- A launch linked to an agent before assignments were recorded was migrated as 'legacy_unknown'
-- (20261206148000) and the agent read as a third state, "availability unconfirmed": shown in the
-- row, in the group head, in the filter as "?", and "Make free" refused it with WRONG_STATE. A
-- linked launch holds the agent however old the link is, so:
--   * the availability reads 'busy' while any such link stands (the counts are unchanged, so a
--     client still tells a confirmed assignment from a carried-over one if it ever needs to);
--   * "Make free" releases those links together with the confirmed ones, as one press, logged as
--     'release_all' with the state each link had.
-- Additive: both functions are replaced in place, signatures and grants unchanged.

create or replace function private.team_agent_availability(p_team uuid, p_agent uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
 select jsonb_build_object(
   'status',
   case
     when n.assigned > 0 or n.legacy > 0
       or exists (select 1 from public.team_agent_runs where team_id = p_team and agent_row_id = p_agent)
     then 'busy'
     else 'free'
   end,
   'assignmentCount', n.assigned,
   'legacyCount', n.legacy)
 from (
   select count(*) filter (where state = 'assigned') assigned,
          count(*) filter (where state = 'legacy_unknown') legacy
   from private.team_launch_assignments
   where team_id = p_team and agent_row_id = p_agent
 ) n;
$$;

create or replace function public.release_team_agent_assignments(
  p_team uuid, p_agent uuid, p_expected_version text, p_key text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  payload jsonb := jsonb_build_array(p_agent, p_expected_version);
  result jsonb;
  replay jsonb;
  a record;
  n integer := 0;
  m integer := 0;
begin
  perform private.launch_access(p_team, 'edit');
  perform private.account_workspace_lock(p_team, auth.uid());
  replay := private.launch_request(p_team, p_key, 'agent-release', payload);
  if replay is not null then return replay; end if;
  if (public.get_team_agent_assignment_state(p_team, p_agent)->>'version') is distinct from p_expected_version then
    raise exception 'LAUNCH_VERSION_CONFLICT' using errcode = 'PT409';
  end if;
  -- Topology lock serializes assignment/manual writers; deterministic launch lock order.
  perform 1 from public.team_launches
   where team_id = p_team
     and id in (select launch_id from private.team_launch_assignments
                 where team_id = p_team and agent_row_id = p_agent and state in ('assigned', 'legacy_unknown'))
   order by id for update;
  for a in
    select * from private.team_launch_assignments
     where team_id = p_team and agent_row_id = p_agent and state in ('assigned', 'legacy_unknown')
     order by launch_id for update
  loop
    update private.team_launch_assignments
       set state = 'released', agent_row_id = null, version = version + 1,
           updated_at = clock_timestamp(), updated_by = auth.uid()
     where launch_id = a.launch_id;
    insert into private.team_launch_assignment_events(
      team_id, launch_id, previous_agent_row_id, state, previous_state, version, actor_id, action, request_key)
    values (p_team, a.launch_id, p_agent, 'released', a.state, a.version + 1, auth.uid(), 'release_all', p_key);
    update public.team_launches
       set aggregate_version = aggregate_version + 1, updated_at = clock_timestamp()
     where id = a.launch_id;
    perform private.launch_signal(p_team, a.launch_id,
      (select aggregate_version from public.team_launches where id = a.launch_id));
    n := n + 1;
  end loop;
  delete from public.team_agent_runs where team_id = p_team and agent_row_id = p_agent;
  get diagnostics m = row_count;
  result := public.get_team_agent_assignment_state(p_team, p_agent)
    || jsonb_build_object('operationId', gen_random_uuid(), 'requestKey', p_key,
                          'releasedCount', n, 'clearedManualCount', m);
  perform private.launch_remember(p_team, p_key, 'agent-release', payload, result);
  return result;
end
$$;
