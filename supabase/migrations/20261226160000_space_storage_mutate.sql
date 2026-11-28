-- 057 M1 (T025): changing what an R2 space holds (contracts/storage-api.md `/materials/mutate`,
-- `/trash/empty`; data-model invariants; FR-040, FR-048).
--
-- Additive: new functions and one new trigger on team_materials that fires for R2 folders only
-- (`when new.connection_id is null`). The Drive folder cascade (20260930120000) is untouched;
-- it finds no descendants of an R2 folder because it walks drive_file_id, so this trigger
-- walks the R2 key (the folder's own id) with the same semantics: trashing a folder hides its
-- active descendants under folder_trash_root, restoring it brings back exactly those (the
-- Drive trigger's restore branch already does that by folder_trash_root, for both backends).
--
-- * service_mutate_space_materials(actor, team, input): rename, move, copy, create_folder,
--   trash, restore. Locks the space first. Every expected revision is compared before anything
--   is written; a stale one answers {kind:'conflict', materialId, currentRevision} and nothing
--   changes. Renaming and moving are rows only: bytes and addresses never change. A copy is a
--   new material on the same object (no bytes copied). Cycles and foreign parents are refused
--   by the shape trigger of 20261226110000.
-- * service_empty_space_trash(actor, team, ids): deletes trashed R2 materials for good, deepest
--   first, each in its own subtransaction so one still referenced elsewhere (a task, a
--   catalog) stays in the trash instead of failing the rest. Objects whose last reference went
--   are queued for deletion from R2 at once (reason trash_emptied) in the same transaction,
--   and the usage meter moves with them.
-- * service_read_space_materials(actor, team, ids): snapshots of materials a client has not
--   listed yet, for building files-host addresses.

create function private.cascade_space_folder_trash() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if pg_trigger_depth() > 1 or new.kind <> 'folder' or new.lifecycle = old.lifecycle
     or new.lifecycle <> 'trashed' then
    return new;
  end if;
  with recursive descendants as (
    select child.id from public.team_materials child
    where child.team_id = new.team_id and child.connection_id is null and child.parent_folder_id = new.id::text
    union
    select child.id from public.team_materials child
    join descendants parent on child.parent_folder_id = parent.id::text
    where child.team_id = new.team_id and child.connection_id is null
  ), changed as (
    update public.team_materials material
       set lifecycle = 'trashed', trashed_at = new.trashed_at, folder_trash_root = new.id, placement_state = 'ready'
     where material.team_id = new.team_id and material.id in (select id from descendants)
       and material.lifecycle = 'active'
    returning material.id
  )
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  select new.team_id, id, 'tombstoned' from changed;
  return new;
end;
$$;
create trigger cascade_space_folder_trash after update of lifecycle on public.team_materials
  for each row when (new.connection_id is null and new.kind = 'folder')
  execute function private.cascade_space_folder_trash();

-- An R2 material of this space, locked.
create function private.space_material_for_update(p_team uuid, p_material uuid) returns public.team_materials
language plpgsql security definer set search_path = '' as $$
declare m public.team_materials%rowtype;
begin
  select * into m from public.team_materials
   where id = p_material and team_id = p_team and connection_id is null for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  return m;
end;
$$;

create function private.space_normalized_name(p_name text) returns text
language plpgsql immutable set search_path = '' as $$
declare v text := btrim(coalesce(p_name, ''));
begin
  if char_length(v) not between 1 and 1024 or v ~ '[[:cntrl:]/]' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return v;
end;
$$;

create function public.service_mutate_space_materials(p_actor uuid, p_team uuid, p_input jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_action text := p_input ->> 'action';
  v_ids uuid[];
  v_expected jsonb := coalesce(p_input -> 'expectedRevisions', '{}'::jsonb);
  v_root uuid;
  v_target uuid;
  v_id uuid;
  v_new uuid;
  v_created boolean;
  m public.team_materials%rowtype;
  v_out uuid[] := array[]::uuid[];
  v_folder uuid;
  v_revision bigint;
begin
  if v_action is null or v_action not in ('rename', 'move', 'copy', 'create_folder', 'trash', 'restore')
     or jsonb_typeof(v_expected) <> 'object' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  begin
    select coalesce(array_agg(value::uuid), array[]::uuid[]) into v_ids
    from jsonb_array_elements_text(coalesce(p_input -> 'materialIds', '[]'::jsonb));
  exception when others then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end;
  if cardinality(v_ids) > 100 or cardinality(v_ids) <> cardinality(array(select distinct unnest(v_ids)))
     or (v_action <> 'create_folder' and cardinality(v_ids) < 1)
     or (v_action = 'rename' and cardinality(v_ids) <> 1) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  perform 1 from public.teams where id = p_team for no key update;
  perform private.require_space_actor(p_team, p_actor, case
    when v_action in ('rename', 'move') then 'edit'
    when v_action in ('copy', 'create_folder') then 'upload'
    else 'delete' end);
  if v_action = 'copy' then
    perform private.require_space_actor(p_team, p_actor, 'view');
  end if;
  select storage_root_material_id into v_root from public.teams where id = p_team;

  -- Revisions first: a stale one changes nothing (FR-040).
  foreach v_id in array v_ids loop
    m := private.space_material_for_update(p_team, v_id);
    if v_expected ? v_id::text and (v_expected ->> v_id::text) is distinct from m.material_revision::text then
      return jsonb_build_object('kind', 'conflict', 'materialId', m.id, 'currentRevision', m.material_revision::text);
    end if;
    if m.id = v_root and v_action in ('rename', 'move', 'trash', 'copy') then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
  end loop;

  if v_action in ('move', 'copy') then
    begin
      -- No target named: the root of the space.
      v_target := coalesce(nullif(p_input ->> 'targetFolderId', '')::uuid, v_root);
    exception when others then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end;
    perform 1 from public.team_materials where id = v_target and team_id = p_team for share;
    if v_target is null or private.space_live_folder(p_team, v_target) is null then
      raise exception 'NOT_FOUND' using errcode = 'P0002';
    end if;
  end if;

  if v_action = 'rename' then
    update public.team_materials set name = private.space_normalized_name(p_input ->> 'name')
     where id = v_ids[1] returning parent_folder_id::uuid into v_folder;
    v_out := v_ids;
  elsif v_action = 'move' then
    foreach v_id in array v_ids loop
      update public.team_materials set parent_folder_id = v_target::text, placement_state = 'ready'
       where id = v_id and lifecycle = 'active';
      if not found then raise exception 'WRONG_STATE' using errcode = '55000'; end if;
    end loop;
    v_out := v_ids;
    v_folder := v_target;
  elsif v_action = 'copy' then
    foreach v_id in array v_ids loop
      select * into m from public.team_materials where id = v_id;
      if m.kind <> 'file' or m.space_object_id is null or m.lifecycle <> 'active' then
        raise exception 'INVALID_INPUT' using errcode = '22023';
      end if;
      insert into public.team_materials (
        team_id, parent_folder_id, name, kind, mime_type, file_extension, category,
        classification_source, size_bytes, modified_at, space_object_id, placement_state)
      values (p_team, v_target::text, m.name, 'file', m.mime_type, m.file_extension, m.category,
        m.classification_source, m.size_bytes, now(), m.space_object_id, 'ready')
      returning id into v_new;
      v_out := v_out || v_new;
    end loop;
    v_folder := v_target;
  elsif v_action = 'create_folder' then
    begin
      v_folder := coalesce(nullif(p_input ->> 'parentMaterialId', '')::uuid, v_root);
    exception when others then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end;
    perform 1 from public.team_materials where id = v_folder and team_id = p_team for share;
    if private.space_live_folder(p_team, v_folder) is null then
      raise exception 'NOT_FOUND' using errcode = 'P0002';
    end if;
    v_new := null;
    if coalesce((p_input ->> 'ensure')::boolean, false) then
      select id into v_new from public.team_materials
       where team_id = p_team and connection_id is null and kind = 'folder' and lifecycle = 'active'
         and parent_folder_id = v_folder::text and name = private.space_normalized_name(p_input ->> 'name')
       order by created_at, id limit 1;
    end if;
    v_created := v_new is null;
    if v_created then
      insert into public.team_materials (team_id, parent_folder_id, name, kind, placement_state)
      values (p_team, v_folder::text, private.space_normalized_name(p_input ->> 'name'), 'folder', 'ready')
      returning id into v_new;
    end if;
    v_out := array[v_new];
  elsif v_action = 'trash' then
    foreach v_id in array v_ids loop
      update public.team_materials set lifecycle = 'trashed', trashed_at = now(), placement_state = 'ready'
       where id = v_id and lifecycle = 'active';
    end loop;
    v_out := v_ids;
  else
    foreach v_id in array v_ids loop
      select * into m from public.team_materials where id = v_id;
      if m.lifecycle = 'trashed' then
        -- A parent that is gone or still in the trash: the material comes back in the root.
        update public.team_materials set lifecycle = 'active', trashed_at = null, folder_trash_root = null,
          missing_at = null, placement_state = 'ready',
          parent_folder_id = case
            when m.parent_folder_id is null then null
            when private.space_live_folder(p_team, m.parent_folder_id::uuid) is null then v_root::text
            else m.parent_folder_id end
         where id = v_id;
      end if;
    end loop;
    v_out := v_ids;
  end if;

  if v_action = 'create_folder' and not v_created then
    select content_revision into v_revision from public.teams where id = p_team;
  else
    v_revision := private.space_content_changed(p_team, case when cardinality(v_ids) <= 1 then v_folder else null end,
      v_action in ('copy', 'trash', 'restore'));
  end if;
  return jsonb_build_object(
    'kind', 'ok',
    'materials', coalesce((select jsonb_agg(private.space_material_snapshot(id) order by ordinality)
      from unnest(v_out) with ordinality as out(id, ordinality)), '[]'::jsonb),
    'contentRevision', v_revision::text)
    || case when v_action = 'create_folder' then jsonb_build_object('created', v_created) else '{}'::jsonb end;
end;
$$;

create function public.service_empty_space_trash(p_actor uuid, p_team uuid, p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_deleted integer := 0;
  v_queued integer;
  v_revision bigint;
begin
  if p_ids is not null and cardinality(p_ids) > 1000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform 1 from public.teams where id = p_team for no key update;
  perform private.require_space_actor(p_team, p_actor, 'delete');
  perform pg_catalog.set_config('soty.space_purge_reason', 'trash_emptied', true);
  select count(*) into v_queued from public.space_object_purges where team_id = p_team and state = 'due';

  -- The chosen trashed materials and everything their trashing hid; deepest first.
  for v_id in
    with recursive chosen as (
      select material.id, 0 as depth from public.team_materials material
      where material.team_id = p_team and material.connection_id is null and material.lifecycle = 'trashed'
        and (p_ids is null or material.id = any(p_ids))
      union
      select child.id, chosen.depth + 1 from public.team_materials child
      join chosen on child.folder_trash_root = chosen.id
      where child.team_id = p_team and child.connection_id is null and child.lifecycle = 'trashed' and chosen.depth < 1000
    )
    select chosen.id from chosen group by chosen.id order by max(chosen.depth) desc, chosen.id
  loop
    begin
      delete from public.team_materials where id = v_id and team_id = p_team and lifecycle = 'trashed';
      if found then v_deleted := v_deleted + 1; end if;
    exception when foreign_key_violation then
      -- Still referenced (a task, a catalog, a child that stays): it stays in the trash.
      null;
    end;
  end loop;

  v_queued := (select count(*) from public.space_object_purges where team_id = p_team and state = 'due') - v_queued;
  if v_deleted > 0 then
    v_revision := private.space_content_changed(p_team, null, true);
  else
    select content_revision into v_revision from public.teams where id = p_team;
  end if;
  perform pg_catalog.set_config('soty.space_purge_reason', '', true);
  return jsonb_build_object('deleted', v_deleted, 'purgesQueued', greatest(v_queued, 0), 'contentRevision', v_revision::text);
end;
$$;

-- What the files host needs for materials a client has not listed yet (a task attachment, a
-- search hit): the snapshot of each R2 material of this space the person may view; unknown ids
-- are left out.
create function public.service_read_space_materials(p_actor uuid, p_team uuid, p_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_ids is null or cardinality(p_ids) not between 1 and 100 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform private.require_space_actor(p_team, p_actor, 'view');
  return coalesce((
    select jsonb_agg(private.space_material_snapshot(material.id) order by material.id)
    from public.team_materials material
    where material.team_id = p_team and material.connection_id is null and material.id = any(p_ids)), '[]'::jsonb);
end;
$$;

revoke all on function private.cascade_space_folder_trash(), private.space_material_for_update(uuid, uuid),
  private.space_normalized_name(text) from public, anon, authenticated;
revoke all on function public.service_mutate_space_materials(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.service_mutate_space_materials(uuid, uuid, jsonb) to service_role;
revoke all on function public.service_empty_space_trash(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.service_empty_space_trash(uuid, uuid, uuid[]) to service_role;
revoke all on function public.service_read_space_materials(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.service_read_space_materials(uuid, uuid, uuid[]) to service_role;
