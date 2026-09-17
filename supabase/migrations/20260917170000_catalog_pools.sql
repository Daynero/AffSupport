-- Feature 024 — a catalog's pictures, names, descriptions and prices come from pools.
--
-- A space's catalog settings were one title, one description, one price and one link to a white
-- picture, so every product row of every catalog was the same product. Meta reads that as one
-- item a hundred times. Now:
--
--   pictures      chosen from the space itself — single images and whole folders of them
--                 (subfolders included) — instead of a pasted link;
--   names/texts   a pool the space keeps: generated in the browser (clothing only), stored here,
--                 readable and editable field by field;
--   price         a range, whole dollars, 9–30 unless set;
--   drawing       random without repeats: a picture or a text used once is not drawn again until
--                 every one in its pool has been, then the pool starts over. The same rule the
--                 re-stitch screens promise, kept here per space and per pool so it survives
--                 across catalogs, updates and workers.
--
-- The single title, description and link stay as what a pool falls back to when it is empty, so
-- they are no longer required. The catalog updater gains "refresh the pictures" (on by default):
-- each scheduled update draws the rows' pictures afresh.
--
-- Forward-only; ROLLBACK.md lists the reverse steps.

-- ---------------------------------------------------------------------------------------------
-- 1. Settings: optional single values, a price range
-- ---------------------------------------------------------------------------------------------
alter table public.team_product_catalog_settings
  alter column title drop not null,
  alter column description drop not null,
  alter column image_link drop not null,
  add column if not exists price_min integer,
  add column if not exists price_max integer;

alter table public.team_product_catalog_settings
  drop constraint if exists team_product_catalog_settings_title_check,
  drop constraint if exists team_product_catalog_settings_description_check,
  drop constraint if exists team_product_catalog_settings_image_link_check,
  drop constraint if exists team_product_catalog_settings_price_range_check;

alter table public.team_product_catalog_settings
  add constraint team_product_catalog_settings_title_check
    check (title is null or (title = btrim(title) and char_length(title) between 1 and 200)),
  add constraint team_product_catalog_settings_description_check
    check (description is null
      or (description = btrim(description) and char_length(description) between 1 and 9999)),
  add constraint team_product_catalog_settings_image_link_check
    check (image_link is null
      or (image_link ~ '^https?://[^[:space:]]+$' and char_length(image_link) <= 2048)),
  add constraint team_product_catalog_settings_price_range_check
    check (
      (price_min is null and price_max is null)
      or (price_min between 1 and 999999 and price_max between 1 and 999999
          and price_min <= price_max)
    );

-- A space that already had one price keeps it, as a range of one.
update public.team_product_catalog_settings
set price_min = price, price_max = price
where price_min is null;

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
  v_image_link text;
  v_min integer;
  v_max integer;
  saved public.team_product_catalog_settings;
