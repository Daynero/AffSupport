-- 012 (T014, FR-L2): "Re-generate preview" for a landing. A member with edit
-- rights marks the current render stale; the render loop then rebuilds it, and
-- the next open shows the fresh one. Optimizing a landing already yields its
-- own preview through the fingerprint, so this is for deliberate refreshes.

create or replace function public.request_landing_render_refresh(p_team uuid, p_material uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  if auth.uid() is null or not private.can(p_team, 'edit', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.team_materials as material
    where material.id = p_material
      and material.team_id = p_team
      and material.category = 'landing'
      and material.lifecycle = 'active'
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  update public.team_landing_renders as render
  set render_state = 'stale',
      artifact_root = null,
      segment_count = 0,
      failure_reason = null,
      updated_at = clock_timestamp()
  where render.team_id = p_team
    and render.material_id = p_material
    and render.render_state <> 'stale';
  get diagnostics affected = row_count;
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (p_team, p_material, 'upserted');
  return affected;
end;
$$;

revoke all on function public.request_landing_render_refresh(uuid, uuid) from public, anon;
grant execute on function public.request_landing_render_refresh(uuid, uuid) to authenticated;
