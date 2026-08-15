-- Restore the connected Drive root as the default catalog location and make
-- pre-Creative-Library files safely discoverable.  Existing assets stay
-- unplaced until a user explicitly runs a placement move through the normal
-- Drive saga.

create or replace function public.list_team_materials(
  p_team uuid,
  p_parent_folder_id text default null
)
returns table (
  id uuid,
  team_id uuid,
  drive_file_id text,
  parent_folder_id text,
  name text,
  kind text,
  category text,
  mime_type text,
  file_extension text,
  size_bytes bigint,
  modified_at timestamptz,
  preview_state text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  resolved_parent_folder_id text := p_parent_folder_id;
begin
  if not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  -- The client uses NULL to request the visible root.  Catalog rows for a
  -- connected Drive root are stored with the actual root folder id as parent.
  if resolved_parent_folder_id is null then
    select connection.root_folder_id
      into resolved_parent_folder_id
    from public.team_drive_connections as connection
    where connection.team_id = p_team
      and connection.state <> 'detached'
    order by connection.created_at desc
    limit 1;
  end if;

  return query
  select material.id,
         material.team_id,
         material.drive_file_id,
         material.parent_folder_id,
         material.name,
         material.kind,
         material.category,
         material.mime_type,
         material.file_extension,
         material.size_bytes,
         material.modified_at,
         material.preview_state
  from public.team_materials as material
  where material.team_id = p_team
    and material.lifecycle = 'active'
    and material.parent_folder_id is not distinct from resolved_parent_folder_id
  order by material.kind desc, lower(material.name), material.id
  limit 500;
end;
$$;

-- A file created before Creative Library has no structural stage yet.  Treat
-- it as a Find for browsing and placement without mutating its catalog row or
-- claiming that its Drive location was already organized.
create or replace function public.list_library_materials(
  p_team uuid,
  p_stage text,
  p_cursor uuid default null,
  p_page_size integer default 50
)
returns table (
  id uuid,
  team_id uuid,
  name text,
  category text,
  mime_type text,
  file_extension text,
  size_bytes bigint,
  lifecycle text,
  source_version text,
  stage text,
  offer text,
  language text,
  type text,
  placement_state text,
  language_decision_source text,
  thumbnail_state text,
  thumbnail_time_ms integer,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cursor_created_at timestamptz;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_stage not in ('finds','library') or p_page_size not between 1 and 100 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_cursor is not null then
    select material.created_at into cursor_created_at
    from public.team_materials as material
    where material.id = p_cursor and material.team_id = p_team
      and (
        material.library_stage = p_stage
        or (p_stage = 'finds' and material.library_stage is null)
      );
    if cursor_created_at is null then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  end if;
  return query
  select material.id, material.team_id, material.name, material.category,
         material.mime_type, material.file_extension, material.size_bytes,
         material.lifecycle,
         coalesce(nullif(material.drive_version,''), nullif(material.checksum,'')),
         coalesce(material.library_stage, 'finds'),
         coalesce(material.structural_offer, 'unknown'),
         coalesce(material.structural_language, 'unknown'),
         coalesce(material.structural_type, 'Unknown'), material.placement_state,
         material.language_decision_source, material.thumbnail_state,
         material.thumbnail_time_ms, material.created_at
  from public.team_materials as material
  where material.team_id = p_team
    and material.kind = 'file'
    and (
      material.library_stage = p_stage
      or (p_stage = 'finds' and material.library_stage is null)
    )
    and (p_cursor is null or (material.created_at, material.id) < (cursor_created_at, p_cursor))
  order by material.created_at desc, material.id desc
  limit p_page_size;
end;
$$;

-- The same compatibility rule must apply to the service-side placement
-- resolver, otherwise a visible legacy Find could not be organized.
create or replace function public.service_get_library_asset_placement(
  p_team uuid,
  p_actor uuid,
  p_material uuid
)
returns table (
  material_id uuid,
  placement_revision bigint,
  stage text,
  offer text,
  language text,
  type text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.can(p_team, 'edit', p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
  select material.id, material.placement_revision,
         coalesce(material.library_stage, 'finds'),
         coalesce(material.structural_offer, material.offer, 'unknown'),
         coalesce(material.structural_language, material.language, 'unknown'),
         coalesce(material.structural_type, initcap(coalesce(material.category, 'unknown')))
  from public.team_materials as material
  where material.id = p_material and material.team_id = p_team
    and material.kind = 'file' and material.lifecycle = 'active'
    and (material.library_stage in ('finds','library') or material.library_stage is null);
end;
$$;

comment on function public.list_team_materials(uuid, text) is
  'Caller-checked catalog listing; NULL resolves to the connected Drive root for the visible workspace tree.';
comment on function public.list_library_materials(uuid, text, uuid, integer) is
  'Caller-checked Creative Library listing; active pre-library files appear as unplaced Finds until an explicit placement move.';