begin
  if auth.uid() is null or not private.can(p_team, 'manage_metadata', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_settings is null
     or jsonb_typeof(p_settings) <> 'object'
     or (p_settings - array['title', 'description', 'price', 'imageLink', 'priceMin', 'priceMax'])
        <> '{}'::jsonb
     or jsonb_typeof(coalesce(p_settings -> 'title', '""'::jsonb)) not in ('string', 'null')
     or jsonb_typeof(coalesce(p_settings -> 'description', '""'::jsonb)) not in ('string', 'null')
     or jsonb_typeof(coalesce(p_settings -> 'imageLink', '""'::jsonb)) not in ('string', 'null') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  v_title := nullif(btrim(coalesce(p_settings ->> 'title', '')), '');
  v_description := nullif(btrim(coalesce(p_settings ->> 'description', '')), '');
  v_image_link := nullif(btrim(coalesce(p_settings ->> 'imageLink', '')), '');
  -- An older client sends one price; it is a range of one. Numbers only: "10" as text is refused.
  if jsonb_typeof(p_settings -> 'priceMin') = 'number' and jsonb_typeof(p_settings -> 'priceMax') = 'number'
     and (p_settings ->> 'priceMin') ~ '^[0-9]{1,6}$' and (p_settings ->> 'priceMax') ~ '^[0-9]{1,6}$' then
    v_min := (p_settings ->> 'priceMin')::integer;
    v_max := (p_settings ->> 'priceMax')::integer;
  elsif jsonb_typeof(p_settings -> 'price') = 'number' and (p_settings ->> 'price') ~ '^[0-9]{1,6}$' then
    v_min := (p_settings ->> 'price')::integer;
    v_max := v_min;
  else
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  if (v_title is not null and char_length(v_title) > 200)
     or (v_description is not null and char_length(v_description) > 9999)
     or (v_image_link is not null
         and (v_image_link !~ '^https?://[^[:space:]]+$' or char_length(v_image_link) > 2048))
     or v_min not between 1 and 999999
     or v_max not between 1 and 999999
     or v_min > v_max then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  insert into public.team_product_catalog_settings as settings (
    team_id, title, description, price, price_min, price_max, image_link, updated_by, updated_at
  )
  values (
    p_team, v_title, v_description, v_min, v_min, v_max, v_image_link, auth.uid(),
    pg_catalog.clock_timestamp()
  )
  on conflict (team_id) do update
    set title = excluded.title,
        description = excluded.description,
        price = excluded.price,
        price_min = excluded.price_min,
        price_max = excluded.price_max,
        image_link = excluded.image_link,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
  returning * into saved;
  return saved;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. The picture pool: images and folders of the space
-- ---------------------------------------------------------------------------------------------
create table if not exists public.team_product_catalog_image_sources (
  team_id uuid not null references public.teams(id) on delete cascade,
  material_id uuid not null,
  kind text not null,
  created_at timestamptz not null default now(),
  primary key (team_id, material_id),
  foreign key (material_id, team_id)
    references public.team_materials(id, team_id) on delete cascade,
  constraint team_product_catalog_image_sources_kind_check check (kind in ('file', 'folder'))
);
alter table public.team_product_catalog_image_sources enable row level security;
alter table public.team_product_catalog_image_sources force row level security;

-- Every usable picture a space's sources hold: chosen images, and images anywhere under a chosen
-- folder. Trashed, missing and non-image files are not pictures.
create or replace function private.product_catalog_pool_images(p_team uuid)
returns table (material_id uuid, drive_file_id text, resource_key text, name text)
language sql
stable
security definer
set search_path = ''
as $$
  with recursive folders as (
    select folder.drive_file_id
    from public.team_product_catalog_image_sources as source
    join public.team_materials as folder
      on folder.id = source.material_id and folder.team_id = source.team_id
    where source.team_id = p_team and source.kind = 'folder' and folder.lifecycle = 'active'
    union
    select child.drive_file_id
    from public.team_materials as child
    join folders on child.parent_folder_id = folders.drive_file_id
    where child.team_id = p_team and child.kind = 'folder' and child.lifecycle = 'active'
  )
  select image.id, image.drive_file_id, image.resource_key, image.name
  from public.team_materials as image
  where image.team_id = p_team
    and image.lifecycle = 'active'
    and image.category = 'image'
    and (
      image.parent_folder_id in (select drive_file_id from folders)
      or exists (
        select 1 from public.team_product_catalog_image_sources as source
        where source.team_id = p_team and source.kind = 'file' and source.material_id = image.id
      )
    );
$$;
revoke all on function private.product_catalog_pool_images(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.list_team_product_catalog_image_sources(p_team uuid)
returns table (material_id uuid, kind text, name text, image_count bigint, pool_size bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  pool bigint;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select count(*) into pool from private.product_catalog_pool_images(p_team);
  return query
  select source.material_id, source.kind, material.name,
         case when source.kind = 'folder' then (
           with recursive folders as (
             select material.drive_file_id
             union
             select child.drive_file_id
             from public.team_materials as child
             join folders on child.parent_folder_id = folders.drive_file_id
             where child.team_id = p_team and child.kind = 'folder' and child.lifecycle = 'active'
           )
           select count(*) from public.team_materials as image
           where image.team_id = p_team and image.lifecycle = 'active'
             and image.category = 'image'
             and image.parent_folder_id in (select drive_file_id from folders)
         ) else 1 end,
         pool
  from public.team_product_catalog_image_sources as source
  join public.team_materials as material
    on material.id = source.material_id and material.team_id = source.team_id
  where source.team_id = p_team
  order by source.kind desc, lower(material.name);
end;
$$;

create or replace function public.set_team_product_catalog_image_sources(p_team uuid, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  item jsonb;
  added integer := 0;
begin
  if auth.uid() is null or not private.can(p_team, 'manage_metadata', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 500 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  delete from public.team_product_catalog_image_sources where team_id = p_team;
  for item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(item -> 'materialId') <> 'string'
       or (item ->> 'kind') not in ('file', 'folder') then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    -- A folder picker hands back the folder's Drive id; a file picker its material id. Both do.
    insert into public.team_product_catalog_image_sources (team_id, material_id, kind)
    select p_team, material.id, item ->> 'kind'
    from public.team_materials as material
    where (material.id::text = (item ->> 'materialId') or material.drive_file_id = (item ->> 'materialId'))
      and material.team_id = p_team
      and material.lifecycle = 'active'
      and ((item ->> 'kind') = 'folder') = (material.kind = 'folder')
      and ((item ->> 'kind') = 'folder' or material.category = 'image')
    on conflict do nothing;
    if found then added := added + 1; end if;
  end loop;
  return added;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. The name and description pool
-- ---------------------------------------------------------------------------------------------
create table if not exists public.team_product_catalog_texts (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  position integer not null,
  title text not null,
  description text not null,
  updated_at timestamptz not null default now(),
  constraint team_product_catalog_texts_title_check
    check (title = btrim(title) and char_length(title) between 1 and 200),
  constraint team_product_catalog_texts_description_check
    check (description = btrim(description) and char_length(description) between 1 and 9999)
);
create index if not exists team_product_catalog_texts_team_idx
  on public.team_product_catalog_texts (team_id, position);
alter table public.team_product_catalog_texts enable row level security;
alter table public.team_product_catalog_texts force row level security;

create or replace function public.list_team_product_catalog_texts(p_team uuid)
returns table (id uuid, sort_order integer, title text, description text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
  select text.id, text.position, text.title, text.description
  from public.team_product_catalog_texts as text
  where text.team_id = p_team
  order by text.position, text.id;
end;
$$;

-- The whole pool at once: a generation, or clearing it with an empty array.
create or replace function public.replace_team_product_catalog_texts(p_team uuid, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  item jsonb;
  pos integer := 0;
begin
  if auth.uid() is null or not private.can(p_team, 'manage_metadata', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 1000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  delete from public.team_product_catalog_texts where team_id = p_team;
  delete from private.product_catalog_draws where team_id = p_team and pool = 'text';
  for item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(item -> 'title') <> 'string' or jsonb_typeof(item -> 'description') <> 'string'
       or char_length(btrim(item ->> 'title')) not between 1 and 200
       or char_length(btrim(item ->> 'description')) not between 1 and 9999 then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    pos := pos + 1;
    insert into public.team_product_catalog_texts (team_id, position, title, description)
    values (p_team, pos, btrim(item ->> 'title'), btrim(item ->> 'description'));
  end loop;
  return pos;
end;
$$;

create or replace function public.update_team_product_catalog_text(
  p_team uuid, p_id uuid, p_title text, p_description text
)
returns public.team_product_catalog_texts
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved public.team_product_catalog_texts;
begin
  if auth.uid() is null or not private.can(p_team, 'manage_metadata', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_title, ''))) not between 1 and 200
     or char_length(btrim(coalesce(p_description, ''))) not between 1 and 9999 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update public.team_product_catalog_texts
  set title = btrim(p_title), description = btrim(p_description), updated_at = now()
  where id = p_id and team_id = p_team
  returning * into saved;
  if saved.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  return saved;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. Drawing without repeats
-- ---------------------------------------------------------------------------------------------
create table if not exists private.product_catalog_draws (
  team_id uuid not null references public.teams(id) on delete cascade,
  pool text not null,
  item_id uuid not null,
  drawn_at timestamptz not null default now(),
  primary key (team_id, pool, item_id),
  constraint product_catalog_draws_pool_check check (pool in ('image', 'text'))
);

/*
 * `p_count` picks, in random order, none repeated while the pool still has unused ones; when a
 * pool is spent its record is cleared and drawing goes on from all of it. A catalog of more rows
 * than the pool holds therefore goes round more than once, each round a fresh shuffle.
 */
create or replace function private.draw_product_catalog_items(
  p_team uuid, p_pool text, p_count integer
)
returns setof uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  remaining integer := p_count;
  batch uuid[];
  total integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('product_catalog_draw:' || p_team || p_pool, 0));
  if p_pool = 'image' then
    select count(*) into total from private.product_catalog_pool_images(p_team);
  else
    select count(*) into total from public.team_product_catalog_texts where team_id = p_team;
  end if;
  if total = 0 or p_count < 1 then
    return;
  end if;
  while remaining > 0 loop
    if p_pool = 'image' then
      select array_agg(pool.material_id order by random()) into batch
      from (
        select image.material_id from private.product_catalog_pool_images(p_team) as image
        where not exists (
          select 1 from private.product_catalog_draws as draw
          where draw.team_id = p_team and draw.pool = 'image' and draw.item_id = image.material_id
        )
        order by random()
        limit remaining
      ) as pool;
    else
      select array_agg(pool.id order by random()) into batch
      from (
        select text.id from public.team_product_catalog_texts as text
        where text.team_id = p_team
          and not exists (
            select 1 from private.product_catalog_draws as draw
            where draw.team_id = p_team and draw.pool = 'text' and draw.item_id = text.id
          )
        order by random()
        limit remaining
      ) as pool;
    end if;
    if batch is null or cardinality(batch) = 0 then
      -- Every one has been used: start the pool over.
      delete from private.product_catalog_draws where team_id = p_team and pool = p_pool;
      continue;
    end if;
    insert into private.product_catalog_draws (team_id, pool, item_id)
    select p_team, p_pool, unnest(batch)
    on conflict do nothing;
    return query select unnest(batch);
    remaining := remaining - cardinality(batch);
  end loop;
end;
$$;
revoke all on function private.draw_product_catalog_items(uuid, text, integer)
  from public, anon, authenticated, service_role;

create or replace function public.service_draw_product_catalog_images(p_team uuid, p_count integer)
returns table (material_id uuid, drive_file_id text, resource_key text)
language sql
security definer
set search_path = ''
as $$
  select material.id, material.drive_file_id, material.resource_key
  from private.draw_product_catalog_items(p_team, 'image', p_count) with ordinality as drawn(id, n)
  join public.team_materials as material on material.id = drawn.id
  order by drawn.n;
$$;

create or replace function public.service_draw_product_catalog_texts(p_team uuid, p_count integer)
returns table (title text, description text)
language sql
security definer
set search_path = ''
as $$
  select text.title, text.description
  from private.draw_product_catalog_items(p_team, 'text', p_count) with ordinality as drawn(id, n)
  join public.team_product_catalog_texts as text on text.id = drawn.id
  order by drawn.n;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. The updater refreshes pictures
-- ---------------------------------------------------------------------------------------------
alter table public.team_catalog_updaters
  add column if not exists refresh_images boolean not null default true;

create or replace function public.set_team_catalog_updater_refresh_images(p_team uuid, p_refresh boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  insert into public.team_catalog_updaters (team_id, refresh_images, updated_by, updated_at)
  values (p_team, coalesce(p_refresh, true), auth.uid(), now())
  on conflict (team_id) do update
    set refresh_images = excluded.refresh_images,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;
  return coalesce(p_refresh, true);
end;
$$;

create or replace function public.get_team_catalog_updater_refresh_images(p_team uuid)
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
    (select updater.refresh_images from public.team_catalog_updaters as updater
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
  refresh_images boolean
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
         coalesce(updater.refresh_images, true)
  from private.claim_catalog_updater_items(p_worker, p_limit, p_lease_seconds) as item
  join public.team_product_catalogs as record on record.material_id = item.catalog_material_id
  join public.team_materials as sheet on sheet.id = item.catalog_material_id
  join public.team_drive_connections as connection on connection.id = sheet.connection_id
  left join public.team_catalog_updaters as updater on updater.team_id = item.team_id
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

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
revoke all on function public.set_team_product_catalog_settings(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.list_team_product_catalog_image_sources(uuid)
  from public, anon, authenticated;
revoke all on function public.set_team_product_catalog_image_sources(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.list_team_product_catalog_texts(uuid) from public, anon, authenticated;
revoke all on function public.replace_team_product_catalog_texts(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.update_team_product_catalog_text(uuid, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.service_draw_product_catalog_images(uuid, integer)
  from public, anon, authenticated;
revoke all on function public.service_draw_product_catalog_texts(uuid, integer)
  from public, anon, authenticated;
revoke all on function public.set_team_catalog_updater_refresh_images(uuid, boolean)
  from public, anon, authenticated;
revoke all on function public.get_team_catalog_updater_refresh_images(uuid)
  from public, anon, authenticated;
revoke all on function public.service_claim_catalog_updater_items(text, integer, integer)
  from public, anon, authenticated;

grant execute on function public.set_team_product_catalog_settings(uuid, jsonb) to authenticated;
grant execute on function public.list_team_product_catalog_image_sources(uuid) to authenticated;
grant execute on function public.set_team_product_catalog_image_sources(uuid, jsonb) to authenticated;
grant execute on function public.list_team_product_catalog_texts(uuid) to authenticated;
grant execute on function public.replace_team_product_catalog_texts(uuid, jsonb) to authenticated;
grant execute on function public.update_team_product_catalog_text(uuid, uuid, text, text)
  to authenticated;
grant execute on function public.set_team_catalog_updater_refresh_images(uuid, boolean)
  to authenticated;
grant execute on function public.get_team_catalog_updater_refresh_images(uuid) to authenticated;
grant execute on function public.service_draw_product_catalog_images(uuid, integer) to service_role;
grant execute on function public.service_draw_product_catalog_texts(uuid, integer) to service_role;
grant execute on function public.service_claim_catalog_updater_items(text, integer, integer)
  to service_role;
