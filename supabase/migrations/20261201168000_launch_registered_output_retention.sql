-- Registration can win cancellation before the final Launch reference is attached.
-- Such workspace catalogs and their videos still belong to the Launch's history.
create index catalog_intents_registered_material on private.catalog_generation_intents(team_id,((result->'catalog'->>'materialId'))) where state='registered';
create or replace function private.launch_output_is_referenced(p_team uuid,p_material uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.team_launch_revision_catalogs where team_id=p_team and (material_id=p_material or restitch_material_id=p_material))
 or exists(select 1 from private.catalog_generation_intents i
  join public.team_launch_generations g on g.team_id=i.team_id and g.actor_id=i.actor_id and i.request_key='launch:'||g.id::text||':catalog'
  join public.team_product_catalogs c on c.team_id=i.team_id and c.material_id=p_material and c.video_material_id=i.video_material_id
  where i.team_id=p_team and i.state='registered' and i.result->'catalog'->>'materialId'=p_material::text)
 or exists(select 1 from public.team_operations o
  join private.catalog_generation_intents i on i.team_id=o.team_id and i.actor_id=o.actor_id and i.request_payload->>'restitchOperationId'=o.id::text and i.state='registered'
  join public.team_launch_generations g on g.team_id=i.team_id and g.actor_id=i.actor_id and i.request_key='launch:'||g.id::text||':catalog'
  join public.team_product_catalogs c on c.team_id=i.team_id and c.material_id::text=i.result->'catalog'->>'materialId' and c.video_material_id=i.video_material_id
  where o.team_id=p_team and o.result_material_id=p_material and o.source_material_id=i.video_material_id and o.state='succeeded');
$$;
