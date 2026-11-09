-- Export is restricted to a live registered product catalog and an actor with download access.
create function public.service_catalog_export_allowed(p_team uuid, p_material uuid, p_actor uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.can(p_team, 'view', p_actor) and private.can(p_team, 'download', p_actor)
    and exists(select 1 from private.live_product_catalogs(p_team) c where c.catalog_material_id = p_material);
$$;
revoke all on function public.service_catalog_export_allowed(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.service_catalog_export_allowed(uuid,uuid,uuid) to service_role;
