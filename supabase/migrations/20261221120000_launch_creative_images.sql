-- 062: images of a catalog Launch published as their own public R2 objects.
--
-- An image creative becomes one immutable object c1/<uuid> in the public
-- catalog image bucket, per (space, material, Drive version, content md5),
-- shared between Launches that use the same file. The edge reserves a key,
-- reads Drive, optimizes, writes with If-None-Match:*, verifies the anonymous
-- read and commits the URL. A catalog's uses are confirmed when the catalog
-- is registered (not when column H is written), so a scheduled publication
-- never loses its object to retirement. Without uses an image retires for
-- 6 hours and is then swept (delete, confirm 404, purge CDN) by the existing
-- catalog-images worker, which marks it purged.
begin;

create table private.launch_creative_images (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id),
  material_id uuid not null,
  source_version text not null check (length(source_version) between 1 and 1024),
  source_checksum text not null check (source_checksum ~ '^[0-9a-f]{32}$'),
  object_key text not null unique check (object_key ~ '^c1/[0-9a-f-]{36}$'),
  mime text check (mime in ('image/jpeg', 'image/png')),
  size_bytes integer check (size_bytes between 1 and 8388608),
  state text not null default 'reserved' check (state in ('reserved', 'ready', 'retiring', 'purged', 'failed')),
  url text check (url ~ '^https://[^?#[:space:]]+$'),
  attempt_id uuid not null,
  failure_code text check (failure_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  retire_after timestamptz,
  sweep_lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, team_id),
  foreign key (material_id, team_id) references public.team_materials(id, team_id),
  check (state not in ('ready', 'retiring') or (url is not null and mime is not null and size_bytes is not null)),
  check (url is null or right(url, length(object_key) + 1) = '/' || object_key),
  check ((state = 'failed') = (failure_code is not null)),
  check (state <> 'retiring' or retire_after is not null)
);
create unique index launch_creative_images_live_source
  on private.launch_creative_images(team_id, material_id, source_version, source_checksum)
  where state in ('reserved', 'ready', 'retiring');
create index launch_creative_images_sweep on private.launch_creative_images(retire_after) where state in ('retiring', 'reserved', 'failed');
alter table private.launch_creative_images enable row level security;
alter table private.launch_creative_images force row level security;
revoke all on table private.launch_creative_images from public, anon, authenticated, service_role;
create trigger task_cleanup_reference_fence before insert or update on private.launch_creative_images
  for each row execute function private.guard_task_cleanup_reference();

create table private.launch_creative_image_uses (
  image_id uuid not null,
  catalog_material_id uuid not null,
  team_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (image_id, catalog_material_id),
  foreign key (image_id, team_id) references private.launch_creative_images(id, team_id),
  foreign key (catalog_material_id, team_id) references public.team_materials(id, team_id) on delete cascade
);
create index launch_creative_image_uses_catalog on private.launch_creative_image_uses(catalog_material_id);
alter table private.launch_creative_image_uses enable row level security;
alter table private.launch_creative_image_uses force row level security;
revoke all on table private.launch_creative_image_uses from public, anon, authenticated, service_role;
create trigger task_cleanup_reference_fence before insert or update on private.launch_creative_image_uses
  for each row execute function private.guard_task_cleanup_reference();

alter table private.catalog_publication_target_segments
  add foreign key (image_id) references private.launch_creative_images(id);

-- Images without a use retire; an image that is used again comes back.
create function private.retire_unused_launch_creative_images(p_images uuid[])
returns void language sql security definer set search_path = '' as $$
  update private.launch_creative_images i set state = 'retiring', retire_after = clock_timestamp() + interval '6 hours', updated_at = clock_timestamp()
   where i.id = any(p_images) and i.state = 'ready'
     and not exists (select 1 from private.launch_creative_image_uses u where u.image_id = i.id);
$$;
revoke all on function private.retire_unused_launch_creative_images(uuid[]) from public, anon, authenticated, service_role;

create function private.launch_creative_image_json(i private.launch_creative_images)
returns jsonb language sql immutable set search_path = '' as $$
  select case when i.state in ('ready', 'retiring')
    then jsonb_build_object('state', 'ready', 'id', i.id, 'url', i.url, 'objectKey', i.object_key, 'mime', i.mime, 'sizeBytes', i.size_bytes)
    else jsonb_build_object('state', i.state, 'id', i.id, 'objectKey', i.object_key) end;
$$;
revoke all on function private.launch_creative_image_json(private.launch_creative_images) from public, anon, authenticated, service_role;

