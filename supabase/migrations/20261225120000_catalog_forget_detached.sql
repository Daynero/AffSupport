-- Production 2026-11-27 (DimSok): a catalog left in the folder the space no longer uses
-- («У попередній папці Drive») could not be removed from the catalog manager: deleting it asks
-- Drive to trash the sheet, Soty has no access to that folder any more, and the person read
-- «У вас немає дозволу на цю дію». The catalog stayed in the list for good.
--
-- `forget_team_detached_catalog` takes such a catalog out of Soty without touching Drive: it is
-- marked removed exactly as the sync marks a sheet deleted on Drive (lifecycle 'missing',
-- reason 'removed'), so its rounds, video sets and R2 copies are released by the same triggers.
-- The sheet itself stays in the old Drive folder. Only a catalog whose connection is detached
-- qualifies — every other catalog is deleted through Drive as before.

create function public.forget_team_detached_catalog(p_team uuid, p_catalog uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  found_catalog record;
begin
  if actor is null or p_team is null or p_catalog is null
     or not private.can(p_team, 'delete', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select material.id, material.lifecycle, connection.state as connection_state
    into found_catalog
  from public.team_materials as material
  join public.team_product_catalogs as record on record.material_id = material.id
  join public.team_drive_connections as connection
    on connection.id = material.connection_id and connection.team_id = material.team_id
  where material.id = p_catalog and material.team_id = p_team
  for update of material;
  if found_catalog.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if found_catalog.connection_state <> 'detached' then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;
  -- Idempotent: a catalog already gone from Soty answers the same.
  if found_catalog.lifecycle = 'active' then
    perform private.tombstone_team_material(p_catalog, 'missing', null);
    update public.team_materials set missing_reason = 'removed' where id = p_catalog;
    perform private.record_team_audit(p_team, actor, 'catalog.forgotten',
      jsonb_build_object('material_id', p_catalog), 'succeeded', null);
  end if;
  return jsonb_build_object('catalogId', p_catalog, 'forgotten', true);
end;
$$;

revoke all on function public.forget_team_detached_catalog(uuid, uuid) from public, anon;
grant execute on function public.forget_team_detached_catalog(uuid, uuid) to authenticated;
