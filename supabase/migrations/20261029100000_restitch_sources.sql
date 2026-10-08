-- 030 — re-stitch images from the space instead of the server, release B.
--
-- A space's start and end pictures are no longer copies of the owner's local library in a
-- server bucket. They are *sources* of the connected Drive (image files and folders), kept
-- as references in `team_restitch_sources`, resolved into an effective set at read time, and
-- drawn one per slot per job by the server. The member's agent fetches only the drawn picture
-- through the ordinary download grant. Nothing here ever stores image bytes.
--
-- Additive for the released desktop app: rows written before this migration keep
-- `source_mode = 'legacy'` and the id lists they had. Forward-only; reverse steps in ROLLBACK.md.

-- ---------------------------------------------------------------------------------------------
-- 1. Which way a space's settings point.
-- ---------------------------------------------------------------------------------------------

alter table public.team_restitch_defaults
  add column if not exists source_mode text not null default 'legacy'
    constraint team_restitch_defaults_source_mode_check check (source_mode in ('legacy', 'drive'));
alter table public.team_member_restitch_preferences
  add column if not exists source_mode text not null default 'legacy'
    constraint team_member_restitch_preferences_source_mode_check
      check (source_mode in ('legacy', 'drive'));
grant select (source_mode) on public.team_restitch_defaults to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. The sources. `user_id` null is the space's pool (the owner writes it); a user id is that
--    member's personal pool. Exactly one of `material_id` / `drive_file_id` is set: the second
--    is a folder the owner just made (the legacy transfer) that the catalog has not indexed yet.
-- ---------------------------------------------------------------------------------------------

create table public.team_restitch_sources (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  slot text not null constraint team_restitch_sources_slot_check check (slot in ('start', 'end')),
  material_id uuid references public.team_materials(id) on delete cascade,
  drive_file_id text,
  kind text not null constraint team_restitch_sources_kind_check check (kind in ('file', 'folder')),
  sort_order integer not null default 0,
  added_by uuid references auth.users(id) on delete set null,
  added_at timestamptz not null default now(),
  constraint team_restitch_sources_one_reference
    check ((material_id is null) <> (drive_file_id is null)),
  constraint team_restitch_sources_pending_is_folder
    check (drive_file_id is null or kind = 'folder')
);
create unique index team_restitch_sources_unique_idx on public.team_restitch_sources (
  team_id, slot,
  coalesce(material_id::text, drive_file_id),
  coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid)
);
create index team_restitch_sources_team_idx on public.team_restitch_sources (team_id, slot);

alter table public.team_restitch_sources enable row level security;
alter table public.team_restitch_sources force row level security;
revoke all on public.team_restitch_sources from public, anon, authenticated;
grant select (team_id, user_id, slot, material_id, drive_file_id, kind, sort_order)
  on public.team_restitch_sources to authenticated;
create policy team_restitch_sources_select_team
on public.team_restitch_sources for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

-- ---------------------------------------------------------------------------------------------
-- 3. What counts as a picture the agent will stitch: the three formats it decodes, a real
--    size under its own ceiling, a matching extension, and an md5 to key the cache on.
-- ---------------------------------------------------------------------------------------------

create or replace function private.restitch_image_ok(
  p_mime text, p_size bigint, p_name text, p_checksum text
)
returns boolean language sql immutable set search_path = '' as $$
  select p_mime in ('image/png', 'image/jpeg', 'image/webp')
     and p_size is not null and p_size between 1 and 52428800
     and lower(p_name) ~ '\.(png|jpe?g|webp)$'
     and p_checksum is not null and p_checksum <> '';
$$;
revoke all on function private.restitch_image_ok(text, bigint, text, text)
  from public, anon, authenticated, service_role;

-- A source chosen by Drive id becomes a material reference the moment the catalog knows it.
create or replace function private.resolve_restitch_pending(p_team uuid)
returns void language sql security definer set search_path = '' as $$
  update public.team_restitch_sources as source
     set material_id = material.id, drive_file_id = null
    from public.team_materials as material
   where source.team_id = p_team and source.drive_file_id is not null
     and material.team_id = p_team and material.drive_file_id = source.drive_file_id
     and material.kind = 'folder' and material.lifecycle = 'active'
     and not exists (
       select 1 from public.team_restitch_sources as twin
       where twin.team_id = source.team_id and twin.slot = source.slot
         and twin.material_id = material.id
         and twin.user_id is not distinct from source.user_id
     );
$$;
revoke all on function private.resolve_restitch_pending(uuid)
  from public, anon, authenticated, service_role;