-- {state:'ready', id, url, objectKey, mime, sizeBytes} | {state:'reserved', id, objectKey}
create function public.service_reserve_launch_creative_image(p_team uuid, p_material uuid, p_version text, p_checksum text, p_attempt uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare i private.launch_creative_images%rowtype;
begin
  if p_team is null or p_material is null or p_attempt is null or p_version is null or p_checksum !~* '^[0-9a-f]{32}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform 1 from public.team_materials m where m.id = p_material and m.team_id = p_team and m.lifecycle = 'active'
    and m.kind = 'file' and m.category = 'image' and m.drive_version = p_version and lower(m.checksum) = lower(p_checksum);
  if not found then raise exception 'SOURCE_CHANGED' using errcode = '55000'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('launch-creative-image:' || p_team::text || p_material::text, 0));
  select * into i from private.launch_creative_images where team_id = p_team and material_id = p_material
     and source_version = p_version and source_checksum = lower(p_checksum) and state in ('reserved', 'ready', 'retiring') for update;
  if i.id is null then
    insert into private.launch_creative_images(team_id, material_id, source_version, source_checksum, object_key, attempt_id)
    values (p_team, p_material, p_version, lower(p_checksum), 'c1/' || gen_random_uuid()::text, p_attempt) returning * into i;
  elsif i.state = 'retiring' then
    update private.launch_creative_images set state = 'ready', retire_after = null, sweep_lease_until = null, updated_at = clock_timestamp()
     where id = i.id and state = 'retiring' and (sweep_lease_until is null or sweep_lease_until <= clock_timestamp()) returning * into i;
    -- A sweep holds it right now: the object may be going; publish a fresh one.
    if i.id is null then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode = '55000'; end if;
  elsif i.state = 'reserved' and i.sweep_lease_until > clock_timestamp() then
    raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode = '55000';
  elsif i.state = 'reserved' and i.attempt_id <> p_attempt then
    -- A lost attempt hands its reservation on; the key is unchanged and the write is If-None-Match.
    update private.launch_creative_images set attempt_id = p_attempt, updated_at = clock_timestamp() where id = i.id returning * into i;
  end if;
  return private.launch_creative_image_json(i);
end $$;

