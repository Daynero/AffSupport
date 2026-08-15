-- A disconnected historical root must be visible as a recovery state, never as
-- a broken landing preview. The boolean deliberately exposes no Drive path,
-- file name, id, or count; it only lets authorised members understand why a
-- gallery can be empty after a root replacement.

create or replace function public.get_team_landing_source_status(p_team uuid)
returns table (has_detached_landing_candidates boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  return query
  select exists (
    select 1
    from public.team_materials as material
    join public.team_drive_connections as connection
      on connection.id = material.connection_id
     and connection.team_id = material.team_id
     and connection.state = 'detached'
    where material.team_id = p_team
      and material.kind = 'file'
      and material.lifecycle = 'active'
      and material.category in ('archive', 'landing')
  );
end;
$$;

revoke all on function public.get_team_landing_source_status(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.get_team_landing_source_status(uuid) to authenticated;

comment on function public.get_team_landing_source_status(uuid) is
  'Caller-checked, content-free recovery signal for landing candidates in detached Drive roots.';
