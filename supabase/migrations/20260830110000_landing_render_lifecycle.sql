-- 012 (T013, FR-L1): a trashed landing's preview render must not be served or
-- counted. list_landing_renders joined the material without checking its
-- lifecycle, so an orphaned render stayed 'ready' after the landing went to the
-- trash. The join now requires the material to be active. The render loop
-- already skips trashed materials, so nothing keeps rendering one either.

CREATE OR REPLACE FUNCTION public.list_landing_renders(p_team uuid, p_material_ids uuid[], p_preset text)
 RETURNS TABLE(material_id uuid, render_state text, valid boolean, preset text, segment_count integer, failure_reason text, source_version text, source_checksum text, fingerprint text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  return query
  with projected as (
    select render.*,
           case
             when render.render_state = 'rendering'
               and render.updated_at < pg_catalog.now() - interval '4 minutes'
               then 'failed'
             else render.render_state
           end as effective_render_state,
           case
             when render.render_state = 'rendering'
               and render.updated_at < pg_catalog.now() - interval '4 minutes'
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
   and material.team_id = projected.team_id
   and material.lifecycle = 'active'
  join public.team_drive_connections as connection
    on connection.id = material.connection_id
   and connection.team_id = material.team_id
   and connection.state = 'connected';
end;
$function$
