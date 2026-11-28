-- 057 M1 (T023): uploads into an R2 space (specs/057-r2-workspaces/contracts/storage-api.md,
-- data-model.md M1, research R3).
--
-- Additive: two columns on space_uploads, new functions, and the R2-only list functions of
-- 20261226120000 replaced (a Drive space never reaches them). Nothing a Drive space executes
-- changes.
--
-- * service_admit_space_upload: one call per file. Locks the space, then the parent folder
--   (team → material). The same content already in that folder → `exists`; already elsewhere
--   in the space → a new material on the same object, no bytes move (dedup within one space
--   only, FR-016); otherwise `used + reserved + declared ≤ capacity` or STORAGE_QUOTA_EXCEEDED
--   with needBytes/freeBytes, and a reservation plus an open session. Every outcome is a
--   space_uploads row under the caller's idempotency key, so a retry returns the same answer.
-- * The original's multipart is opened at its final key t/{team}/o/{declared content_id}. R2
--   shows nothing there until the server completes it, and the server completes only after it
--   recomputed content_id from the part ETags R2 itself reports (ListParts) — so no client can
--   put foreign bytes under a content id. staging_key (t/{team}/u/{upload}) stays the prefix
--   for staged derivatives (T047) and the lifecycle rule (T002). This also spares a server-side
--   copy, which an edge function could not finish for a 100 GiB object.
-- * service_mark_space_upload_completing records the verified content id and the object ETag
--   R2 will report (MD5 of the part MD5s, "-N"), so a completion whose reply was lost is
--   recognised by HEAD on the retry.
-- * service_complete_space_upload: one transaction — object, material, reference, usage (by
--   the reference triggers of 20261226110000), reservation committed, upload committed,
--   derivative backfill job, content_revision and a Realtime signal. A repeat returns the same
--   material. The role is checked again: a person whose upload right went away between admit
--   and complete is refused.
-- * An expired open session turns its reservation `uncertain` when a multipart may exist; only
--   reconciliation (space-storage-sweeper, later) releases an uncertain reservation.
-- * The purge queue: when the last counted-or-not reference to an object goes, the object is
--   queued (space_object_purges) and marked purge_pending; content that comes back before the
--   sweeper deleted it is revived instead of uploaded again. The sweeper must lock the object
--   row and re-check its references before deleting from R2.

alter table public.space_uploads
  add column verified_content_id text check (verified_content_id is null or verified_content_id ~ '^[0-9a-f]{64}$'),
  add column object_etag text check (object_etag is null or object_etag ~ '^[0-9a-f]{32}-[1-9][0-9]{0,4}$');

-- 1. Facts ---------------------------------------------------------------------------------

-- Pilot capacity is the space owner's permit (data-model «Місткість»); a removed permit keeps
-- the number, so the space stays usable within it (US11: removal never closes a space).
create function private.space_capacity_bytes(p_team uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select pilot.max_space_bytes
    from public.teams team
    join public.storage_r2_pilots pilot on pilot.user_id = team.owner_id
    where team.id = p_team and team.storage_backend = 'r2' and team.storage_pilot), 0);
$$;

create function private.space_used_bytes(p_team uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(usage.bytes), 0)::bigint from public.space_storage_usage usage where usage.team_id = p_team;
$$;

create function private.space_reserved_bytes(p_team uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(reservation.bytes), 0)::bigint
  from public.space_storage_reservations reservation
  where reservation.team_id = p_team and reservation.state in ('reserved', 'uncertain');
$$;

-- The acting person may do this in this R2 space now: active member with the right, the space
-- open, and the person's own pilot permit when the space is a pilot space (contract checks
-- 1, 2, 3, 5 — repeated inside the transaction so nothing changes between check and write).
create function private.require_space_actor(p_team uuid, p_actor uuid, p_permission text) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_backend text;
  v_pilot boolean;
