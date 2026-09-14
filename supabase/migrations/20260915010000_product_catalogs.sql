-- Feature 022 — a video's product catalog sheet.
--
-- "Create catalog" on a video makes a Google spreadsheet next to it from the owner's Meta
-- catalog template, filled from four values the space keeps. The sheet is the video's
-- companion the way its transcript is, so it is found from the video and follows it.
--
-- "Product catalog" rather than "catalog": in this schema "catalog" already names the index of
-- a space's materials (`team_catalog_events`, catalog-sync), and the two must not be confused.
--
-- What this adds:
--   team_materials_companion_kind_check  admits 'product_catalog' beside 'transcript'
--   team_product_catalog_settings        one set per space, changed by whoever manages it
--   team_product_catalogs                what each sheet was made from
--   five functions                       two settings RPCs, the video's catalog, and the
--                                        service pair the Edge Function reads and links with
--
-- Additive for the released client: the constraint only admits more rows, and nothing that
-- exists reads the new tables. Forward-only; reverse steps in ROLLBACK.md.

-- ---------------------------------------------------------------------------------------------
-- A second kind of companion.
--
-- Every existing reader filters `companion_kind = 'transcript'`, so a catalog row is never
-- taken for a transcript. The one-live-companion index is keyed by kind already, which lets a
-- video hold one transcript and one catalog at once without touching it.
alter table public.team_materials
  drop constraint if exists team_materials_companion_kind_check;
alter table public.team_materials
  add constraint team_materials_companion_kind_check
  check (
    (companion_of is null and companion_kind is null)
    or (companion_of is not null and companion_kind in ('transcript', 'product_catalog'))
  );

-- ---------------------------------------------------------------------------------------------
-- The space's catalog values.
--
-- All four are required together: a catalog needs every one, so a row either answers the
-- question completely or does not exist. "Configured" is simply "there is a row".
create table public.team_product_catalog_settings (
  team_id uuid primary key references public.teams(id) on delete cascade,
  title text not null,
  description text not null,
  -- A whole number of dollars. The sheet writes it as `<price>,00 USD`, the owner's form.
  price integer not null,
  image_link text not null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_product_catalog_settings_title_check
    check (title = btrim(title) and char_length(title) between 1 and 200),
  constraint team_product_catalog_settings_description_check
    check (description = btrim(description) and char_length(description) between 1 and 9999),
  constraint team_product_catalog_settings_price_check
    check (price between 1 and 999999),
  constraint team_product_catalog_settings_image_link_check
    check (image_link ~ '^https?://[^[:space:]]+$' and char_length(image_link) <= 2048)
);