-- The effective set of one pool: folders unfolded recursively, files judged by the rule
-- above, one row per distinct md5, in a stable order. Unbounded here; callers cut at 500.
create or replace function private.restitch_pool_images(p_team uuid, p_user uuid, p_slot text)
returns table (
  material_id uuid, drive_file_id text, resource_key text, name text,
  checksum text, mime_type text, size_bytes bigint, drive_version text
)
language sql stable security definer set search_path = '' as $$
  with recursive connection as (
    select id from public.team_drive_connections
    where team_id = p_team and state = 'connected'
  ), folders as (
    select folder.drive_file_id
    from public.team_restitch_sources as source
    join public.team_materials as folder
      on folder.id = source.material_id and folder.team_id = source.team_id
    where source.team_id = p_team and source.slot = p_slot and source.kind = 'folder'
      and source.user_id is not distinct from p_user
      and folder.lifecycle = 'active' and folder.connection_id in (select id from connection)
    union
    select child.drive_file_id
    from public.team_materials as child
    join folders on child.parent_folder_id = folders.drive_file_id
    where child.team_id = p_team and child.kind = 'folder' and child.lifecycle = 'active'
  ), candidates as (
    select image.id, image.drive_file_id, image.resource_key, image.name, image.checksum,
           image.mime_type, image.size_bytes, image.drive_version
    from public.team_materials as image
    where image.team_id = p_team and image.lifecycle = 'active' and image.kind = 'file'
      and image.category = 'image'
      and image.connection_id in (select id from connection)
      and private.restitch_image_ok(image.mime_type, image.size_bytes, image.name, image.checksum)
      and (
        image.parent_folder_id in (select drive_file_id from folders)
        or exists (
          select 1 from public.team_restitch_sources as source
          where source.team_id = p_team and source.slot = p_slot and source.kind = 'file'
            and source.material_id = image.id and source.user_id is not distinct from p_user
        )
      )
  ), unique_bytes as (
    select distinct on (checksum) *
    from candidates
    order by checksum, lower(name), id
  )
  select id, drive_file_id, resource_key, name, checksum, mime_type, size_bytes, drive_version
  from unique_bytes
  order by lower(name), id;
