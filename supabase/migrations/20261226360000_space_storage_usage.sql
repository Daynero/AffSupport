-- 057 T052/T053: what an R2 space's storage holds, for the scale and the list (US9, FR-045–FR-047,
-- FR-050, SC-013).
--
-- The ledger (space_storage_usage) already follows every object, catalog feed, catalog video copy
-- (T111) and published creative picture (T104) of an R2 space. What it did not hold, and what no
-- one could read:
--
-- * The space's picture library (045, private.catalog_image_storage — its rows have no FK and
--   carry `team_scope`): an R2 space's pictures now count under `catalogs`, once each and as
--   shared (a picture stays in the library when a catalog that used it is deleted, R9). A Drive
--   space's pictures are charged to the owner's account quota exactly as before; the trigger
--   returns at its first line for them.
-- * A signal: any change of the ledger or of the reservations writes one content-free `usage`
--   row (team_space_storage_signals, already on the space's Realtime channel) per space and
--   transaction, so every open scale reads itself again within a second (SC-013 ≤ 2 s).
-- * Three reads for the member's page (contracts/storage-api.md):
--   - get_space_storage_summary — capacity, used, reserved and the six segments; the segments
--     sum to `usedBytes`, the number admission checks against;
--   - list_space_storage_items — one category's things, biggest first or by date or author,
--     with a search; a catalog is listed whole (its feed, videos, variations, pictures);
--   - get_catalog_storage_breakdown — what a catalog takes, how much of it is shared and stays,
--     and exactly what deleting it frees.
--
-- Pictures from the platform's pool (052) are not the space's bytes: they live in the pool, the
-- space cannot free them and pays nothing for them. They are shown — in a catalog's breakdown as
-- shared, and as `poolBytes` beside the summary — and never added to `usedBytes`, so the scale,
-- the limit and the R2 reconciliation of the space's own prefix stay one number.
--
-- No new table. Drive spaces: nothing they call changes.

-- 1. The picture library of an R2 space ----------------------------------------------------------

-- Lowers a shared amount under catalogs; only ever lowers what is there (as catalog_feed_released).
create function private.space_shared_catalog_uncount(p_team uuid, p_bytes bigint) returns void
language sql security definer set search_path = '' as $$
  update public.space_storage_usage set
    bytes = greatest(bytes - p_bytes, greatest(shared_bytes - p_bytes, 0)),
    shared_bytes = greatest(shared_bytes - p_bytes, 0),
    objects = greatest(objects - 1, 0),
    revision = revision + 1
  where team_id = p_team and category = 'catalogs';
$$;
revoke all on function private.space_shared_catalog_uncount(uuid, bigint) from public, anon, authenticated;

create function private.space_catalog_image_ledger() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not private.space_is_r2(case when tg_op = 'DELETE' then old.team_scope else new.team_scope end) then
    return null;
  end if;
  if tg_op = 'INSERT' then
    if new.charged then
      perform private.space_usage_add(new.team_scope, 'catalogs', new.size_bytes, 1, new.size_bytes);
    end if;
  elsif tg_op = 'UPDATE' then
    if old.charged and not new.charged then
      perform private.space_shared_catalog_uncount(old.team_scope, old.size_bytes);
    elsif new.charged and not old.charged then
      perform private.space_usage_add(new.team_scope, 'catalogs', new.size_bytes, 1, new.size_bytes);
    end if;
  elsif old.charged then
    perform private.space_shared_catalog_uncount(old.team_scope, old.size_bytes);
  end if;
  return null;
end;
$$;
revoke all on function private.space_catalog_image_ledger() from public, anon, authenticated;
create trigger space_catalog_image_ledger after insert or update of charged or delete on private.catalog_image_storage
for each row execute function private.space_catalog_image_ledger();

-- What an R2 space's library already holds (a pilot space may have imported before this).
do $backfill$
declare r record;
begin
  for r in
    select storage.team_scope, storage.size_bytes
    from private.catalog_image_storage storage
    join public.teams team on team.id = storage.team_scope and team.storage_backend = 'r2'
    where storage.charged
    order by storage.team_scope, storage.publication_id
  loop
    perform private.space_usage_add(r.team_scope, 'catalogs', r.size_bytes, 1, r.size_bytes);
  end loop;
end;
$backfill$;

-- 2. A changed ledger says so ---------------------------------------------------------------------

-- One `usage` signal per space and transaction (created_at is the transaction's now()). Never for
-- a space being deleted in the same statement: its row is gone, and the signal's FK would fail.
create function private.space_usage_signal() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.team_space_storage_signals (team_id, kind, folder_id, revision)
  select team.id, 'usage', null, team.content_revision
  from public.teams team
  where team.id in (select distinct changed.team_id from changed)
    and team.storage_backend = 'r2'
    and not exists (
      select 1 from public.team_space_storage_signals signal
      where signal.team_id = team.id and signal.kind = 'usage' and signal.created_at = now());
  return null;
end;
$$;
revoke all on function private.space_usage_signal() from public, anon, authenticated;
create trigger space_storage_usage_signal_insert after insert on public.space_storage_usage
referencing new table as changed for each statement execute function private.space_usage_signal();
create trigger space_storage_usage_signal_update after update on public.space_storage_usage
referencing new table as changed for each statement execute function private.space_usage_signal();
create trigger space_storage_reservations_signal_insert after insert on public.space_storage_reservations
referencing new table as changed for each statement execute function private.space_usage_signal();
create trigger space_storage_reservations_signal_update after update on public.space_storage_reservations
referencing new table as changed for each statement execute function private.space_usage_signal();
create trigger space_storage_reservations_signal_delete after delete on public.space_storage_reservations
referencing old table as changed for each statement execute function private.space_usage_signal();

-- The same body as 20261226150000 with the same rule for its own `usage` row: a commit whose
-- ledger change already said so does not say it twice.
create or replace function private.space_content_changed(p_team uuid, p_folder uuid, p_usage boolean default true) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_revision bigint;
begin
  update public.teams set content_revision = content_revision + 1
  where id = p_team and storage_backend = 'r2'
  returning content_revision into v_revision;
  if v_revision is null then
    raise exception 'STORAGE_BACKEND_MISMATCH' using errcode = '55000';
  end if;
  insert into public.team_space_storage_signals (team_id, kind, folder_id, revision)
  values (p_team, 'content', p_folder, v_revision);
  if p_usage and not exists (
    select 1 from public.team_space_storage_signals signal
    where signal.team_id = p_team and signal.kind = 'usage' and signal.created_at = now()) then
    insert into public.team_space_storage_signals (team_id, kind, folder_id, revision)
    values (p_team, 'usage', null, v_revision);
  end if;
  return v_revision;
end;
$$;

-- 3. Reads ---------------------------------------------------------------------------------------

-- The pool pictures the space's live catalogs show: platform bytes, never the space's.
create function private.space_pool_bytes(p_team uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(image.size_bytes), 0)::bigint
  from private.catalog_global_images image
  where image.id in (
    select assignment.image_id
    from private.catalog_global_assignments assignment
    join private.catalog_global_identities identity on identity.id = assignment.catalog_id
    join public.team_product_catalogs catalog on catalog.material_id = identity.material_id
    where catalog.team_id = p_team and assignment.state = 'confirmed');
$$;
revoke all on function private.space_pool_bytes(uuid) from public, anon, authenticated;

create function public.get_space_storage_summary(p_team uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_capacity bigint;
  v_used bigint;
  v_reserved bigint;
begin
  perform private.require_space_actor(p_team, auth.uid(), 'view');
  v_capacity := private.space_capacity_bytes(p_team);
  v_used := private.space_used_bytes(p_team);
  v_reserved := private.space_reserved_bytes(p_team);
  return jsonb_build_object(
    'teamId', p_team,
    'capacityBytes', v_capacity::text,
    'usedBytes', v_used::text,
    'reservedBytes', v_reserved::text,
    'freeBytes', greatest(v_capacity - v_used - v_reserved, 0)::text,
    'poolBytes', private.space_pool_bytes(p_team)::text,
    'revision', coalesce((select sum(usage.revision) from public.space_storage_usage usage
                          where usage.team_id = p_team), 0)::bigint,
    'segments', (
      select jsonb_agg(jsonb_build_object(
          'category', category.name,
          'bytes', coalesce(usage.bytes, 0)::text,
          'objects', coalesce(usage.objects, 0),
          'sharedBytes', coalesce(usage.shared_bytes, 0)::text) order by category.ordinal)
      from unnest(array['materials', 'catalogs', 'process', 'attachments', 'versions', 'trash'])
        with ordinality as category(name, ordinal)
      left join public.space_storage_usage usage on usage.team_id = p_team and usage.category = category.name));
end;
$$;

-- What one catalog of an R2 space takes, part by part. `sharedBytes` stays when it is deleted
-- (another catalog, the library or the pool still uses it); `freedBytes` is exactly what goes:
-- its feed, the video copies and pictures only it uses, and its variations (deleted with it,
-- 20261226250000 §11) unless something else refers to their file.
create function private.space_catalog_breakdown(p_team uuid, p_catalog uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with catalog as (
    select c.material_id, c.feed_bytes, c.feed_revision
    from public.team_product_catalogs c
    where c.material_id = p_catalog and c.team_id = p_team
  ),
  feed as (
    select coalesce(sum(case when catalog.feed_revision > 0 then catalog.feed_bytes else 0 end), 0)::bigint as bytes,
           count(*) filter (where catalog.feed_revision > 0)::bigint as items, 0::bigint as shared
    from catalog
  ),
  videos as (
    select coalesce(sum(copy.size_bytes), 0)::bigint as bytes, count(*)::bigint as items,
      coalesce(sum(copy.size_bytes) filter (where exists (
        select 1 from private.catalog_video_r2_uses other
        where other.copy_id = copy.id and other.catalog_material_id <> p_catalog)), 0)::bigint as shared
    from private.catalog_video_r2_copies copy
    where copy.team_id = p_team and copy.state in ('ready', 'retiring') and copy.space_counted
      and copy.id in (select use.copy_id from private.catalog_video_r2_uses use
                      where use.catalog_material_id = p_catalog and use.team_id = p_team)
  ),
  outputs as (
    select distinct variant.output_material_id as material_id
    from private.space_catalog_variant_sets s
    join private.space_catalog_variants variant on variant.set_id = s.id
    where s.catalog_material_id = p_catalog and s.team_id = p_team and s.state <> 'canceled'
      and variant.output_material_id is not null
  ),
  variations as (
    select coalesce(sum(object.byte_size), 0)::bigint as bytes, count(*)::bigint as items,
      coalesce(sum(object.byte_size) filter (where exists (
        select 1 from public.space_object_refs ref
        where ref.object_id = object.id and ref.counted
          and not (ref.owner_kind = 'material' and ref.owner_id in (select material_id from outputs)))), 0)::bigint as shared
    from public.space_objects object
    where object.team_id = p_team and object.state = 'committed'
      and object.id in (select material.space_object_id from public.team_materials material
                        where material.id in (select material_id from outputs) and material.team_id = p_team)
  ),
  pictures as (
    select coalesce(sum(image.size_bytes), 0)::bigint as bytes, count(*)::bigint as items,
      coalesce(sum(image.size_bytes) filter (where exists (
        select 1 from private.launch_creative_image_uses other
        where other.image_id = image.id and other.catalog_material_id <> p_catalog)), 0)::bigint as shared
    from private.launch_creative_images image
    where image.team_id = p_team and image.state in ('ready', 'retiring') and image.space_counted
      and image.id in (select use.image_id from private.launch_creative_image_uses use
                       where use.catalog_material_id = p_catalog and use.team_id = p_team)
  ),
  pool as (
    select coalesce(sum(image.size_bytes), 0)::bigint as bytes, count(*)::bigint as items,
      coalesce(sum(image.size_bytes), 0)::bigint as shared
    from private.catalog_global_images image
    where image.id in (
      select assignment.image_id
      from private.catalog_global_assignments assignment
      join private.catalog_global_identities identity on identity.id = assignment.catalog_id
      where identity.material_id = p_catalog and assignment.state = 'confirmed')
  ),
  parts as (
    select 'feed' as kind, 1 as ordinal, * from feed
    union all select 'videos', 2, * from videos
    union all select 'variations', 3, * from variations
    union all select 'pictures', 4, * from pictures
    union all select 'pool', 5, * from pool
  )
  select case when not exists (select 1 from catalog) then null else jsonb_build_object(
    'catalogId', p_catalog,
    'totalBytes', (select sum(bytes) from parts)::text,
    'sharedBytes', (select sum(shared) from parts)::text,
    'freedBytes', (select sum(bytes - shared) from parts)::text,
    'parts', (select jsonb_agg(jsonb_build_object('kind', kind, 'bytes', bytes::text,
                'sharedBytes', shared::text, 'count', items) order by ordinal) from parts)) end;
$$;
revoke all on function private.space_catalog_breakdown(uuid, uuid) from public, anon, authenticated;

create function public.get_catalog_storage_breakdown(p_catalog uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_team uuid;
begin
  select catalog.team_id into v_team from public.team_product_catalogs catalog where catalog.material_id = p_catalog;
  if v_team is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.require_space_actor(v_team, auth.uid(), 'view');
  return private.space_catalog_breakdown(v_team, p_catalog);
end;
$$;

-- One page of a category's things. `p_cursor` is the offset the previous page returned.
create function public.list_space_storage_items(
  p_team uuid, p_category text, p_sort text default 'size', p_search text default null,
  p_cursor text default null, p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_offset integer;
  v_search text;
  v_rows jsonb;
  v_total integer;
begin
  perform private.require_space_actor(p_team, auth.uid(), 'view');
  if p_category is null or p_category not in ('materials', 'catalogs', 'process', 'attachments', 'versions', 'trash')
     or coalesce(p_sort, '') not in ('size', 'date', 'author')
     or p_limit is null or p_limit not between 1 and 100
     or (p_cursor is not null and p_cursor !~ '^[0-9]{1,6}$')
     or char_length(coalesce(p_search, '')) > 200 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  v_offset := coalesce(p_cursor, '0')::integer;
  v_search := nullif(btrim(coalesce(p_search, '')), '');
  if v_search is not null then
    v_search := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  with items as (
    -- A catalog is one thing: its feed, videos, variations and pictures (US9.3).
    select 'catalog'::text as kind, catalog.material_id as id, material.name,
      (breakdown ->> 'totalBytes')::bigint as bytes, (breakdown ->> 'sharedBytes')::bigint as shared_bytes,
      (breakdown ->> 'freedBytes')::bigint as freed_bytes,
      catalog.created_by as author_id, catalog.created_at as at,
      material.parent_folder_id, null::text as material_kind, null::text as mime_type, material.lifecycle
    from public.team_product_catalogs catalog
    join public.team_materials material on material.id = catalog.material_id and material.team_id = p_team
    cross join lateral (select private.space_catalog_breakdown(p_team, catalog.material_id) as breakdown) b
    where p_category = 'catalogs' and catalog.team_id = p_team
    union all
    -- The library's pictures, as one thing: they are shared by every catalog that draws them.
    select 'library', null, null, sum(storage.size_bytes)::bigint, sum(storage.size_bytes)::bigint, 0::bigint,
      null, max(storage.created_at), null, null, null, null
    from private.catalog_image_storage storage
    where p_category = 'catalogs' and storage.team_scope = p_team and storage.charged
    having count(*) > 0
    union all
    -- A file is counted where its object counts; the material shown is the one that holds it there.
    select 'file', holder.id, holder.name, object.byte_size,
      case when object.usage_shared then object.byte_size else 0 end,
      case when object.usage_shared then 0 else object.byte_size end,
      (select upload.actor_id from public.space_uploads upload
        where upload.object_id = object.id and upload.state = 'committed'
        order by upload.created_at limit 1),
      case when p_category = 'trash' then coalesce(holder.trashed_at, object.created_at) else object.created_at end,
      holder.parent_folder_id, holder.category, holder.mime_type, holder.lifecycle
    from public.space_objects object
    cross join lateral (
      select material.id, material.name, material.parent_folder_id, material.category, material.mime_type,
        material.lifecycle, material.trashed_at
      from public.team_materials material
      where material.space_object_id = object.id and material.team_id = p_team
      order by (private.space_material_category(material.id) = p_category) desc, material.created_at, material.id
      limit 1) holder
    where p_category <> 'catalogs' and object.team_id = p_team and object.kind = 'original'
      and object.state = 'committed' and object.usage_category = p_category
  ),
  named as (
    select items.*, coalesce(profile.display_name, null) as author_name
    from items left join public.profiles profile on profile.id = items.author_id
    where v_search is null or items.name ilike v_search
  ),
  ordered as (
    select named.*, row_number() over (order by
      case when p_sort = 'size' then named.bytes end desc nulls last,
      case when p_sort = 'date' then named.at end desc nulls last,
      case when p_sort = 'author' then lower(named.author_name) end asc nulls last,
      named.bytes desc, named.id) as position,
      count(*) over () as total
    from named
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'kind', ordered.kind, 'id', ordered.id, 'name', ordered.name,
      'bytes', ordered.bytes::text, 'sharedBytes', ordered.shared_bytes::text,
      'freedBytes', ordered.freed_bytes::text,
      'authorId', ordered.author_id, 'authorName', ordered.author_name,
      'at', ordered.at, 'parentFolderId', ordered.parent_folder_id,
      'materialKind', ordered.material_kind, 'mimeType', ordered.mime_type,
      'trashed', ordered.lifecycle is not null and ordered.lifecycle <> 'active') order by ordered.position)
      filter (where ordered.position > v_offset and ordered.position <= v_offset + p_limit), '[]'::jsonb),
    coalesce(max(ordered.total), 0)
    into v_rows, v_total
  from ordered;

  return jsonb_build_object(
    'category', p_category,
    'items', v_rows,
    'total', v_total,
    'nextCursor', case when v_offset + p_limit < v_total then (v_offset + p_limit)::text end);
end;
$$;

revoke all on function public.get_space_storage_summary(uuid) from public, anon;
revoke all on function public.get_catalog_storage_breakdown(uuid) from public, anon;
revoke all on function public.list_space_storage_items(uuid, text, text, text, text, integer) from public, anon;
grant execute on function public.get_space_storage_summary(uuid) to authenticated;
grant execute on function public.get_catalog_storage_breakdown(uuid) to authenticated;
grant execute on function public.list_space_storage_items(uuid, text, text, text, text, integer) to authenticated;
