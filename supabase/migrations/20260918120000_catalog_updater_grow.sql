-- Feature 024 US22 — an update can add a few products of its own.
--
-- A catalog that holds the same hundred products for a month is a catalog Meta has seen. With the
-- tick on, every update adds one to five new rows — drawn names, texts, pictures and prices like
-- the rest — up to the 400 a sheet may hold. The worker writes the new count and the new rows back
-- with the completion, so the next update starts from what the sheet now says.
-- Forward-only; ROLLBACK.md drops the column and re-applies the two functions.

alter table public.team_catalog_updaters
  add column if not exists grow_products boolean not null default false;

create or replace function public.set_team_catalog_updater_grow(p_team uuid, p_grow boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  insert into public.team_catalog_updaters (team_id, grow_products, updated_by, updated_at)
  values (p_team, coalesce(p_grow, false), auth.uid(), now())
  on conflict (team_id) do update
    set grow_products = excluded.grow_products,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;
  return coalesce(p_grow, false);
end;
$$;

create or replace function public.get_team_catalog_updater_grow(p_team uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return coalesce(
    (select updater.grow_products from public.team_catalog_updaters as updater
     where updater.team_id = p_team),
    false
  );
end;
$$;

drop function if exists public.service_claim_catalog_updater_items(text, integer, integer);
create function public.service_claim_catalog_updater_items(
  p_worker text, p_limit integer default 10, p_lease_seconds integer default 60
)
returns table (
  catalog_material_id uuid,
  team_id uuid,
  attempts integer,
  update_count integer,
  product_count smallint,
  source_link text,
  video_link text,
  settings_snapshot jsonb,
  drive_file_id text,
  resource_key text,
  credential_id uuid,
  current_video_link text,
  spare_material_id uuid,
  spare_link text,
  refresh_images boolean,
  refresh_texts boolean,
  price_min integer,
  price_max integer,
  grow_products boolean
)
language sql
security definer
set search_path = ''
as $$
  select item.catalog_material_id,
         item.team_id,
         item.attempts,
         record.update_count,
         record.product_count,
         record.source_link,
         record.video_link,
         record.settings_snapshot,
         sheet.drive_file_id,
         sheet.resource_key,
         connection.credential_id,
         record.current_video_link,
         spare.material_id,
         spare.shared_link,
         coalesce(updater.refresh_images, true),
         coalesce(updater.refresh_texts, true),
         settings.price_min,
         settings.price_max,
         coalesce(updater.grow_products, false)
  from private.claim_catalog_updater_items(p_worker, p_limit, p_lease_seconds) as item
  join public.team_product_catalogs as record on record.material_id = item.catalog_material_id
  join public.team_materials as sheet on sheet.id = item.catalog_material_id
  join public.team_drive_connections as connection on connection.id = sheet.connection_id
  left join public.team_catalog_updaters as updater on updater.team_id = item.team_id
  left join public.team_product_catalog_settings as settings on settings.team_id = item.team_id
  left join lateral (
    select copy.material_id, copy.shared_link
    from public.team_catalog_restitch_copies as copy
    join public.team_materials as file on file.id = copy.material_id
    where updater.restitch
      and copy.catalog_material_id = item.catalog_material_id
      and copy.role = 'spare'
      and file.lifecycle = 'active'
  ) as spare on true
  where connection.state in ('connected', 'unavailable');
$$;

/*
 * The completion now carries what the sheet became: its product count and the rows behind it, so a
 * grown catalog does not fall back to the space's single values at the next update. Both are
 * optional — a worker that writes neither leaves the record as it was.
 */
drop function if exists public.service_complete_catalog_update(uuid, text, integer, uuid);
create function public.service_complete_catalog_update(
  p_item uuid,
  p_worker text,
  p_update_count integer,
  p_swapped_copy uuid default null,
  p_product_count integer default null,
  p_settings_snapshot jsonb default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  owning_team uuid;
  swapped public.team_catalog_restitch_copies;
begin
  update public.team_catalog_updater_items as item
     set round_due_at = null,
         attempts = 0,
         lease_owner = null,
         lease_expires_at = null,
         next_attempt_at = clock_timestamp()
   where item.catalog_material_id = p_item
     and item.lease_owner = p_worker
     and item.lease_expires_at > clock_timestamp()
  returning item.team_id into owning_team;
  if owning_team is null then return false; end if;

  update public.team_product_catalogs as record
     set update_count = greatest(record.update_count, p_update_count),
         last_updated_at = clock_timestamp(),
         last_update_error = null,
         product_count = case
           when p_product_count between 1 and 400 then p_product_count::smallint
           else record.product_count
         end,
         settings_snapshot = case
           when p_settings_snapshot is null then record.settings_snapshot
           else p_settings_snapshot
         end
   where record.material_id = p_item
     and p_update_count between record.update_count and record.update_count + 1;

  -- The sheet now points at this copy, whatever happened to it meanwhile: a spare retired by a stop
  -- during the round is brought back rather than deleted from under the sheet.
  if p_swapped_copy is not null then
    select * into swapped from public.team_catalog_restitch_copies as copy
    where copy.material_id = p_swapped_copy and copy.catalog_material_id = p_item
      and copy.role in ('spare', 'retired') and copy.shared_link is not null
    for update;
    if swapped.material_id is not null then
      update public.team_catalog_restitch_copies as copy
         set role = 'retired',
             retired_at = clock_timestamp(),
             next_delete_at = clock_timestamp()
       where copy.catalog_material_id = p_item and copy.role = 'in_use';
      update public.team_catalog_restitch_copies as copy
         set role = 'in_use', retired_at = null, next_delete_at = null
       where copy.material_id = swapped.material_id;
      update public.team_product_catalogs as record
         set current_video_link = swapped.shared_link
       where record.material_id = p_item;
      perform private.queue_restitch_jobs(owning_team);
    end if;
  end if;

  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (owning_team, p_item, 'upserted');
  return true;
end;
$$;

revoke all on function public.set_team_catalog_updater_grow(uuid, boolean)
  from public, anon, authenticated;
revoke all on function public.get_team_catalog_updater_grow(uuid) from public, anon, authenticated;
revoke all on function public.service_claim_catalog_updater_items(text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.service_complete_catalog_update(uuid, text, integer, uuid, integer, jsonb)
  from public, anon, authenticated;

grant execute on function public.set_team_catalog_updater_grow(uuid, boolean) to authenticated;
grant execute on function public.get_team_catalog_updater_grow(uuid) to authenticated;
grant execute on function public.service_claim_catalog_updater_items(text, integer, integer)
  to service_role;
grant execute on function public.service_complete_catalog_update(uuid, text, integer, uuid, integer, jsonb)
  to service_role;
