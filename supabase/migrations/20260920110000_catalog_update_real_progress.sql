-- Server-owned catalog update progress. Browser timers restarted at step one after every reload,
-- so the updater now reports the stage it is actually executing.

create table private.catalog_update_progress (
  catalog_material_id uuid primary key
    references public.team_catalog_updater_items(catalog_material_id) on delete cascade,
  worker text not null,
  stage text not null,
  updated_at timestamptz not null default now(),
  constraint catalog_update_progress_stage_check
    check (stage in ('preparing', 'refreshing', 'building', 'uploading', 'finalizing'))
);

revoke all on private.catalog_update_progress from public, anon, authenticated;

create function public.service_set_catalog_update_progress(
  p_item uuid, p_worker text, p_stage text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_stage not in ('preparing', 'refreshing', 'building', 'uploading', 'finalizing') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.team_catalog_updater_items as item
    where item.catalog_material_id = p_item
      and item.round_due_at is not null
      and item.lease_owner = p_worker
      and item.lease_expires_at > clock_timestamp()
  ) then return false; end if;

  insert into private.catalog_update_progress (catalog_material_id, worker, stage, updated_at)
  values (p_item, p_worker, p_stage, clock_timestamp())
  on conflict (catalog_material_id) do update
    set worker = excluded.worker, stage = excluded.stage, updated_at = excluded.updated_at;
  return true;
end;
$$;

revoke all on function public.service_set_catalog_update_progress(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.service_set_catalog_update_progress(uuid, text, text)
  to service_role;

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
  folder_drive_id text,
  update_stage text
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
           sheet.parent_folder_id,
           case when item.round_due_at is not null
             then coalesce(progress.stage, 'preparing')
           end
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
    left join private.catalog_update_progress as progress
      on progress.catalog_material_id = live.catalog_material_id
     and progress.worker = item.lease_owner
    order by record.created_at desc;
end;
$$;

revoke all on function public.list_team_product_catalogs(uuid) from public, anon, authenticated;
grant execute on function public.list_team_product_catalogs(uuid) to authenticated;