-- ---------------------------------------------------------------------------------------------
-- One row per sheet: what it was made from.
--
-- Which sheet is a video's live catalog is not stored here — that is the active material with
-- `companion_of = video and companion_kind = 'product_catalog'`. A retired sheet keeps its row,
-- and the row goes when the material does.
create table public.team_product_catalogs (
  material_id uuid primary key references public.team_materials(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  video_material_id uuid references public.team_materials(id) on delete set null,
  -- Tracking links run long; 8 KB is far past any real one and still a bound.
  source_link text not null,
  product_count smallint not null,
  sheet_url text not null,
  -- The shared link column Z was built from, before the per-row `?v=` suffix.
  video_link text not null,
  settings_snapshot jsonb not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint team_product_catalogs_source_link_check
    check (source_link ~ '^https?://[^[:space:]]+$' and char_length(source_link) <= 8192),
  constraint team_product_catalogs_product_count_check
    check (product_count between 1 and 400),
  constraint team_product_catalogs_sheet_url_check
    check (sheet_url ~ '^https://[^[:space:]]+$'),
  constraint team_product_catalogs_video_link_check
    check (video_link ~ '^https://[^[:space:]]+$'),
  constraint team_product_catalogs_snapshot_check
    check (jsonb_typeof(settings_snapshot) = 'object')
);

create index team_product_catalogs_video_idx
  on public.team_product_catalogs (team_id, video_material_id);

-- Enabled *and* forced, like every other team table.
alter table public.team_product_catalog_settings enable row level security;
alter table public.team_product_catalog_settings force row level security;
alter table public.team_product_catalogs enable row level security;
alter table public.team_product_catalogs force row level security;

revoke all on public.team_product_catalog_settings from anon, authenticated;
revoke all on public.team_product_catalogs from anon, authenticated;

grant select (team_id, title, description, price, image_link, updated_by, updated_at)
  on public.team_product_catalog_settings to authenticated;
grant select (
  material_id, team_id, video_material_id, source_link, product_count, sheet_url, created_at
) on public.team_product_catalogs to authenticated;

create policy team_product_catalog_settings_select_team
on public.team_product_catalog_settings for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

create policy team_product_catalogs_select_team
on public.team_product_catalogs for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

-- ---------------------------------------------------------------------------------------------
-- Settings, for the browser.

create or replace function public.get_team_product_catalog_settings(p_team uuid)
returns setof public.team_product_catalog_settings
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  -- No row is an answer, not an error: the space has not been configured yet.
  return query
    select settings.*
    from public.team_product_catalog_settings as settings
    where settings.team_id = p_team;
end;
$$;

create or replace function public.set_team_product_catalog_settings(
  p_team uuid,
  p_settings jsonb
)
returns public.team_product_catalog_settings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_title text;
  v_description text;
  v_price text;
  v_image_link text;
  saved public.team_product_catalog_settings;
begin
  -- Changing what a whole space does is a manage_metadata act, as the re-stitch defaults are.
  if auth.uid() is null or not private.can(p_team, 'manage_metadata', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_settings is null
     or jsonb_typeof(p_settings) <> 'object'
     or (p_settings - array['title', 'description', 'price', 'imageLink']) <> '{}'::jsonb
     or jsonb_typeof(p_settings -> 'title') is distinct from 'string'
     or jsonb_typeof(p_settings -> 'description') is distinct from 'string'
     or jsonb_typeof(p_settings -> 'price') is distinct from 'number'
     or jsonb_typeof(p_settings -> 'imageLink') is distinct from 'string' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  v_title := btrim(p_settings ->> 'title');
  v_description := btrim(p_settings ->> 'description');
  v_price := p_settings ->> 'price';
  v_image_link := btrim(p_settings ->> 'imageLink');
  -- A whole number only: `10.5` and `1e3` are refused here rather than rounded.
  if char_length(v_title) not between 1 and 200
     or char_length(v_description) not between 1 and 9999
     or v_price !~ '^[0-9]{1,6}$'
     or v_price::integer not between 1 and 999999
     or v_image_link !~ '^https?://[^[:space:]]+$'
     or char_length(v_image_link) > 2048 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  insert into public.team_product_catalog_settings as settings (
    team_id, title, description, price, image_link, updated_by, updated_at
  )
  values (
    p_team, v_title, v_description, v_price::integer, v_image_link, auth.uid(),
    pg_catalog.clock_timestamp()
  )
  on conflict (team_id) do update
    set title = excluded.title,
        description = excluded.description,
        price = excluded.price,
        image_link = excluded.image_link,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
  returning * into saved;
  return saved;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- A video's live catalog, for anyone who can see the video.

create or replace function public.get_material_product_catalog(p_team uuid, p_video uuid)
returns table (
  id uuid,
  name text,
  drive_file_id text,
  sheet_url text,
  source_link text,
  product_count smallint,
  created_at timestamptz
)
language sql
security definer
set search_path = ''
stable
as $$
  select sheet.id,
         sheet.name,
         sheet.drive_file_id,
         record.sheet_url,
         record.source_link,
         record.product_count,
         record.created_at
  from public.team_materials as sheet
  join public.team_product_catalogs as record on record.material_id = sheet.id
  where sheet.team_id = p_team
    and sheet.companion_of = p_video
    and sheet.companion_kind = 'product_catalog'
    and sheet.lifecycle = 'active'
    and private.can(p_team, 'view', auth.uid())
  order by record.created_at desc
  limit 1;
$$;

-- ---------------------------------------------------------------------------------------------
-- The service pair the Edge Function uses.

create or replace function public.service_get_team_product_catalog_settings(p_team uuid)
returns setof public.team_product_catalog_settings
language sql
security definer
set search_path = ''
stable
as $$
  select settings.*
  from public.team_product_catalog_settings as settings
  where settings.team_id = p_team;
$$;

/*
 * Links a freshly created sheet to its video as the video's product catalog.
 *
 * `p_replaces` is null to create and the live catalog's id to re-create. Whoever arrives second
 * — a create while a catalog exists, or a re-create naming a catalog someone already replaced —
 * does not link: its sheet is marked trashed and returned as `discarded` so the file follows it
 * into Drive's trash, and the catalog that won is returned as `existing`.
 *
 * On a link, the replaced sheet is retired, and every non-active catalog of the video loses its
 * link as well. A sheet someone trashed directly still points at the video; restoring it after a
 * new catalog exists would otherwise collide with the one-live-companion index.
 */
create or replace function public.service_link_product_catalog_companion(
  p_team uuid,
  p_video uuid,
  p_companion uuid,
  p_replaces uuid,
  p_record jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  video_row public.team_materials%rowtype;
  companion_row public.team_materials%rowtype;
  live_row public.team_materials%rowtype;
  v_source_link text := p_record ->> 'sourceLink';
  v_product_count text := p_record ->> 'productCount';
  v_sheet_url text := p_record ->> 'sheetUrl';
  v_video_link text := p_record ->> 'videoLink';
  v_snapshot jsonb := p_record -> 'settingsSnapshot';
  v_created_by uuid;
  retired jsonb;
  existing jsonb;
begin
  if p_record is null
     or jsonb_typeof(p_record) <> 'object'
     or v_source_link is null
     or v_sheet_url is null
     or v_video_link is null
     or v_product_count is null
     or v_product_count !~ '^[0-9]{1,3}$'
     or jsonb_typeof(v_snapshot) is distinct from 'object' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  v_created_by := nullif(p_record ->> 'createdBy', '')::uuid;

  select * into video_row from public.team_materials as material
  where material.id = p_video and material.team_id = p_team and material.lifecycle = 'active'
  for update;
  select * into companion_row from public.team_materials as material
  where material.id = p_companion and material.team_id = p_team and material.lifecycle = 'active'
  for update;
  if video_row.id is null
     or companion_row.id is null
     or video_row.category is distinct from 'video'
     or companion_row.mime_type is distinct from 'application/vnd.google-apps.spreadsheet'
     or companion_row.companion_of is not null then
    return jsonb_build_object(
      'linked', false, 'reason', 'NOT_ELIGIBLE', 'existing', null, 'discarded', null,
      'retired', '[]'::jsonb
    );
  end if;

  select * into live_row from public.team_materials as material
  where material.team_id = p_team
    and material.companion_of = p_video
    and material.companion_kind = 'product_catalog'
    and material.lifecycle = 'active'
  for update;

  if live_row.id is not null and (p_replaces is null or p_replaces <> live_row.id) then
    update public.team_materials as sheet
       set lifecycle = 'trashed',
           trashed_at = pg_catalog.clock_timestamp(),
           updated_at = pg_catalog.clock_timestamp()
     where sheet.id = p_companion and sheet.team_id = p_team;
    select jsonb_build_object(
             'id', live_row.id,
             'name', live_row.name,
             'sheetUrl', record.sheet_url,
             'sourceLink', record.source_link,
             'productCount', record.product_count,
             'createdAt', record.created_at
           )
      into existing
    from public.team_product_catalogs as record
    where record.material_id = live_row.id;
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    values (p_team, p_companion, 'upserted');
    return jsonb_build_object(
      'linked', false,
      'reason', 'EXISTS',
      'existing', existing,
      'discarded', jsonb_build_object(
        'materialId', companion_row.id,
        'driveFileId', companion_row.drive_file_id,
        'resourceKey', companion_row.resource_key
      ),
      'retired', '[]'::jsonb
    );
  end if;

  with retired_rows as (
    update public.team_materials as previous
       set lifecycle = 'trashed',
           trashed_at = pg_catalog.clock_timestamp(),
           companion_of = null,
           companion_kind = null,
           updated_at = pg_catalog.clock_timestamp()
     where previous.team_id = p_team
       and previous.companion_of = p_video
       and previous.companion_kind = 'product_catalog'
       and previous.lifecycle = 'active'
       and previous.id <> p_companion
    returning previous.id, previous.drive_file_id, previous.resource_key
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'materialId', retired_rows.id,
               'driveFileId', retired_rows.drive_file_id,
               'resourceKey', retired_rows.resource_key
             )
           ),
           '[]'::jsonb
         )
    into retired
  from retired_rows;

  update public.team_materials as stale
     set companion_of = null,
         companion_kind = null,
         updated_at = pg_catalog.clock_timestamp()
   where stale.team_id = p_team
     and stale.companion_of = p_video
     and stale.companion_kind = 'product_catalog'
     and stale.lifecycle <> 'active';

  update public.team_materials as sheet
     set companion_of = p_video,
         companion_kind = 'product_catalog',
         updated_at = pg_catalog.clock_timestamp()
   where sheet.id = p_companion and sheet.team_id = p_team;

  insert into public.team_product_catalogs (
    material_id, team_id, video_material_id, source_link, product_count, sheet_url,
    video_link, settings_snapshot, created_by
  )
  values (
    p_companion, p_team, p_video, v_source_link, v_product_count::smallint, v_sheet_url,
    v_video_link, v_snapshot, v_created_by
  )
  on conflict (material_id) do update
    set video_material_id = excluded.video_material_id,
        source_link = excluded.source_link,
        product_count = excluded.product_count,
        sheet_url = excluded.sheet_url,
        video_link = excluded.video_link,
        settings_snapshot = excluded.settings_snapshot,
        created_by = excluded.created_by;

  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (p_team, p_companion, 'upserted'), (p_team, p_video, 'upserted');
  return jsonb_build_object('linked', true, 'retired', retired);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Grants: closed to PUBLIC first, then opened to the role each function was written for.

revoke all on function public.get_team_product_catalog_settings(uuid)
  from public, anon, authenticated;
revoke all on function public.set_team_product_catalog_settings(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.get_material_product_catalog(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.service_get_team_product_catalog_settings(uuid)
  from public, anon, authenticated;
revoke all on function public.service_link_product_catalog_companion(uuid, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;

grant execute on function public.get_team_product_catalog_settings(uuid) to authenticated;
grant execute on function public.set_team_product_catalog_settings(uuid, jsonb) to authenticated;
grant execute on function public.get_material_product_catalog(uuid, uuid) to authenticated;
grant execute on function public.service_get_team_product_catalog_settings(uuid) to service_role;
grant execute on function public.service_link_product_catalog_companion(uuid, uuid, uuid, uuid, jsonb)
  to service_role;
