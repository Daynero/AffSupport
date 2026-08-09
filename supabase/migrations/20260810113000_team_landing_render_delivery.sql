-- Feature 004: service-only render delivery helpers.
--
-- Browser callers continue to use public.list_landing_renders (view-gated). These helpers expose
-- the hidden Drive artifact folder only to the service-role Edge path that mints/consumes opaque
-- transfer grants. No raw Drive id or path is returned to authenticated clients.

create or replace function public.service_get_landing_render_artifact(
  p_team uuid,
  p_material uuid,
  p_preset text
)
returns table (
  render_id uuid,
  artifact_root text,
  segment_count integer,
  source_version text,
  fingerprint text,
  preset text
)
language sql
stable
security definer
set search_path = ''
as $$
  select render.id,
         render.artifact_root,
         render.segment_count,
         render.source_version,
         render.fingerprint,
         render.preset
  from public.team_landing_renders as render
  join public.team_materials as material
    on material.id = render.material_id
   and material.team_id = render.team_id
  where render.team_id = p_team
    and render.material_id = p_material
    and render.preset = p_preset
    and render.render_state = 'ready'
    and render.artifact_root is not null
    and render.segment_count >= 1
    and render.source_version is not distinct from material.drive_version
    and render.source_checksum is not distinct from material.checksum
  limit 1
$$;

revoke all on function public.service_get_landing_render_artifact(uuid, uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.service_get_landing_render_artifact(uuid, uuid, text)
to service_role;

-- Grant consumption already re-checks the actor's current `view` permission. This id-based
-- resolver lets the byte path validate the render bound into that opaque grant without exposing
-- either the render id or the artifact folder to a browser response.
create or replace function public.service_get_landing_render_artifact_by_id(
  p_render uuid,
  p_team uuid,
  p_material uuid
)
returns table (
  render_id uuid,
  artifact_root text,
  segment_count integer,
  source_version text,
  fingerprint text,
  preset text
)
language sql
stable
security definer
set search_path = ''
as $$
  select render.id,
         render.artifact_root,
         render.segment_count,
         render.source_version,
         render.fingerprint,
         render.preset
  from public.team_landing_renders as render
  join public.team_materials as material
    on material.id = render.material_id
   and material.team_id = render.team_id
  where render.id = p_render
    and render.team_id = p_team
    and render.material_id = p_material
    and render.render_state = 'ready'
    and render.artifact_root is not null
    and render.segment_count >= 1
    and render.source_version is not distinct from material.drive_version
    and render.source_checksum is not distinct from material.checksum
  limit 1
$$;

revoke all on function public.service_get_landing_render_artifact_by_id(uuid, uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.service_get_landing_render_artifact_by_id(uuid, uuid, uuid)
to service_role;

create or replace function public.service_get_landing_render_upload(
  p_render uuid,
  p_team uuid,
  p_material uuid
)
returns table (
  render_id uuid,
  preset text,
  source_version text,
  source_checksum text,
  rendered_by uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  select render.id,
         render.preset,
         render.source_version,
         render.source_checksum,
         render.rendered_by
  from public.team_landing_renders as render
  where render.id = p_render
    and render.team_id = p_team
    and render.material_id = p_material
    and render.render_state = 'rendering'
  limit 1
$$;

revoke all on function public.service_get_landing_render_upload(uuid, uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.service_get_landing_render_upload(uuid, uuid, uuid)
to service_role;

-- Resolve and stale rows by provider file id before catalog-sync overwrites/tombstones identity.
-- The Edge worker receives artifact folder ids, trashes them, and never returns them to callers.
create or replace function public.service_invalidate_landing_renders(
  p_connection uuid,
  p_drive_file_ids text[]
)
returns table (
  team_id uuid,
  material_id uuid,
  artifact_root text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with targets as materialized (
    select render.id,
           render.team_id,
           render.material_id,
           render.artifact_root
    from public.team_landing_renders as render
    join public.team_materials as material
      on material.id = render.material_id
     and material.team_id = render.team_id
    where material.connection_id = p_connection
      and material.drive_file_id = any(p_drive_file_ids)
      and render.render_state <> 'stale'
  ), updated as (
    update public.team_landing_renders as render
       set render_state = 'stale',
           artifact_root = null,
           segment_count = 0,
           updated_at = pg_catalog.clock_timestamp()
      from targets
     where render.id = targets.id
    returning targets.team_id, targets.material_id, targets.artifact_root
  ), events as (
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    select distinct updated.team_id, updated.material_id, 'upserted'
    from updated
    returning 1
  )
  select updated.team_id, updated.material_id, updated.artifact_root
  from updated;
end;
$$;

revoke all on function public.service_invalidate_landing_renders(uuid, text[])
from public, anon, authenticated, service_role;
grant execute on function public.service_invalidate_landing_renders(uuid, text[])
to service_role;
