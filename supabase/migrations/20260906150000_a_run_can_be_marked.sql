-- Feature 017, part 4: a run can be marked.
--
-- The runs on an agent are read down a column, and the one thing the owner
-- could not say about a run was how it is going. A marker is that, in the one
-- gesture a list like this can afford: press the run, and it cycles through
-- green, amber, red and back to unmarked. Three colours, no vocabulary to
-- learn, and the meaning stays the team's own — the product does not name what
-- green is for.
--
-- It lives on the run, not on the agent: an agent carries several runs and
-- they are rarely going the same way.

-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------
alter table public.team_agent_runs add column marker text;

alter table public.team_agent_runs
  add constraint team_agent_runs_marker_value
  check (marker is null or marker in ('green', 'amber', 'red'));

-- ---------------------------------------------------------------------------
-- 2. The JSON an agent is returned as, now carrying the marker
-- ---------------------------------------------------------------------------
create or replace function private.team_agent_runs_json(p_agent uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', run.id,
          'note', run.note,
          'marker', run.marker,
          'created_at', run.created_at
        )
        order by run.created_at, run.id
      )
      from public.team_agent_runs as run
      where run.agent_row_id = p_agent
    ),
    '[]'::jsonb
  );
$$;

revoke all on function private.team_agent_runs_json(uuid)
from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. The write. Like every other run call it returns the whole agent, so the
--    caller replaces one thing and never merges.
-- ---------------------------------------------------------------------------
create function public.set_team_agent_run_marker(p_team uuid, p_run uuid, p_marker text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  clean_marker text := nullif(btrim(coalesce(p_marker, '')), '');
  agent_row uuid;
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if clean_marker is not null and clean_marker not in ('green', 'amber', 'red') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  update public.team_agent_runs as run
  set marker = clean_marker
  where run.id = p_run and run.team_id = p_team
  returning run.agent_row_id into agent_row;
  if agent_row is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  return private.team_agent_json(agent_row);
end;
$$;

revoke all on function public.set_team_agent_run_marker(uuid, uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.set_team_agent_run_marker(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Clearing the whole space at once.
--
-- Marking is cheap and a space accumulates colours; taking them off one press
-- at a time is the work marking saved. What was there is returned, so the
-- caller can offer an undo rather than an apology.
-- ---------------------------------------------------------------------------
create function public.clear_team_agent_run_markers(p_team uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  cleared jsonb;
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  with previous as (
    select run.id, run.marker
    from public.team_agent_runs as run
    where run.team_id = p_team and run.marker is not null
    for update
  ),
  erased as (
    update public.team_agent_runs as run
    set marker = null
    from previous
    where run.id = previous.id
    returning run.id
  )
  select coalesce(
    jsonb_agg(jsonb_build_object('run_id', previous.id, 'marker', previous.marker)),
    '[]'::jsonb
  )
  into cleared
  from previous;

  return cleared;
end;
$$;

revoke all on function public.clear_team_agent_run_markers(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.clear_team_agent_run_markers(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. What a reader sees of the column, and what realtime carries
-- ---------------------------------------------------------------------------
grant select (marker) on table public.team_agent_runs to authenticated;

alter publication supabase_realtime drop table public.team_agent_runs;
alter publication supabase_realtime add table public.team_agent_runs (
  id, team_id, agent_row_id, note, marker, created_at, updated_at
);

comment on column public.team_agent_runs.marker is
  'Feature 017: the run''s marker — green, amber, red, or null for unmarked.';