begin
  select team.storage_backend, team.storage_pilot into v_backend, v_pilot
  from public.teams team where team.id = p_team and team.status = 'active';
  if v_backend is null then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if v_backend <> 'r2' then
    raise exception 'STORAGE_BACKEND_MISMATCH' using errcode = '55000';
  end if;
  if v_pilot and not private.is_storage_r2_pilot_user(p_actor) then
    raise exception 'R2_PILOT_REQUIRED' using errcode = '42501';
  end if;
  if p_actor is null or not private.team_profile_active(p_actor) or not private.can(p_team, p_permission, p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
end;
$$;

-- An R2 folder of this space that is live: the root when p_folder is null.
create function private.space_live_folder(p_team uuid, p_folder uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select folder.id from public.team_materials folder
  where folder.team_id = p_team and folder.connection_id is null and folder.kind = 'folder'
    and folder.lifecycle = 'active'
    and folder.id = coalesce(p_folder, (select team.storage_root_material_id from public.teams team where team.id = p_team));
$$;

-- One material of an R2 space as space-storage returns it (SpaceMaterialSnapshot).
create function private.space_material_snapshot(p_material uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', material.id,
    'teamId', material.team_id,
    'parentMaterialId', material.parent_folder_id,
    'name', material.name,
    'kind', material.kind,
    'lifecycle', case when material.lifecycle = 'trashed' then 'trashed' else 'active' end,
    'materialRevision', material.material_revision::text,
    'contentId', object.content_id,
    'sizeBytes', case when material.kind = 'folder' then null else coalesce(material.size_bytes, 0)::text end,
    'mimeType', material.mime_type,
    'thumbnailReady', material.provider_thumbnail_state = 'ready')
  from public.team_materials material
  left join public.space_objects object on object.id = material.space_object_id
  where material.id = p_material and material.connection_id is null;
$$;

-- A change of what an R2 space shows: content_revision rises and one content-free signal goes
-- to the space's Realtime channel (R7, R8). Returns the new revision.
create function private.space_content_changed(p_team uuid, p_folder uuid, p_usage boolean default true) returns bigint
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
  if p_usage then
    insert into public.team_space_storage_signals (team_id, kind, folder_id, revision)
    values (p_team, 'usage', null, v_revision);
  end if;
  return v_revision;
end;
$$;

-- 2. References of R2 materials and the purge queue ---------------------------------------

-- Where a material's object counts: trash while trashed, attachments for a file a task upload
-- brought in (private.task_owned_uploads, T031), materials otherwise (FR-047).
create function private.space_material_category(p_material uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when material.lifecycle <> 'active' then 'trash'
    when exists (select 1 from private.task_owned_uploads owned where owned.material_id = material.id) then 'attachments'
    else 'materials' end
  from public.team_materials material where material.id = p_material;
$$;

-- The material's one reference follows its object and lifecycle. R2 rows only.
create function private.space_material_ref_sync(p_material uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  m public.team_materials%rowtype;
  v_category text;
begin
  select * into m from public.team_materials where id = p_material;
  if not found or m.connection_id is not null then return; end if;
  if m.space_object_id is null then
    delete from public.space_object_refs where owner_kind = 'material' and owner_id = p_material;
    return;
  end if;
  v_category := private.space_material_category(p_material);
  delete from public.space_object_refs
   where owner_kind = 'material' and owner_id = p_material and object_id <> m.space_object_id;
  insert into public.space_object_refs (object_id, owner_kind, owner_id, team_id, category, counted)
  values (m.space_object_id, 'material', p_material, m.team_id, v_category, true)
  on conflict (object_id, owner_kind, owner_id) do update set category = excluded.category
  where public.space_object_refs.category is distinct from excluded.category;
end;
$$;

create function private.space_material_refs_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.connection_id is null and old.space_object_id is not null then
      delete from public.space_object_refs where owner_kind = 'material' and owner_id = old.id;
    end if;
    return old;
  end if;
  if new.connection_id is null then
    perform private.space_material_ref_sync(new.id);
  end if;
  return null;
end;
$$;
create trigger team_materials_space_refs after insert or update of space_object_id, lifecycle on public.team_materials
  for each row when (new.connection_id is null and new.space_object_id is not null)
  execute function private.space_material_refs_changed();
-- Before the row goes, so the reference is removed while the material still exists.
create trigger team_materials_space_refs_deleted before delete on public.team_materials
  for each row when (old.connection_id is null and old.space_object_id is not null)
  execute function private.space_material_refs_changed();

-- When the last reference to an object goes, the object (and its derivatives) is queued for
-- deletion from R2 (FR-048). The reason comes from the transaction that removed it
-- (soty.space_purge_reason), `orphan` when nothing named one.
create function private.space_object_refs_released() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_reason text := coalesce(nullif(pg_catalog.current_setting('soty.space_purge_reason', true), ''), 'orphan');
begin
  if v_reason not in ('trash_expired', 'trash_emptied', 'catalog_deleted', 'space_deleted', 'orphan') then
    v_reason := 'orphan';
  end if;
  if exists (select 1 from public.space_object_refs where object_id = old.object_id) then
    return null;
  end if;
  with released as (
    update public.space_objects set state = 'purge_pending'
    where (id = old.object_id or derivative_of = old.object_id) and state = 'committed'
    returning id, team_id, r2_key
  )
  insert into public.space_object_purges (object_id, team_id, r2_key, due_at, reason)
  select id, team_id, r2_key, now(), v_reason from released
  on conflict (object_id) do update set due_at = excluded.due_at, reason = excluded.reason,
    state = 'due', deleted_at = null
  where public.space_object_purges.state <> 'deleted';
  return null;
end;
$$;
create trigger space_object_refs_released after delete on public.space_object_refs
  for each row execute function private.space_object_refs_released();

-- Content that comes back before its bytes were deleted is used again: the queued purge is
-- withdrawn. Returns false when the bytes may already be gone (then upload them anew).
create function private.space_object_revive(p_object uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_state text;
begin
  select state into v_state from public.space_objects where id = p_object for update;
  if v_state = 'committed' then return true; end if;
  if v_state <> 'purge_pending' then return false; end if;
  delete from public.space_object_purges where object_id = p_object and state = 'due' and attempts = 0;
  if not found then return false; end if;
  update public.space_objects set state = 'committed' where id = p_object;
  return true;
end;
$$;

-- 3. Admit ---------------------------------------------------------------------------------

create function private.space_upload_session(u public.space_uploads) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'kind', 'session',
    'uploadId', u.id,
    'partBytes', u.part_bytes,
    'partCount', u.part_count,
    'derivativeSlots', '[]'::jsonb,
    'expiresAt', u.expires_at,
    -- For the edge function only; it strips these before answering.
    'state', u.state,
    'r2UploadId', u.r2_upload_id,
    'objectKey', 't/' || u.team_id::text || '/o/' || u.declared_content_id,
    'declaredContentId', u.declared_content_id,
    'declaredBytes', u.declared_bytes::text,
    'objectEtag', u.object_etag,
    'resultMaterialId', u.result_material_id,
    'name', u.name,
    'contentType', u.content_type,
    'teamId', u.team_id);
$$;

create function private.space_upload_answer(u public.space_uploads) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if u.state = 'committed' then
    return jsonb_build_object('kind', 'exists', 'materialId', u.result_material_id);
  elsif u.state in ('open', 'completing') and u.expires_at > now() then
    return private.space_upload_session(u);
  elsif u.state = 'rejected' and u.reject_code is not null then
    raise exception '%', u.reject_code using errcode = '55000';
  end if;
  raise exception 'UPLOAD_EXPIRED' using errcode = '55000';
end;
$$;

-- Inserts an R2 file material on an object. The classification comes from the edge function's
-- shared classifier (packages/shared material-category).
create function private.space_insert_file(
  p_team uuid, p_parent uuid, p_object uuid, p_name text, p_input jsonb
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  o public.space_objects%rowtype;
  v_id uuid;
  v_category text := nullif(p_input ->> 'category', '');
  v_source text := coalesce(nullif(p_input ->> 'classificationSource', ''), 'fallback');
  v_extension text := nullif(p_input ->> 'fileExtension', '');
begin
  select * into o from public.space_objects where id = p_object and team_id = p_team;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_category is not null and v_category not in ('video', 'image', 'archive', 'transcript', 'landing', 'other') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if v_source not in ('mime', 'extension', 'fallback') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if v_extension is not null and v_extension !~ '^[a-z0-9][a-z0-9._+-]{0,31}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  insert into public.team_materials (
    team_id, parent_folder_id, name, kind, mime_type, file_extension, category,
    classification_source, size_bytes, modified_at, space_object_id, placement_state)
  values (
    p_team, p_parent::text, p_name, 'file', o.content_type, v_extension, v_category,
    v_source, o.byte_size, now(), o.id, 'ready')
  returning id into v_id;
  return v_id;
end;
$$;

create function public.service_admit_space_upload(p_actor uuid, p_input jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_team uuid;
  v_parent uuid;
  v_name text := btrim(coalesce(p_input ->> 'name', ''));
  v_type text := lower(coalesce(p_input ->> 'contentType', ''));
  v_bytes bigint;
  v_content text := p_input ->> 'contentId';
  v_sha text := nullif(p_input ->> 'sha256', '');
  v_ingress text := coalesce(p_input ->> 'ingress', '');
  v_key text := p_input ->> 'idempotencyKey';
  v_part bigint;
  v_parts integer;
  v_existing public.space_uploads%rowtype;
  v_object public.space_objects%rowtype;
  v_material uuid;
  v_reservation uuid;
  v_upload uuid := gen_random_uuid();
  v_capacity bigint;
  v_free bigint;
  u public.space_uploads%rowtype;
begin
  begin
    v_team := (p_input ->> 'teamId')::uuid;
    v_parent := (p_input ->> 'parentMaterialId')::uuid;
    v_bytes := (p_input ->> 'bytes')::bigint;
  exception when others then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end;
  if v_team is null or v_bytes is null or v_bytes < 0
     or char_length(v_name) not between 1 and 1024 or v_name ~ '[[:cntrl:]/]'
     or v_type !~ '^[a-z0-9][a-z0-9.+-]{0,63}/[a-z0-9][a-z0-9.+-]{0,127}$'
     or v_content is null or v_content !~ '^[0-9a-f]{64}$'
     or (v_sha is not null and v_sha !~ '^[0-9a-f]{64}$')
     or v_ingress not in ('explorer', 'agent_output', 'inbox', 'mobile', 'share_target')
     or v_key is null or v_key !~ '^[A-Za-z0-9_:-]{16,200}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if v_bytes > 107374182400 then
    raise exception 'STORAGE_OBJECT_TOO_LARGE' using errcode = '22023';
  end if;
  v_part := case when v_bytes > 53687091200 then 67108864 else 16777216 end;
  v_parts := greatest(1, ceil(v_bytes::numeric / v_part)::integer);

  -- Lock order: the space, then the folder (team → material).
  perform 1 from public.teams where id = v_team for no key update;
  perform private.require_space_actor(v_team, p_actor, 'upload');
  -- No parent named: the root of the space.
  v_parent := coalesce(v_parent, (select team.storage_root_material_id from public.teams team where team.id = v_team));

  select * into v_existing from public.space_uploads
   where team_id = v_team and actor_id = p_actor and idempotency_key = v_key for update;
  if found then
    return private.space_upload_answer(v_existing);
  end if;

  perform 1 from public.team_materials where id = v_parent and team_id = v_team for share;
  if private.space_live_folder(v_team, v_parent) is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  -- The same content in this space: no bytes move.
  select * into v_object from public.space_objects
   where team_id = v_team and content_id = v_content and kind = 'original' and state <> 'purged'
   for update;
  if found and not private.space_object_revive(v_object.id) then
    -- Its deletion is in flight: no new multipart may target that key until it finished.
    raise exception 'STORAGE_UNAVAILABLE' using errcode = '55000';
  end if;
  if found and v_object.byte_size = v_bytes then
    select material.id into v_material from public.team_materials material
     where material.team_id = v_team and material.connection_id is null
       and material.parent_folder_id = v_parent::text and material.space_object_id = v_object.id
       and material.lifecycle = 'active'
     order by material.created_at limit 1;
    if v_material is null then
      v_material := private.space_insert_file(v_team, v_parent, v_object.id, v_name, p_input);
      perform private.space_content_changed(v_team, v_parent);
    end if;
    insert into public.space_storage_reservations (team_id, operation_id, bytes, purpose, state, expires_at, created_by, settled_at)
    values (v_team, v_upload, 0, 'upload', 'committed', now(), p_actor, now())
    returning id into v_reservation;
    insert into public.space_uploads (
      id, team_id, reservation_id, declared_content_id, declared_sha256, declared_bytes, part_bytes,
      part_count, name, content_type, parent_material_id, staging_key, ingress, actor_id,
      idempotency_key, state, result_material_id, object_id, expires_at)
    values (
      v_upload, v_team, v_reservation, v_content, v_sha, v_bytes, v_part, v_parts, v_name, v_type,
      v_parent, 't/' || v_team::text || '/u/' || v_upload::text, v_ingress, p_actor, v_key,
      'committed', v_material, v_object.id, now());
    return jsonb_build_object('kind', 'exists', 'materialId', v_material);
  end if;

  v_capacity := private.space_capacity_bytes(v_team);
  v_free := greatest(0, v_capacity - private.space_used_bytes(v_team) - private.space_reserved_bytes(v_team));
  if v_bytes > v_free then
    return jsonb_build_object('kind', 'quota', 'needBytes', v_bytes::text, 'freeBytes', v_free::text);
  end if;

  insert into public.space_storage_reservations (team_id, operation_id, bytes, purpose, expires_at, created_by)
  values (v_team, v_upload, v_bytes, 'upload', now() + interval '24 hours', p_actor)
  returning id into v_reservation;
  insert into public.space_uploads (
    id, team_id, reservation_id, declared_content_id, declared_sha256, declared_bytes, part_bytes,
    part_count, name, content_type, parent_material_id, staging_key, ingress, actor_id,
    idempotency_key, expires_at)
  values (
    v_upload, v_team, v_reservation, v_content, v_sha, v_bytes, v_part, v_parts, v_name, v_type,
    v_parent, 't/' || v_team::text || '/u/' || v_upload::text, v_ingress, p_actor, v_key,
    now() + interval '24 hours')
  returning * into u;
  return private.space_upload_session(u);
end;
$$;

-- The multipart the edge function opened for an admitted session. First one wins; a racing
-- second gets the first id back and aborts its own.
create function public.service_attach_space_upload(p_upload uuid, p_actor uuid, p_r2_upload_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u public.space_uploads%rowtype;
begin
  if p_r2_upload_id is null or char_length(p_r2_upload_id) not between 1 and 1024 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update public.space_uploads set r2_upload_id = p_r2_upload_id, updated_at = now()
   where id = p_upload and actor_id = p_actor and state = 'open' and r2_upload_id is null;
  select * into u from public.space_uploads where id = p_upload and actor_id = p_actor;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  return private.space_upload_answer(u);
end;
$$;

-- 4. Parts, complete, abort ----------------------------------------------------------------

-- The session of one upload for its own uploader, with the right checked again. An open
-- session past its time expires here: its reservation becomes `uncertain` when a multipart
-- may exist (released only by reconciliation), and the call answers UPLOAD_EXPIRED.
create function public.service_space_upload_session(p_upload uuid, p_team uuid, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u public.space_uploads%rowtype;
begin
  perform private.require_space_actor(p_team, p_actor, 'upload');
  select * into u from public.space_uploads where id = p_upload and team_id = p_team and actor_id = p_actor for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if u.state = 'open' and u.expires_at <= now() then
    update public.space_uploads set state = 'expired', updated_at = now() where id = u.id returning * into u;
    update public.space_storage_reservations
       set state = case when u.r2_upload_id is null then 'released' else 'uncertain' end,
           settled_at = case when u.r2_upload_id is null then now() else null end
     where id = u.reservation_id and state = 'reserved';
    return jsonb_build_object('kind', 'expired', 'state', 'expired');
  end if;
  if u.state in ('aborted', 'expired') then
    return jsonb_build_object('kind', 'expired', 'state', u.state);
  end if;
  if u.state = 'rejected' then
    return jsonb_build_object('kind', 'rejected', 'state', u.state, 'code', u.reject_code);
  end if;
  return private.space_upload_session(u);
end;
$$;

create function public.service_mark_space_upload_completing(
  p_upload uuid, p_team uuid, p_actor uuid, p_content_id text, p_object_etag text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u public.space_uploads%rowtype;
begin
  if p_content_id is null or p_content_id !~ '^[0-9a-f]{64}$'
     or p_object_etag is null or p_object_etag !~ '^[0-9a-f]{32}-[1-9][0-9]{0,4}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform private.require_space_actor(p_team, p_actor, 'upload');
  select * into u from public.space_uploads where id = p_upload and team_id = p_team and actor_id = p_actor for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if u.state in ('completing', 'committed') and u.verified_content_id = p_content_id and u.object_etag = p_object_etag then
    return private.space_upload_session(u);
  end if;
  if u.state <> 'open' or u.expires_at <= now() then
    raise exception 'UPLOAD_EXPIRED' using errcode = '55000';
  end if;
  if p_content_id <> u.declared_content_id then
    raise exception 'CHECKSUM_MISMATCH' using errcode = '55000';
  end if;
  update public.space_uploads set state = 'completing', verified_content_id = p_content_id,
    object_etag = p_object_etag, updated_at = now()
  where id = u.id returning * into u;
  return private.space_upload_session(u);
end;
$$;

-- The commit (T022): everything an upload makes visible, in one transaction.
create function public.service_complete_space_upload(p_upload uuid, p_team uuid, p_actor uuid, p_input jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u public.space_uploads%rowtype;
  v_object uuid;
  v_parent uuid;
  v_material uuid;
  v_media boolean;
begin
  perform 1 from public.teams where id = p_team for no key update;
  perform private.require_space_actor(p_team, p_actor, 'upload');
  select * into u from public.space_uploads where id = p_upload and team_id = p_team and actor_id = p_actor for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if u.state = 'committed' then
    return private.space_material_snapshot(u.result_material_id);
  end if;
  if u.state <> 'completing' or u.verified_content_id is null then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;

  -- A folder that went away meanwhile: the file lands in the root rather than nowhere.
  perform 1 from public.team_materials where id = u.parent_material_id for share;
  v_parent := coalesce(private.space_live_folder(p_team, u.parent_material_id), private.space_live_folder(p_team, null));

  select id into v_object from public.space_objects
   where team_id = p_team and content_id = u.verified_content_id and kind = 'original' and state <> 'purged'
   for update;
  if v_object is not null and not private.space_object_revive(v_object) then
    -- The sweeper is deleting these bytes right now; the same key cannot be committed until it
    -- has finished. Retryable: the next attempt finds the object purged and commits anew.
    raise exception 'STORAGE_UNAVAILABLE' using errcode = '55000';
  end if;
  if v_object is null then
    insert into public.space_objects (team_id, kind, content_id, sha256, byte_size, content_type, r2_key)
    values (p_team, 'original', u.verified_content_id, u.declared_sha256, u.declared_bytes, u.content_type,
      't/' || p_team::text || '/o/' || u.verified_content_id)
    returning id into v_object;
  end if;

  v_material := private.space_insert_file(p_team, v_parent, v_object, u.name, p_input);
  update public.space_storage_reservations set state = 'committed', settled_at = now()
   where id = u.reservation_id and state in ('reserved', 'uncertain');
  update public.space_uploads set state = 'committed', result_material_id = v_material, object_id = v_object,
    parent_material_id = v_parent, updated_at = now()
   where id = u.id;

  -- What the uploading client could not make, an agent backfills (R5); T047 adds client
  -- derivatives to this commit and makes this conditional on them.
  select category in ('image', 'video') into v_media from public.team_materials where id = v_material;
  if v_media and not exists (
    select 1 from public.space_objects d where d.derivative_of = v_object and d.state = 'committed') then
    insert into public.space_derivative_jobs (object_id, recipe_version, team_id, reason)
    values (v_object, 1, p_team, 'client_skipped')
    on conflict (object_id, recipe_version) do nothing;
  end if;

  perform private.space_content_changed(p_team, v_parent);
  return private.space_material_snapshot(v_material);
end;
$$;

-- The server found the parts do not make the declared content: nothing is committed.
create function public.service_reject_space_upload(p_upload uuid, p_team uuid, p_actor uuid, p_code text) returns void
language plpgsql security definer set search_path = '' as $$
declare u public.space_uploads%rowtype;
begin
  if p_code is null or p_code not in ('CHECKSUM_MISMATCH', 'STORAGE_OBJECT_TOO_LARGE', 'INVALID_INPUT') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into u from public.space_uploads where id = p_upload and team_id = p_team and actor_id = p_actor for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if u.state not in ('open', 'completing') then return; end if;
  update public.space_uploads set state = 'rejected', reject_code = p_code, updated_at = now() where id = u.id;
  update public.space_storage_reservations set state = 'released', settled_at = now()
   where id = u.reservation_id and state = 'reserved';
end;
$$;

-- The uploader gave up and the multipart is closed: the reservation is free again. An uncertain
-- one stays for reconciliation.
create function public.service_abort_space_upload(p_upload uuid, p_team uuid, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u public.space_uploads%rowtype;
begin
  select * into u from public.space_uploads where id = p_upload and team_id = p_team and actor_id = p_actor for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if u.state = 'committed' then raise exception 'WRONG_STATE' using errcode = '55000'; end if;
  if u.state in ('open', 'completing') then
    update public.space_uploads set state = 'aborted', updated_at = now() where id = u.id;
    update public.space_storage_reservations set state = 'released', settled_at = now()
     where id = u.reservation_id and state = 'reserved';
  end if;
  return jsonb_build_object('aborted', true);
end;
$$;

-- 6. Lists (R2 only): row key, content id and revision ---------------------------------
CREATE OR REPLACE FUNCTION private.space_list_folder_page(p_team uuid, p_parent_folder_id text, p_kind text[], p_after_sort_key text, p_after_id uuid, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  root_folder text;
  parent text;
  total_count integer;
  page_rows jsonb;
  next_cursor jsonb := null;
begin
  select team.storage_root_material_id::text into root_folder
  from public.teams as team where team.id = p_team;
  if root_folder is null then
    return jsonb_build_object('rows', '[]'::jsonb, 'total', 0, 'next', null);
  end if;
  parent := coalesce(p_parent_folder_id, root_folder);

  select count(*) into total_count
  from public.team_materials as material
  where material.team_id = p_team
    and material.connection_id is null
    and material.lifecycle = 'active'
    and material.parent_folder_id is not distinct from parent
    and not private.is_housekeeping_name(material.name)
    and (
      p_kind is null
      or material.kind = 'folder'
      or public.team_material_kind(material.kind, material.mime_type, material.category) = any(p_kind)
    );

  with candidate as (
    select material.*,
           public.team_material_kind(material.kind, material.mime_type, material.category) as row_kind,
           (case when material.kind = 'folder' then '0' else '1' end) || '|' || lower(material.name)
             as sort_key
    from public.team_materials as material
    where material.team_id = p_team
      and material.connection_id is null
      and material.lifecycle = 'active'
      and material.parent_folder_id is not distinct from parent
      and not private.is_housekeeping_name(material.name)
  ),
  page as (
    select candidate.*,
           (
             select render.render_state
             from public.team_landing_renders as render
             where render.team_id = p_team and render.material_id = candidate.id
             order by render.updated_at desc
             limit 1
           ) as render_state
    from candidate
    where (p_kind is null or candidate.row_kind = 'folder' or candidate.row_kind = any(p_kind))
      and (p_after_sort_key is null or (candidate.sort_key, candidate.id) > (p_after_sort_key, p_after_id))
    order by candidate.sort_key, candidate.id
    limit p_limit + 1
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', page.id,
      'teamId', page.team_id,
      'name', page.name,
      'category', page.category,
      'mimeType', page.mime_type,
      'fileExtension', page.file_extension,
      'sizeBytes', page.size_bytes,
      'kind', page.row_kind,
      -- 057 T029: an R2 row's key is its own id (children name a folder by it as
      -- parent_folder_id), so the web's row and folder logic keyed on driveFileId works
      -- unchanged. It is never a Drive id: every Drive path refuses an R2 space.
      'driveFileId', page.id::text,
      'parentFolderId', page.parent_folder_id,
      'modifiedAt', page.modified_at,
      'driveVersion', page.drive_version,
      'previewState', page.provider_thumbnail_state,
      'thumbnailReady', page.provider_thumbnail_state = 'ready',
      'sortKey', page.sort_key,
      'tagColor', page.tag_color,
      -- What this file belongs to (024, US25): a transcript or a catalog folds under its video.
      'companionOf', page.companion_of,
      'companionKind', page.companion_kind,
      -- 057 T029: what the files host needs to build a read URL, and the revision a mutation
      -- compares (FR-040).
      'contentId', (select object.content_id from public.space_objects as object where object.id = page.space_object_id),
      'materialRevision', page.material_revision::text
    )
    -- 012 (T003): whether the video already has text to read, so the row can say so without a
    -- second call per file.
    || case when page.row_kind = 'video'
         then jsonb_build_object(
                'hasTranscriptCompanion', private.has_readable_transcript(p_team, page.id))
         else '{}'::jsonb end
    || case when page.provider_thumbnail_reason is not null
         then jsonb_build_object('previewReason', page.provider_thumbnail_reason) else '{}'::jsonb end
    || case when page.row_kind = 'landing'
         then jsonb_build_object('landingRender',
                jsonb_build_object('state', coalesce(page.render_state, 'none')))
         else '{}'::jsonb end
    order by page.sort_key, page.id
  ), '[]'::jsonb) into page_rows
  from page;

  if jsonb_array_length(page_rows) > p_limit then
    next_cursor := jsonb_build_object(
      'sortKey', page_rows -> (p_limit - 1) ->> 'sortKey',
      'id', page_rows -> (p_limit - 1) ->> 'id'
    );
    select coalesce(jsonb_agg(element.value order by element.ordinality), '[]'::jsonb)
      into page_rows
    from jsonb_array_elements(page_rows) with ordinality as element(value, ordinality)
    where element.ordinality <= p_limit;
  end if;

  return jsonb_build_object('rows', page_rows, 'total', total_count, 'next', next_cursor);
end;
$function$;

CREATE OR REPLACE FUNCTION private.space_list_folder_tree(p_team uuid)
 RETURNS TABLE(id uuid, drive_file_id text, parent_folder_id text, selection_id uuid, name text, indexed_at timestamp with time zone, child_folder_count integer, child_file_count integer, thumbnail_ready_count integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  folder_count bigint;
begin
  select count(*) into folder_count
  from public.team_materials as material
  where material.team_id = p_team
    and material.connection_id is null
    and material.kind = 'folder'
    and material.lifecycle = 'active';
  if folder_count > 10000 then
    raise exception 'TREE_TOO_LARGE' using errcode = 'P0001';
  end if;

  return query
  with counts as (
    select child.parent_folder_id,
           count(*) filter (where child.kind = 'folder')::integer as folders,
           count(*) filter (
             where child.kind <> 'folder' and not private.is_housekeeping_name(child.name)
           )::integer as files,
           count(*) filter (where child.provider_thumbnail_state = 'ready')::integer as ready
    from public.team_materials as child
    where child.team_id = p_team
      and child.connection_id is null
      and child.lifecycle = 'active'
    group by child.parent_folder_id
  )
  select folder.id,
         -- 057 T029: an R2 folder's key is its own id.
         folder.id::text,
         folder.parent_folder_id,
         folder.selection_id,
         folder.name,
         folder.folder_indexed_at,
         coalesce(counts.folders, 0),
         coalesce(counts.files, 0),
         coalesce(counts.ready, 0)
  from public.team_materials as folder
  left join counts on counts.parent_folder_id = folder.id::text
  where folder.team_id = p_team
    and folder.connection_id is null
    and folder.kind = 'folder'
    and folder.lifecycle = 'active'
  order by lower(folder.name), folder.id;
end;
$function$;

-- 6. Grants --------------------------------------------------------------------------------

revoke all on function private.space_capacity_bytes(uuid), private.space_used_bytes(uuid),
  private.space_reserved_bytes(uuid), private.require_space_actor(uuid, uuid, text),
  private.space_live_folder(uuid, uuid), private.space_material_snapshot(uuid),
  private.space_content_changed(uuid, uuid, boolean), private.space_material_category(uuid),
  private.space_material_ref_sync(uuid), private.space_material_refs_changed(),
  private.space_object_refs_released(), private.space_object_revive(uuid),
  private.space_upload_session(public.space_uploads), private.space_upload_answer(public.space_uploads),
  private.space_insert_file(uuid, uuid, uuid, text, jsonb)
  from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'public.service_admit_space_upload(uuid, jsonb)',
    'public.service_attach_space_upload(uuid, uuid, text)',
    'public.service_space_upload_session(uuid, uuid, uuid)',
    'public.service_mark_space_upload_completing(uuid, uuid, uuid, text, text)',
    'public.service_complete_space_upload(uuid, uuid, uuid, jsonb)',
    'public.service_reject_space_upload(uuid, uuid, uuid, text)',
    'public.service_abort_space_upload(uuid, uuid, uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
