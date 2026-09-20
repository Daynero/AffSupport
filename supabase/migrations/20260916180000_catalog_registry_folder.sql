-- Feature 024 — the catalog registry says which folder each sheet is in.
--
-- "Show in folder" from the updater needs the folder's id to open it; the registry carried only the
-- folder's name, so the action was left out of the row's menu. The sheet's own provider folder id is
-- added as the last column. Forward-only; ROLLBACK.md re-applies 20260916170000's definition.

drop function if exists public.list_team_product_catalogs(uuid);

create function public.list_team_product_catalogs(p_team uuid)
returns table (
  catalog_id uuid,
  name text,
  sheet_url text,
  video_id uuid,
  video_name text,
  folder_name text,
  product_count smallint,
  created_at timestamptz,
  last_updated_at timestamptz,
  update_count integer,
  in_updater boolean,
  last_update_error text,
  update_interval text,
  next_run_at timestamptz,
  update_pending boolean,
  folder_drive_id text
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
    select sheet.id,
           sheet.name,
           record.sheet_url,
           video.id,
           video.name,
           folder.name,
           record.product_count,
           record.created_at,
           record.last_updated_at,
           record.update_count,
           coalesce(item.update_interval is not null, false),
           record.last_update_error,
           item.update_interval,
           item.next_run_at,
           coalesce(item.round_due_at is not null, false),
           sheet.parent_folder_id
    from private.live_product_catalogs(p_team) as live
    join public.team_product_catalogs as record on record.material_id = live.catalog_material_id
    join public.team_materials as sheet on sheet.id = live.catalog_material_id
    join public.team_materials as video on video.id = live.video_material_id
    left join public.team_materials as folder
      on folder.team_id = p_team
     and folder.drive_file_id = video.parent_folder_id
     and folder.kind = 'folder'
     and folder.lifecycle = 'active'
    left join public.team_catalog_updater_items as item
      on item.catalog_material_id = live.catalog_material_id
    order by record.created_at desc;
end;
$$;

revoke all on function public.list_team_product_catalogs(uuid) from public, anon, authenticated;
grant execute on function public.list_team_product_catalogs(uuid) to authenticated;
