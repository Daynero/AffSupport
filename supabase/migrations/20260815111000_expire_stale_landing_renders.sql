-- A render is agent-bounded to three minutes.  If the paired app crashes or its
-- failure callback cannot reach the API, a row must not leave the gallery in a
-- perpetual "rendering" state.  Five minutes retains safe headroom while
-- turning abandoned work into an explicit, retryable render error.
with expired as (
  update public.team_landing_renders as render
  set render_state = 'failed',
      failure_reason = 'render_error',
      artifact_root = null,
      segment_count = 0,
      updated_at = pg_catalog.clock_timestamp()
  where render.render_state = 'rendering'
    and render.updated_at < pg_catalog.clock_timestamp() - interval '5 minutes'
  returning render.team_id, render.material_id
)
insert into public.team_catalog_events (team_id, material_id, event_kind)
select expired.team_id, expired.material_id, 'upserted'
from expired;

-- Project the same bounded terminal state for any future interrupted render.
-- This is a read-only, caller-checked projection; retrying the render resets
-- its own service-owned row through service_start_landing_render.
create or replace function public.list_landing_renders(
  p_team uuid,
  p_material_ids uuid[],
  p_preset text
)
returns table (
  material_id uuid,
  render_state text,
  valid boolean,
  preset text,
  segment_count integer,
  failure_reason text,
  source_version text,
  source_checksum text,
  fingerprint text
)
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
  with projected as (
    select render.*,
           case
             when render.render_state = 'rendering'
               and render.updated_at < pg_catalog.now() - interval '5 minutes'
               then 'failed'
             else render.render_state
           end as effective_render_state,
           case
             when render.render_state = 'rendering'
               and render.updated_at < pg_catalog.now() - interval '5 minutes'
               then 'render_error'
             else render.failure_reason
           end as effective_failure_reason
    from public.team_landing_renders as render
    where render.team_id = p_team
      and render.material_id = any (p_material_ids)
      and render.preset = p_preset
  )
  select projected.material_id,
         projected.effective_render_state,
         (
           projected.effective_render_state = 'ready'
           and projected.artifact_root is not null
           and projected.segment_count >= 1
           and projected.source_version is not distinct from material.drive_version
           and projected.source_checksum is not distinct from material.checksum
         ) as valid,
         projected.preset,
         projected.segment_count,
         projected.effective_failure_reason,
         projected.source_version,
         projected.source_checksum,
         projected.fingerprint
  from projected
  join public.team_materials as material
    on material.id = projected.material_id
   and material.team_id = projected.team_id;
end;
$$;

revoke all on function public.list_landing_renders(uuid, uuid[], text)
from public, anon, authenticated, service_role;
grant execute on function public.list_landing_renders(uuid, uuid[], text) to authenticated;