$$;
revoke all on function private.restitch_pool_images(uuid, uuid, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. Reading a pool as the panel shows it: every source with its availability and counts,
--    and the pool's state. Volatile only because it resolves pending folders on the way.
-- ---------------------------------------------------------------------------------------------

create or replace function private.restitch_pool_json(p_team uuid, p_user uuid, p_slot text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_connection uuid;
  v_sources jsonb;
  v_eligible integer;
  v_total integer;
  v_all_available boolean;
begin
  select id into v_connection from public.team_drive_connections
   where team_id = p_team and state = 'connected';
  select count(*) into v_total from private.restitch_pool_images(p_team, p_user, p_slot);
  v_eligible := least(v_total, 500);

  select coalesce(jsonb_agg(entry.item order by entry.sort_order, entry.added_at), '[]'::jsonb),
         coalesce(bool_and(entry.item ->> 'availability' = 'available'), true)
    into v_sources, v_all_available
  from (
    select source.sort_order, source.added_at, jsonb_build_object(
      'materialId', source.material_id,
      'driveFileId', source.drive_file_id,
      'kind', source.kind,
      'name', coalesce(material.name, source.drive_file_id, ''),
      'availability', case
        when source.drive_file_id is not null then 'pending'
        when v_connection is null then 'disconnected'
        when material.connection_id <> v_connection then 'out_of_root'
        when material.lifecycle = 'trashed' then 'trashed'
        when material.lifecycle = 'missing' and material.missing_reason = 'out_of_root' then 'out_of_root'
        when material.lifecycle = 'missing' then 'missing'
        when source.kind = 'file' and not private.restitch_image_ok(
          material.mime_type, material.size_bytes, material.name, material.checksum) then 'unsupported'
        else 'available' end,
      'imageCount', case
        when source.drive_file_id is not null or v_connection is null
          or material.lifecycle <> 'active' or material.connection_id <> v_connection then 0
        when source.kind = 'file' then case when private.restitch_image_ok(
          material.mime_type, material.size_bytes, material.name, material.checksum) then 1 else 0 end
        else (
          with recursive folders as (
            select material.drive_file_id
            union
            select child.drive_file_id from public.team_materials as child
            join folders on child.parent_folder_id = folders.drive_file_id
            where child.team_id = p_team and child.kind = 'folder' and child.lifecycle = 'active'
          )
          select count(*) from public.team_materials as image
          where image.team_id = p_team and image.lifecycle = 'active' and image.kind = 'file'
            and image.category = 'image' and image.parent_folder_id in (select drive_file_id from folders)
            and private.restitch_image_ok(image.mime_type, image.size_bytes, image.name, image.checksum)
        ) end,
      'skipped', case
        when source.drive_file_id is not null or v_connection is null
          or material.lifecycle <> 'active' or material.connection_id <> v_connection
          then jsonb_build_object('format', 0, 'size', 0, 'animated', 0)
        when source.kind = 'file' then jsonb_build_object(
          'format', case when material.mime_type not in ('image/png', 'image/jpeg', 'image/webp')
            or lower(material.name) !~ '\.(png|jpe?g|webp)$' then 1 else 0 end,
          'size', case when material.size_bytes is null or material.size_bytes not between 1 and 52428800
            then 1 else 0 end,
          'animated', case when material.mime_type in ('image/gif', 'image/apng') then 1 else 0 end)
        else (
          with recursive folders as (
            select material.drive_file_id
            union
            select child.drive_file_id from public.team_materials as child
            join folders on child.parent_folder_id = folders.drive_file_id
            where child.team_id = p_team and child.kind = 'folder' and child.lifecycle = 'active'
          ), images as (
            select image.* from public.team_materials as image
            where image.team_id = p_team and image.lifecycle = 'active' and image.kind = 'file'
              and image.category = 'image' and image.parent_folder_id in (select drive_file_id from folders)
          )
          select jsonb_build_object(
            'format', count(*) filter (where mime_type not in ('image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/apng')
              or (mime_type in ('image/png', 'image/jpeg', 'image/webp') and lower(name) !~ '\.(png|jpe?g|webp)$')),
            'size', count(*) filter (where mime_type in ('image/png', 'image/jpeg', 'image/webp')
              and lower(name) ~ '\.(png|jpe?g|webp)$'
              and (size_bytes is null or size_bytes not between 1 and 52428800)),
            'animated', count(*) filter (where mime_type in ('image/gif', 'image/apng')))
          from images
        ) end
    ) as item
    from public.team_restitch_sources as source
    left join public.team_materials as material
      on material.id = source.material_id and material.team_id = source.team_id
    where source.team_id = p_team and source.slot = p_slot
      and source.user_id is not distinct from p_user
  ) as entry;

  return jsonb_build_object(
    'state', case
      when v_eligible = 0 then 'empty'
      when v_all_available then 'ready'
      else 'partial' end,
    'overLimit', v_total > 500,
    'eligibleCount', v_eligible,
    'sources', v_sources
  );
end;
$$;
revoke all on function private.restitch_pool_json(uuid, uuid, text)
  from public, anon, authenticated, service_role;

create or replace function private.restitch_listing_json(p_team uuid, p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_mode text;
  v_legacy integer;
begin
  perform private.resolve_restitch_pending(p_team);
  if p_user is null then
    select source_mode, cardinality(start_image_ids) + cardinality(end_image_ids)
      into v_mode, v_legacy
      from public.team_restitch_defaults where team_id = p_team;
  else
    select source_mode, cardinality(start_image_ids) + cardinality(end_image_ids)
      into v_mode, v_legacy
      from public.team_member_restitch_preferences where team_id = p_team and user_id = p_user;
  end if;
  return jsonb_build_object(
    'sourceMode', coalesce(v_mode, 'legacy'),
    'legacyImageCount', coalesce(v_legacy, 0),
    'pools', jsonb_build_object(
      'start', private.restitch_pool_json(p_team, p_user, 'start'),
      'end', private.restitch_pool_json(p_team, p_user, 'end')
    )
  );
end;
$$;
revoke all on function private.restitch_listing_json(uuid, uuid)
  from public, anon, authenticated, service_role;

-- `p_scope`: 'owner' is the space's pool, 'self' the caller's personal pool.
create or replace function public.list_restitch_sources(p_team uuid, p_scope text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'RESTITCH_FORBIDDEN' using errcode = '42501';
  end if;
  if p_scope not in ('owner', 'self') then
    raise exception 'RESTITCH_INVALID' using errcode = '22023';
  end if;
  return private.restitch_listing_json(
    p_team, case when p_scope = 'self' then auth.uid() else null end);
end;
$$;
revoke all on function public.list_restitch_sources(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_restitch_sources(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. Writing a pool. The whole slot is replaced, as the catalog pools are; the settings row
--    flips to `drive` and its legacy id lists are emptied, so nothing old can be misread.
-- ---------------------------------------------------------------------------------------------

create or replace function private.replace_restitch_sources(
  p_team uuid, p_user uuid, p_slot text, p_items jsonb
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  item jsonb;
  position integer := 0;
  v_material public.team_materials;
  v_drive_id text;
begin
  if p_slot not in ('start', 'end') then
    raise exception 'RESTITCH_INVALID' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'RESTITCH_SOURCES_INVALID' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > 500 then
    raise exception 'RESTITCH_SOURCES_TOO_MANY' using errcode = '22023';
  end if;
  delete from public.team_restitch_sources
   where team_id = p_team and slot = p_slot and user_id is not distinct from p_user;
  for item in select value from jsonb_array_elements(p_items) loop
    position := position + 1;
    if jsonb_typeof(item -> 'materialId') = 'string' then
      select * into v_material from public.team_materials
       where id::text = (item ->> 'materialId') and team_id = p_team;
      if v_material.id is null or v_material.lifecycle <> 'active'
         or v_material.kind not in ('file', 'folder')
         or (v_material.kind = 'file' and v_material.category is distinct from 'image') then
        raise exception 'RESTITCH_SOURCES_INVALID' using errcode = '22023';
      end if;
      insert into public.team_restitch_sources
        (team_id, user_id, slot, material_id, kind, sort_order, added_by)
      values (p_team, p_user, p_slot, v_material.id,
              case when v_material.kind = 'folder' then 'folder' else 'file' end,
              position, auth.uid())
      on conflict do nothing;
    elsif jsonb_typeof(item -> 'driveFileId') = 'string' and (item ->> 'kind') = 'folder' then
      v_drive_id := item ->> 'driveFileId';
      if v_drive_id = '' or length(v_drive_id) > 256 then
        raise exception 'RESTITCH_SOURCES_INVALID' using errcode = '22023';
      end if;
      -- Already indexed: reference the material, not the id.
      select * into v_material from public.team_materials
       where team_id = p_team and drive_file_id = v_drive_id and kind = 'folder'
         and lifecycle = 'active';
      if v_material.id is not null then
        insert into public.team_restitch_sources
          (team_id, user_id, slot, material_id, kind, sort_order, added_by)
        values (p_team, p_user, p_slot, v_material.id, 'folder', position, auth.uid())
        on conflict do nothing;
      else
        insert into public.team_restitch_sources
          (team_id, user_id, slot, drive_file_id, kind, sort_order, added_by)
        values (p_team, p_user, p_slot, v_drive_id, 'folder', position, auth.uid())
        on conflict do nothing;
      end if;
    else
      raise exception 'RESTITCH_SOURCES_INVALID' using errcode = '22023';
    end if;
  end loop;
end;
$$;
revoke all on function private.replace_restitch_sources(uuid, uuid, text, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.set_restitch_sources(p_team uuid, p_slot text, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.teams where id = p_team and owner_id = auth.uid()
  ) then
    raise exception 'RESTITCH_FORBIDDEN' using errcode = '42501';
  end if;
  perform private.replace_restitch_sources(p_team, null, p_slot, p_items);
  insert into public.team_restitch_defaults as d (
    team_id, source_mode, start_image_ids, end_image_ids, configured, updated_by, updated_at
  ) values (p_team, 'drive', '{}', '{}', true, auth.uid(), clock_timestamp())
  on conflict (team_id) do update set
    source_mode = 'drive', start_image_ids = '{}', end_image_ids = '{}', configured = true,
    updated_by = excluded.updated_by, updated_at = clock_timestamp();
  return private.restitch_listing_json(p_team, null);
end;
$$;
revoke all on function public.set_restitch_sources(uuid, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.set_restitch_sources(uuid, text, jsonb) to authenticated;

create or replace function public.set_member_restitch_sources(p_team uuid, p_slot text, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) or
     exists (select 1 from public.teams where id = p_team and owner_id = auth.uid()) then
    raise exception 'RESTITCH_FORBIDDEN' using errcode = '42501';
  end if;
  perform private.replace_restitch_sources(p_team, auth.uid(), p_slot, p_items);
  insert into public.team_member_restitch_preferences as preference (
    team_id, user_id, use_owner, source_mode, start_image_ids, end_image_ids, configured, updated_at
  ) values (p_team, auth.uid(), false, 'drive', '{}', '{}', true, clock_timestamp())
  on conflict (team_id, user_id) do update set
    use_owner = false, source_mode = 'drive', start_image_ids = '{}', end_image_ids = '{}',
    configured = true, updated_at = clock_timestamp();
  return private.restitch_listing_json(p_team, auth.uid());
end;
$$;
revoke all on function public.set_member_restitch_sources(uuid, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.set_member_restitch_sources(uuid, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 6. The settings writers learn `sourceMode`. In `drive` mode the id lists are ignored and the
--    "no screens" refusal does not apply: the pools decide that at read time.
-- ---------------------------------------------------------------------------------------------

create or replace function public.set_restitch_defaults(p_team uuid, p_defaults jsonb)
returns public.team_restitch_defaults language plpgsql security definer set search_path = '' as $$
declare
  v_operation text := coalesce(p_defaults ->> 'operation', 'restitch');
  v_fit text := coalesce(p_defaults ->> 'fitMode', 'cover');
  v_mode text := coalesce(p_defaults ->> 'finalDurationMode', 'random-40-50');
  v_custom integer := coalesce((p_defaults ->> 'customFinalDurationSeconds')::integer, 2700);
  v_start_enabled boolean := coalesce((p_defaults ->> 'startEnabled')::boolean, true);
  v_end_enabled boolean := coalesce((p_defaults ->> 'endEnabled')::boolean, true);
  v_start_mode text := coalesce(p_defaults ->> 'startDurationMode', 'one-frame');
  v_start_ms integer := coalesce((p_defaults ->> 'customStartDurationMs')::integer, 100);
  v_source_mode text := coalesce(p_defaults ->> 'sourceMode', 'legacy');
  v_start uuid[] := coalesce((select array_agg(value::uuid)
    from jsonb_array_elements_text(p_defaults -> 'startImageIds')), '{}');
  v_end uuid[] := coalesce((select array_agg(value::uuid)
    from jsonb_array_elements_text(p_defaults -> 'endImageIds')), '{}');
  saved public.team_restitch_defaults;
begin
  if auth.uid() is null or not exists (
    select 1 from public.teams where id = p_team and owner_id = auth.uid()
  ) then
    raise exception 'RESTITCH_FORBIDDEN' using errcode = '42501';
  end if;
  if v_operation not in ('restitch', 'stitch', 'unstitch')
     or v_fit not in ('cover', 'contain', 'stretch')
     or v_mode not in ('random-30-40', 'random-40-50', 'random-50-60', 'custom')
     or v_custom not between 1 and 359999
     or v_start_mode not in ('one-frame', 'ms-2', 'ms-5', 'ms-10', 'custom')
     or v_start_ms not between 1 and 60000
     or v_source_mode not in ('legacy', 'drive') then
    raise exception 'RESTITCH_INVALID' using errcode = '22023';
  end if;
  if v_source_mode = 'drive' then
    v_start := '{}'; v_end := '{}';
  elsif v_operation <> 'unstitch' and
     (not v_start_enabled or cardinality(v_start) = 0) and
     (not v_end_enabled or cardinality(v_end) = 0) then
    raise exception 'RESTITCH_NO_SCREENS' using errcode = '22023';
  end if;
  insert into public.team_restitch_defaults as d (
    team_id, operation, start_image_ids, end_image_ids,
    start_enabled, end_enabled, start_duration_mode, custom_start_duration_ms, fit_mode,
    final_duration_mode, custom_final_duration_seconds, source_mode, configured, updated_by, updated_at
  ) values (
    p_team, v_operation, v_start, v_end,
    v_start_enabled, v_end_enabled, v_start_mode, v_start_ms,
    v_fit, v_mode, v_custom, v_source_mode, true, auth.uid(), clock_timestamp()
  ) on conflict (team_id) do update set
    operation = excluded.operation, start_image_ids = excluded.start_image_ids,
    end_image_ids = excluded.end_image_ids, fit_mode = excluded.fit_mode,
    start_enabled = excluded.start_enabled, end_enabled = excluded.end_enabled,
    start_duration_mode = excluded.start_duration_mode,
    custom_start_duration_ms = excluded.custom_start_duration_ms,
    final_duration_mode = excluded.final_duration_mode,
    custom_final_duration_seconds = excluded.custom_final_duration_seconds,
    source_mode = excluded.source_mode,
    configured = true, updated_by = excluded.updated_by, updated_at = clock_timestamp()
  returning * into saved;
  return saved;
end;
$$;

create or replace function public.set_member_restitch_defaults(p_team uuid, p_defaults jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operation text := coalesce(p_defaults ->> 'operation', 'restitch');
  v_fit text := coalesce(p_defaults ->> 'fitMode', 'cover');
  v_mode text := coalesce(p_defaults ->> 'finalDurationMode', 'random-40-50');
  v_custom integer := coalesce((p_defaults ->> 'customFinalDurationSeconds')::integer, 2700);
  v_start_enabled boolean := coalesce((p_defaults ->> 'startEnabled')::boolean, true);
  v_end_enabled boolean := coalesce((p_defaults ->> 'endEnabled')::boolean, true);
  v_start_mode text := coalesce(p_defaults ->> 'startDurationMode', 'one-frame');
  v_start_ms integer := coalesce((p_defaults ->> 'customStartDurationMs')::integer, 100);
  v_source_mode text := coalesce(p_defaults ->> 'sourceMode', 'legacy');
  v_start uuid[] := coalesce((select array_agg(value::uuid)
    from jsonb_array_elements_text(p_defaults -> 'startImageIds')), '{}');
  v_end uuid[] := coalesce((select array_agg(value::uuid)
    from jsonb_array_elements_text(p_defaults -> 'endImageIds')), '{}');
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) or
     exists (select 1 from public.teams where id = p_team and owner_id = auth.uid()) then
    raise exception 'RESTITCH_FORBIDDEN' using errcode = '42501';
  end if;
  if v_operation not in ('restitch', 'stitch', 'unstitch')
     or v_fit not in ('cover', 'contain', 'stretch')
     or v_mode not in ('random-30-40', 'random-40-50', 'random-50-60', 'custom')
     or v_custom not between 1 and 359999
     or v_start_mode not in ('one-frame', 'ms-2', 'ms-5', 'ms-10', 'custom')
     or v_start_ms not between 1 and 60000
     or v_source_mode not in ('legacy', 'drive') then
    raise exception 'RESTITCH_INVALID' using errcode = '22023';
  end if;
  if v_source_mode = 'drive' then
    v_start := '{}'; v_end := '{}';
  elsif v_operation <> 'unstitch' and
     (not v_start_enabled or cardinality(v_start) = 0) and
     (not v_end_enabled or cardinality(v_end) = 0) then
    raise exception 'RESTITCH_NO_SCREENS' using errcode = '22023';
  end if;
  insert into public.team_member_restitch_preferences as preference (
    team_id, user_id, use_owner, operation, start_image_ids, end_image_ids,
    start_enabled, end_enabled, start_duration_mode, custom_start_duration_ms, fit_mode,
    final_duration_mode, custom_final_duration_seconds, source_mode, configured, updated_at
  ) values (
    p_team, auth.uid(), false, v_operation, v_start, v_end,
    v_start_enabled, v_end_enabled, v_start_mode, v_start_ms, v_fit,
    v_mode, v_custom, v_source_mode, true, clock_timestamp()
  ) on conflict (team_id, user_id) do update set
    use_owner = false, operation = excluded.operation,
    start_image_ids = excluded.start_image_ids, end_image_ids = excluded.end_image_ids,
    start_enabled = excluded.start_enabled, end_enabled = excluded.end_enabled,
    start_duration_mode = excluded.start_duration_mode,
    custom_start_duration_ms = excluded.custom_start_duration_ms,
    fit_mode = excluded.fit_mode, final_duration_mode = excluded.final_duration_mode,
    custom_final_duration_seconds = excluded.custom_final_duration_seconds,
    source_mode = excluded.source_mode,
    configured = true, updated_at = clock_timestamp();
  return private.effective_restitch_defaults_json(p_team, auth.uid());
end;
$$;

-- The effective settings now say which way they point.
create or replace function private.effective_restitch_defaults_json(p_team uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = '' stable as $$
declare
  settings_owner_id uuid;
  preference public.team_member_restitch_preferences;
  defaults public.team_restitch_defaults;
begin
  select team.owner_id into settings_owner_id from public.teams as team where team.id = p_team;
  select * into preference from public.team_member_restitch_preferences
    where team_id = p_team and user_id = p_actor;
  if p_actor <> settings_owner_id and preference.user_id is not null and not preference.use_owner then
    if not preference.configured then return null; end if;
    return jsonb_build_object(
      'operation', preference.operation, 'startImageIds', to_jsonb(preference.start_image_ids),
      'endImageIds', to_jsonb(preference.end_image_ids), 'fitMode', preference.fit_mode,
      'startEnabled', preference.start_enabled, 'endEnabled', preference.end_enabled,
      'startDurationMode', preference.start_duration_mode,
      'customStartDurationMs', preference.custom_start_duration_ms,
      'finalDurationMode', preference.final_duration_mode,
      'customFinalDurationSeconds', preference.custom_final_duration_seconds,
      'sourceMode', preference.source_mode,
      'configured', preference.configured, 'updatedAt', preference.updated_at,
      'updatedBy', preference.user_id
    );
  end if;
  select * into defaults from public.team_restitch_defaults where team_id = p_team;
  if defaults.team_id is null or not defaults.configured then return null; end if;
  return jsonb_build_object(
    'operation', defaults.operation, 'startImageIds', to_jsonb(defaults.start_image_ids),
    'endImageIds', to_jsonb(defaults.end_image_ids), 'fitMode', defaults.fit_mode,
    'startEnabled', defaults.start_enabled, 'endEnabled', defaults.end_enabled,
    'startDurationMode', defaults.start_duration_mode,
    'customStartDurationMs', defaults.custom_start_duration_ms,
    'finalDurationMode', defaults.final_duration_mode,
    'customFinalDurationSeconds', defaults.custom_final_duration_seconds,
    'sourceMode', defaults.source_mode,
    'configured', defaults.configured, 'updatedAt', defaults.updated_at,
    'updatedBy', defaults.updated_by
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 7. Drawing. One picture per enabled slot, uniformly over distinct bytes, from the first 500
--    of the stable order. The server picks so the agent fetches one file, not a pool.
-- ---------------------------------------------------------------------------------------------

create or replace function private.draw_restitch_screens_for(
  p_team uuid, p_user uuid, p_settings jsonb, p_exclude uuid[]
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operation text := coalesce(p_settings ->> 'operation', 'restitch');
  v_screens jsonb := '[]'::jsonb;
  v_pool jsonb := '{}'::jsonb;
  v_slot text;
  v_enabled boolean;
  v_pick record;
  v_state text;
begin
  if p_settings is null then
    raise exception 'RESTITCH_INVALID' using errcode = '22023';
  end if;
  if coalesce(p_settings ->> 'sourceMode', 'legacy') <> 'drive' then
    return jsonb_build_object(
      'sourceMode', 'legacy',
      'pool', jsonb_build_object('start', 'empty', 'end', 'empty'),
      'screens', '[]'::jsonb);
  end if;
  perform private.resolve_restitch_pending(p_team);
  foreach v_slot in array array['start', 'end'] loop
    v_enabled := coalesce((p_settings ->> (v_slot || 'Enabled'))::boolean, true);
    v_state := (private.restitch_pool_json(p_team, p_user, v_slot)) ->> 'state';
    v_pool := v_pool || jsonb_build_object(v_slot, v_state);
    if v_operation = 'unstitch' or not v_enabled or v_state = 'empty' then
      continue;
    end if;
    select * into v_pick from (
      select * from private.restitch_pool_images(p_team, p_user, v_slot) limit 500
    ) as pool
    where not (pool.material_id = any (coalesce(p_exclude, '{}')))
    order by random() limit 1;
    if v_pick.material_id is not null then
      v_screens := v_screens || jsonb_build_array(jsonb_build_object(
        'slot', v_slot,
        'materialId', v_pick.material_id,
        'checksum', v_pick.checksum,
        'name', v_pick.name,
        'fileName', v_pick.name,
        'mimeType', v_pick.mime_type,
        'sizeBytes', v_pick.size_bytes,
        'driveVersion', v_pick.drive_version
      ));
    end if;
  end loop;
  if v_operation <> 'unstitch' and jsonb_array_length(v_screens) = 0
     and (coalesce((p_settings ->> 'startEnabled')::boolean, true)
          or coalesce((p_settings ->> 'endEnabled')::boolean, true)) then
    raise exception 'RESTITCH_POOL_EMPTY' using errcode = '22023';
  end if;
  return jsonb_build_object('sourceMode', 'drive', 'pool', v_pool, 'screens', v_screens);
end;
$$;
revoke all on function private.draw_restitch_screens_for(uuid, uuid, jsonb, uuid[])
  from public, anon, authenticated, service_role;

create or replace function public.draw_restitch_screens(p_team uuid, p_exclude uuid[] default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_preference public.team_member_restitch_preferences;
  v_user uuid := null;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'RESTITCH_FORBIDDEN' using errcode = '42501';
  end if;
  select owner_id into v_owner from public.teams where id = p_team;
  select * into v_preference from public.team_member_restitch_preferences
   where team_id = p_team and user_id = auth.uid();
  if auth.uid() <> v_owner and v_preference.user_id is not null and not v_preference.use_owner then
    v_user := auth.uid();
  end if;
  return private.draw_restitch_screens_for(
    p_team, v_user, private.effective_restitch_defaults_json(p_team, auth.uid()), p_exclude);
end;
$$;
revoke all on function public.draw_restitch_screens(uuid, uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.draw_restitch_screens(uuid, uuid[]) to authenticated;

-- Background copies always draw from the space's pool with the owner's settings, whoever's
-- computer runs the job. `p_actor` is who asked, kept for the audit trail only.
create or replace function public.service_draw_restitch_screens(
  p_team uuid, p_actor uuid, p_exclude uuid[] default '{}'
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
begin
  select owner_id into v_owner from public.teams where id = p_team;
  if v_owner is null then
    raise exception 'RESTITCH_INVALID' using errcode = '22023';
  end if;
  return private.draw_restitch_screens_for(
    p_team, null, private.effective_restitch_defaults_json(p_team, v_owner), p_exclude);
end;
$$;
revoke all on function public.service_draw_restitch_screens(uuid, uuid, uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.service_draw_restitch_screens(uuid, uuid, uuid[]) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 7b. What the catalog updater's claim needs from the server side: the space's settings as the
--     owner sees them (background copies never use the claimer's), and the facts a download
--     grant on a drawn picture is issued from, behind the claimer's own download right.
-- ---------------------------------------------------------------------------------------------

create or replace function public.service_get_space_restitch_defaults(p_team uuid)
returns jsonb language plpgsql security definer set search_path = '' stable as $$
declare
  v_owner uuid;
begin
  select owner_id into v_owner from public.teams where id = p_team;
  if v_owner is null then return null; end if;
  return private.effective_restitch_defaults_json(p_team, v_owner);
end;
$$;
revoke all on function public.service_get_space_restitch_defaults(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.service_get_space_restitch_defaults(uuid) to service_role;

create or replace function public.service_restitch_screen_context(
  p_team uuid, p_actor uuid, p_material uuid
)
returns table (material_id uuid, drive_file_id text, size_bytes bigint, checksum text, mime_type text)
language plpgsql security definer set search_path = '' stable as $$
begin
  if p_actor is null or not private.can(p_team, 'download', p_actor) then
    raise exception 'RESTITCH_SOURCE_FORBIDDEN' using errcode = '42501';
  end if;
  return query
  select material.id, material.drive_file_id, material.size_bytes, material.checksum, material.mime_type
  from public.team_materials as material
  join public.team_drive_connections as connection
    on connection.id = material.connection_id and connection.state = 'connected'
  where material.id = p_material and material.team_id = p_team
    and material.lifecycle = 'active' and material.kind = 'file' and material.category = 'image';
end;
$$;
revoke all on function public.service_restitch_screen_context(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.service_restitch_screen_context(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 8. Deferring a catalog job whose pool is empty: queued again after the given interval, the
--    attempt the claim counted given back, the reason recorded. Not a failure, not a retry loop.
-- ---------------------------------------------------------------------------------------------

create or replace function public.service_defer_restitch_job(
  p_job uuid, p_lease_token_hash bytea, p_code text, p_interval interval
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  job private.catalog_restitch_jobs;
begin
  if p_code is null or p_code !~ '^[A-Z_]{2,64}$' or p_interval is null or p_interval <= interval '0' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into job from private.catalog_restitch_jobs as candidate
   where candidate.catalog_material_id = p_job
     and candidate.state = 'leased'
     and candidate.lease_token_hash = p_lease_token_hash
   for update;
  if job.catalog_material_id is null then return false; end if;
  update private.catalog_restitch_jobs as candidate
     set state = 'queued',
         lease_token_hash = null,
         lease_expires_at = null,
         lease_owner = null,
         attempts = greatest(job.attempts - 1, 0),
         next_attempt_at = clock_timestamp() + p_interval,
         last_error_code = p_code
   where candidate.catalog_material_id = p_job;
  return true;
end;
$$;
revoke all on function public.service_defer_restitch_job(uuid, bytea, text, interval)
  from public, anon, authenticated, service_role;
grant execute on function public.service_defer_restitch_job(uuid, bytea, text, interval) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 8b. The updater's state tells the chip why its spare copies stand still: a job deferred for
--     an empty pool, or failed because the claimer may not download, is the one reason a
--     person can act on, and it was invisible.
-- ---------------------------------------------------------------------------------------------

create or replace function private.catalog_updater_state(p_team uuid)
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  select jsonb_build_object(
    'state', coalesce(updater.state, 'stopped'),
    'interval', coalesce(updater.update_interval, '1h'),
    'restitch', coalesce(updater.restitch, false),
    'nextRunAt', updater.next_run_at,
    'startedAt', updater.started_at,
    'catalogCount', (
      select count(*) from public.team_catalog_updater_items as item
      where item.team_id = p_team and item.update_interval is not null
    ),
    'failingCount', (
      select count(*)
      from public.team_catalog_updater_items as item
      join public.team_product_catalogs as record
        on record.material_id = item.catalog_material_id
      where item.team_id = p_team
        and item.attempts >= 3
        and record.last_update_error is not null
    ),
    'spareReadyCount', case when coalesce(updater.restitch, false) then (
      select count(*)
      from public.team_catalog_updater_items as item
      join public.team_catalog_restitch_copies as copy
        on copy.catalog_material_id = item.catalog_material_id and copy.role = 'spare'
      where item.team_id = p_team and item.update_interval is not null
    ) end,
    'restitchBlockedCode', case when coalesce(updater.restitch, false) then (
      select job.last_error_code
      from private.catalog_restitch_jobs as job
      where job.team_id = p_team and job.state = 'queued'
        and job.last_error_code in ('RESTITCH_POOL_EMPTY', 'RESTITCH_SOURCE_FORBIDDEN', 'RESTITCH_INVALID')
        and job.next_attempt_at > clock_timestamp()
      order by job.next_attempt_at desc
      limit 1
    ) end,
    'device', null,
    'serverNow', clock_timestamp()
  )
  from (select 1) as anchor
  left join public.team_catalog_updaters as updater on updater.team_id = p_team;
$$;

-- ---------------------------------------------------------------------------------------------
-- 9. The codes the contract seed must know, and the bucket closed to writes (FR-028). Reading
--    stays until the approved deletion; nothing can be put in any more.
-- ---------------------------------------------------------------------------------------------

insert into public.team_error_codes (code) values
  ('RESTITCH_POOL_EMPTY'),
  ('RESTITCH_SOURCE_FORBIDDEN'),
  ('RESTITCH_SOURCES_INVALID'),
  ('RESTITCH_SOURCES_TOO_MANY'),
  ('RESTITCH_CLIENT_OUTDATED')
on conflict (code) do nothing;

drop policy if exists team_restitch_images_write on storage.objects;