create function public.service_commit_launch_creative_image(p_id uuid, p_attempt uuid, p_url text, p_mime text, p_size integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare i private.launch_creative_images%rowtype;
begin
  select * into i from private.launch_creative_images where id = p_id for update;
  if i.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if i.state in ('ready', 'retiring') and i.url = p_url and i.mime = p_mime and i.size_bytes = p_size then
    return private.launch_creative_image_json(i);
  end if;
  if i.state <> 'reserved' or i.attempt_id <> p_attempt then raise exception 'WRONG_STATE' using errcode = '55000'; end if;
  if p_url is null or p_url !~ '^https://[^?#[:space:]]+$' or right(p_url, length(i.object_key) + 1) <> '/' || i.object_key
     or p_mime not in ('image/jpeg', 'image/png') or p_size is null or p_size not between 1 and 8388608 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  -- Ready but unused: it retires unless a catalog confirms it within the hold.
  update private.launch_creative_images set state = 'retiring', url = p_url, mime = p_mime, size_bytes = p_size,
    retire_after = clock_timestamp() + interval '6 hours', updated_at = clock_timestamp()
   where id = i.id returning * into i;
  update private.launch_creative_images set state = 'ready', retire_after = null
   where id = i.id and exists (select 1 from private.launch_creative_image_uses u where u.image_id = i.id) returning * into i;
  select * into i from private.launch_creative_images where id = p_id;
  return private.launch_creative_image_json(i);
end $$;

create function public.service_fail_launch_creative_image(p_id uuid, p_attempt uuid, p_code text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_code is null or p_code !~ '^[A-Z][A-Z0-9_]{1,63}$' then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  update private.launch_creative_images set state = 'failed', failure_code = p_code, updated_at = clock_timestamp()
   where id = p_id and state = 'reserved' and attempt_id = p_attempt;
  if not found and not exists (select 1 from private.launch_creative_images where id = p_id and state = 'failed' and attempt_id = p_attempt) then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;
end $$;

-- Set-replace of a catalog's creative image uses. Called when the catalog is registered.
create function public.service_confirm_launch_creative_image_uses(p_catalog uuid, p_images uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare team uuid; released uuid[];
begin
  select c.team_id into team from public.team_product_catalogs c join public.team_materials m on m.id = c.material_id and m.team_id = c.team_id
   where c.material_id = p_catalog and m.lifecycle = 'active' for update of m;
  if team is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p_images is null or cardinality(p_images) > 400 then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  perform 1 from private.launch_creative_images where id = any(p_images) order by id for update;
  if exists (select 1 from unnest(p_images) x(id) left join private.launch_creative_images i on i.id = x.id and i.team_id = team
              where i.id is null or i.state not in ('ready', 'retiring')) then
    raise exception 'SOURCE_CHANGED' using errcode = '55000';
  end if;
  with gone as (
    delete from private.launch_creative_image_uses u where u.catalog_material_id = p_catalog and not (u.image_id = any(p_images)) returning u.image_id
  ) select coalesce(array_agg(image_id), '{}') into released from gone;
  insert into private.launch_creative_image_uses(image_id, catalog_material_id, team_id)
  select distinct x.id, p_catalog, team from unnest(p_images) x(id) on conflict do nothing;
  update private.launch_creative_images set state = 'ready', retire_after = null, updated_at = clock_timestamp()
   where id = any(p_images) and state = 'retiring';
  perform private.retire_unused_launch_creative_images(released);
end $$;

-- Registration confirms the uses the catalog snapshot names (R33): the images
-- listed in _catalogCreatives[].imageId of a new or rewritten snapshot.
create function private.confirm_catalog_creative_image_uses() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if jsonb_typeof(new.settings_snapshot->'_catalogCreatives') is distinct from 'array' then return new; end if;
  insert into private.launch_creative_image_uses(image_id, catalog_material_id, team_id)
  select i.id, new.material_id, new.team_id
    from jsonb_array_elements(new.settings_snapshot->'_catalogCreatives') c
    join private.launch_creative_images i on i.id::text = c->>'imageId' and i.team_id = new.team_id and i.state in ('ready', 'retiring')
  on conflict do nothing;
  update private.launch_creative_images i set state = 'ready', retire_after = null, updated_at = clock_timestamp()
   where i.state = 'retiring' and exists (select 1 from private.launch_creative_image_uses u where u.image_id = i.id and u.catalog_material_id = new.material_id);
  return new;
end $$;
revoke all on function private.confirm_catalog_creative_image_uses() from public, anon, authenticated, service_role;
create trigger confirm_catalog_creative_image_uses after insert or update of settings_snapshot on public.team_product_catalogs
  for each row execute function private.confirm_catalog_creative_image_uses();

-- Objects to delete: retired past their hold with no use, failed or abandoned
-- reservations (a write may have landed). Each row is leased for 10 minutes.
create function public.service_sweep_launch_creative_images(p_limit integer)
returns table(id uuid, object_key text) language plpgsql security definer set search_path = '' as $$
declare released uuid[];
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  -- Uses of catalogs that are no longer active are released first.
  with gone as (
    delete from private.launch_creative_image_uses u
     where not exists (select 1 from public.team_materials m join public.team_product_catalogs c on c.material_id = m.id
                        where m.id = u.catalog_material_id and m.lifecycle = 'active')
    returning u.image_id
  ) select coalesce(array_agg(gone.image_id), '{}') into released from gone;
  perform private.retire_unused_launch_creative_images(released);
  return query
  with picked as (
    select i.id from private.launch_creative_images i
     where (i.sweep_lease_until is null or i.sweep_lease_until <= clock_timestamp())
       and ((i.state = 'retiring' and i.retire_after <= clock_timestamp()
             and not exists (select 1 from private.launch_creative_image_uses u where u.image_id = i.id))
         or (i.state = 'failed' and i.updated_at <= clock_timestamp() - interval '10 minutes')
         or (i.state = 'reserved' and i.updated_at <= clock_timestamp() - interval '24 hours'))
     order by i.retire_after nulls first, i.id limit p_limit for update skip locked
  )
  update private.launch_creative_images i set sweep_lease_until = clock_timestamp() + interval '10 minutes'
    from picked where i.id = picked.id returning i.id, i.object_key;
end $$;

-- The object is gone (404 confirmed, CDN purged).
create function public.service_mark_launch_creative_image_purged(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update private.launch_creative_images i set state = 'purged', sweep_lease_until = null, updated_at = clock_timestamp()
   where i.id = p_id and i.state in ('retiring', 'failed', 'reserved') and i.sweep_lease_until > clock_timestamp()
     and not exists (select 1 from private.launch_creative_image_uses u where u.image_id = i.id);
  if not found and not exists (select 1 from private.launch_creative_images where id = p_id and state = 'purged') then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;
end $$;

do $grants$
declare f text;
begin
  foreach f in array array[
    'public.service_reserve_launch_creative_image(uuid,uuid,text,text,uuid)',
    'public.service_commit_launch_creative_image(uuid,uuid,text,text,integer)',
    'public.service_fail_launch_creative_image(uuid,uuid,text)',
    'public.service_confirm_launch_creative_image_uses(uuid,uuid[])',
    'public.service_sweep_launch_creative_images(integer)',
    'public.service_mark_launch_creative_image_purged(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $grants$;

commit;
