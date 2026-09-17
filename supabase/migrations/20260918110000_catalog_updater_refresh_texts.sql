-- Feature 025 — an update can draw new names, texts and prices as well as new pictures.
--
-- 024 gave the updater a "refresh pictures" tick. A catalog whose rows keep the same names and
-- the same prices for weeks still reads as the same catalog to Meta, so the same choice is
-- offered for the words: on, the update draws a fresh pair from the space's text pool and a
-- fresh price from its range for every row. The claim carries the flag and the space's price
-- range, so the worker needs no second read.
-- Forward-only; ROLLBACK.md drops the column and re-applies 20260917170000's claim.

alter table public.team_catalog_updaters
  add column if not exists refresh_texts boolean not null default true;

create or replace function public.set_team_catalog_updater_refresh_texts(p_team uuid, p_refresh boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  insert into public.team_catalog_updaters (team_id, refresh_texts, updated_by, updated_at)
  values (p_team, coalesce(p_refresh, true), auth.uid(), now())
  on conflict (team_id) do update
    set refresh_texts = excluded.refresh_texts,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;
  return coalesce(p_refresh, true);
end;
$$;

create or replace function public.get_team_catalog_updater_refresh_texts(p_team uuid)
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
    (select updater.refresh_texts from public.team_catalog_updaters as updater
     where updater.team_id = p_team),
    true
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
  price_max integer
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
         settings.price_max
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

revoke all on function public.set_team_catalog_updater_refresh_texts(uuid, boolean)
  from public, anon, authenticated;
revoke all on function public.get_team_catalog_updater_refresh_texts(uuid)
  from public, anon, authenticated;
revoke all on function public.service_claim_catalog_updater_items(text, integer, integer)
  from public, anon, authenticated;

grant execute on function public.set_team_catalog_updater_refresh_texts(uuid, boolean) to authenticated;
grant execute on function public.get_team_catalog_updater_refresh_texts(uuid) to authenticated;
grant execute on function public.service_claim_catalog_updater_items(text, integer, integer)
  to service_role;
