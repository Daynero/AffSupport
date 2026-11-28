-- 057 M1 (T047): derivatives of an R2 space — made by the uploading client, checked by the
-- server, backfilled by a member's agent (research.md R5, spec FR-038 refinement 2026-11-27,
-- FR-041).
--
-- Additive and R2-only: new columns on the 057 tables, new functions, three 057 functions of
-- 20261226150000 replaced (space_upload_session, space_insert_file, service_complete_space_upload).
-- No Drive space reaches any of them: every function below starts from an R2 space
-- (require_space_actor or a space_objects row, which only R2 spaces have). One shared trigger
-- function gains a first line that returns early for an R2 file only (team_material_thumbnail_state,
-- §3); a Drive row runs the unchanged body.
--
-- * The browser declares what it made (`service_declare_space_upload_derivatives`) after admit:
--   the variants its category asks for, each within its published bounds, with the bytes' MD5.
--   It PUTs them to staging keys t/{team}/u/{upload}/{variant}, which the files host never
--   serves. At complete the edge function reads each staged derivative's first bytes, checks the
--   type by magic bytes, the size and the header dimensions against the declaration, copies the
--   accepted ones to t/{team}/d/{content_id}/{recipe}/{variant} and tells the commit which ones.
-- * The commit records accepted derivatives as derivative objects of the original (not counted
--   in usage), the browser's media facts (duration, width, height) on the original, and syncs the
--   preview state of every material on that object: `ready` once the tile is in, `pending` while
--   an agent job is open, `unavailable` when the agent found the format unsupported or gave up.
-- * A job (space_derivative_jobs, one per object and recipe) is opened when a picture or video has
--   no tile, when a video has no codec/fps yet (the browser cannot tell them reliably), and for a
--   PDF. An agent of any member who may download claims it with a lease
--   (`service_claim_space_derivative_jobs`), stages what it made under t/{team}/u/{claim_id}/…,
--   and finishes it (`service_finish_space_derivative`). An expired lease returns the job; the
--   third failed attempt ends it as `failed`. Finishing raises content_revision and sends one
--   `derivative` signal per touched folder.

-- 1. Columns --------------------------------------------------------------------------------

alter table public.space_uploads
  add column category text check (category is null or category in ('video', 'image', 'archive', 'transcript', 'landing', 'other')),
  add column media_duration_ms bigint check (media_duration_ms is null or media_duration_ms between 0 and 604800000),
  add column media_width integer check (media_width is null or media_width between 1 and 65535),
  add column media_height integer check (media_height is null or media_height between 1 and 65535),
  add column derivatives_unsupported boolean not null default false;

alter table public.space_upload_derivatives
  add column md5 text check (md5 is null or md5 ~ '^[0-9a-f]{32}$'),
  add column reject_reason text check (reject_reason is null or reject_reason in ('type', 'size', 'dimensions', 'missing'));

alter table public.space_derivative_jobs
  add column claim_id uuid,
  add column lease_hash text check (lease_hash is null or lease_hash ~ '^[0-9a-f]{64}$'),
  add column claimed_by uuid references auth.users(id) on delete set null;
alter table public.space_derivative_jobs
  add constraint space_derivative_jobs_claim_shape_check
    check ((state = 'claimed') = (claim_id is not null and lease_hash is not null));
create index space_derivative_jobs_claim_idx on public.space_derivative_jobs (claim_id) where claim_id is not null;

-- 2. Bounds (packages/shared SPACE_DERIVATIVE_VARIANTS, spaceDerivativeSlotsFor) ------------

create function private.space_derivative_slots(p_category text) returns text[]
language sql immutable set search_path = '' as $$
  select case p_category
    when 'image' then array['row', 'tile', 'full']
    when 'video' then array['row', 'tile', 'full', 'poster', 'sprite']
    else array[]::text[] end;
$$;

-- A derivative as declared or as checked: of a known variant and type, within its bounds.
create function private.space_derivative_fits(p_item jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  v_variant text := p_item ->> 'variant';
  v_bytes bigint;
  v_width integer;
  v_height integer;
  v_max_edge integer;
  v_max_bytes integer;
begin
  if jsonb_typeof(p_item) <> 'object' or (p_item ->> 'contentType') not in ('image/webp', 'image/jpeg') then
    return false;
  end if;
  begin
    v_bytes := (p_item ->> 'bytes')::bigint;
    v_width := (p_item ->> 'width')::integer;
    v_height := (p_item ->> 'height')::integer;
  exception when others then
    return false;
  end;
  select edge, max_bytes into v_max_edge, v_max_bytes from (values
    ('row', 160, 65536), ('tile', 480, 262144), ('full', 1600, 1572864),
    ('poster', 1280, 1048576), ('sprite', 4096, 2097152)) as bounds(variant, edge, max_bytes)
  where bounds.variant = v_variant;
  return v_max_edge is not null
    and v_bytes between 1 and v_max_bytes
    and v_width between 1 and v_max_edge
    and v_height between 1 and v_max_edge;
end;
$$;

-- 3. Preview state of an object's materials --------------------------------------------------

-- The Drive picture rule (20260827103000) keys «ready» on drive_version, which an R2 file never
-- has: it would hold every R2 picture at `pending` and every R2 PDF at `not_applicable`. An R2
-- file (no connection, an object) is decided by private.space_object_preview_sync instead; the
-- body below is otherwise the live one, unchanged, so every Drive row takes the same branches.
create or replace function private.team_material_thumbnail_state() returns trigger
language plpgsql security definer set search_path = '' as $function$
begin
  if new.connection_id is null and new.space_object_id is not null then
    return new;
  end if;
  if new.kind <> 'file'
     or new.lifecycle <> 'active'
     or new.category is null
     or new.category not in ('image', 'video', 'landing') then
    new.provider_thumbnail_state := 'not_applicable';
    new.provider_thumbnail_reason := null;
    new.provider_thumbnail_version := null;
    new.provider_thumbnail_claimed_at := null;
  elsif tg_op = 'INSERT' then
    new.provider_thumbnail_state := 'pending';
    new.provider_thumbnail_reason := null;
    new.provider_thumbnail_version := null;
    new.provider_thumbnail_claimed_at := null;
  elsif old.provider_thumbnail_state = 'not_applicable'
        or new.drive_version is distinct from old.drive_version
        or (new.provider_thumbnail_state = 'ready'
            and new.provider_thumbnail_version is distinct from new.drive_version) then
    new.provider_thumbnail_state := 'pending';
    new.provider_thumbnail_reason := null;
    new.provider_thumbnail_version := null;
    new.provider_thumbnail_claimed_at := null;
  end if;
  return new;
end;
$function$;

-- The one place that decides what an R2 file's picture is: ready once the tile is in, pending
-- while an agent may still make it, unavailable when it cannot. Opens the agent job a picture,
-- a video (codec and fps) or a PDF still needs. p_reason names why, for a job opened here.
create function private.space_object_preview_sync(p_object uuid, p_reason text default 'client_skipped') returns void
language plpgsql security definer set search_path = '' as $$
declare
  o public.space_objects%rowtype;
  j public.space_derivative_jobs%rowtype;
  v_category text;
  v_tile boolean;
  v_needs_job boolean;
  v_state text;
  v_reason text;
begin
  select * into o from public.space_objects where id = p_object and kind = 'original' and state = 'committed';
  if not found then return; end if;
  select material.category into v_category from public.team_materials material
   where material.space_object_id = p_object and material.connection_id is null
   order by material.created_at limit 1;
  v_tile := exists (
    select 1 from public.space_objects d
     where d.derivative_of = p_object and d.variant = 'tile' and d.recipe_version = 1 and d.state = 'committed');
  select * into j from public.space_derivative_jobs where object_id = p_object and recipe_version = 1;

  v_needs_job := case
    when v_category in ('image', 'video') then not v_tile or (v_category = 'video' and (o.codec is null or o.fps is null))
    when o.content_type = 'application/pdf' then not v_tile
    else false end;
  if v_needs_job and j.object_id is null then
    insert into public.space_derivative_jobs (object_id, recipe_version, team_id, reason)
    values (p_object, 1, o.team_id, case
      when v_tile then 'missing_media_facts'
      when o.content_type = 'application/pdf' then 'browser_unsupported'
      else coalesce(p_reason, 'client_skipped') end)
    on conflict (object_id, recipe_version) do nothing;
    select * into j from public.space_derivative_jobs where object_id = p_object and recipe_version = 1;
  end if;

  if v_tile then
    v_state := 'ready';
  elsif j.state in ('pending_agent', 'claimed') then
    v_state := 'pending';
  elsif j.state = 'unsupported' or (j.state = 'ready' and not v_tile) then
    v_state := 'unavailable'; v_reason := 'unsupported';
  elsif j.state = 'failed' then
    v_state := 'unavailable'; v_reason := 'corrupt';
  else
    v_state := 'not_applicable';
  end if;

  update public.team_materials material
     set provider_thumbnail_state = v_state,
         provider_thumbnail_reason = v_reason,
         provider_thumbnail_version = case when v_state = 'ready' then 'r2:1' else null end
   where material.space_object_id = p_object and material.connection_id is null
     and (material.provider_thumbnail_state, material.provider_thumbnail_reason, material.provider_thumbnail_version)
         is distinct from (v_state, v_reason, case when v_state = 'ready' then 'r2:1' else null end);
end;
$$;

-- Checked derivatives of an original as objects of their own. Not counted in usage (they have no
-- references); purged with the original (space_object_refs_released). Returns how many are in.
create function private.space_put_derivatives(p_object uuid, p_derivatives jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  o public.space_objects%rowtype;
  v_item jsonb;
  v_count integer := 0;
begin
  select * into o from public.space_objects where id = p_object and kind = 'original' for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p_derivatives is null or jsonb_typeof(p_derivatives) <> 'array' or jsonb_array_length(p_derivatives) > 5 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  for v_item in select value from jsonb_array_elements(p_derivatives) loop
    if not private.space_derivative_fits(v_item) then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    insert into public.space_objects (
      team_id, kind, content_id, byte_size, content_type, r2_key, derivative_of, recipe_version,
      variant, width, height)
    values (
      o.team_id, 'derivative', o.content_id, (v_item ->> 'bytes')::bigint, v_item ->> 'contentType',
      't/' || o.team_id::text || '/d/' || o.content_id || '/1/' || (v_item ->> 'variant'),
      o.id, 1, v_item ->> 'variant', (v_item ->> 'width')::integer, (v_item ->> 'height')::integer)
    on conflict (r2_key) where state <> 'purged' do update
      set byte_size = excluded.byte_size, content_type = excluded.content_type,
          width = excluded.width, height = excluded.height, state = 'committed';
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Media facts on the original: only known values, each within the column's bounds.
create function private.space_put_media_facts(p_object uuid, p_media jsonb, p_override boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_duration bigint;
  v_width integer;
  v_height integer;
  v_codec text;
  v_fps numeric;
begin
  if p_media is null or jsonb_typeof(p_media) <> 'object' then return; end if;
  begin
    v_duration := (p_media ->> 'durationMs')::bigint;
    v_width := (p_media ->> 'width')::integer;
    v_height := (p_media ->> 'height')::integer;
    v_fps := (p_media ->> 'fps')::numeric;
  exception when others then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end;
  v_codec := nullif(p_media ->> 'codec', '');
  if (v_duration is not null and v_duration not between 0 and 604800000)
     or (v_width is not null and v_width not between 1 and 65535)
     or (v_height is not null and v_height not between 1 and 65535)
     or (v_codec is not null and v_codec !~ '^[a-z0-9._-]{1,32}$')
     or (v_fps is not null and (v_fps <= 0 or v_fps > 1000)) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update public.space_objects set
    duration_ms = case when p_override then coalesce(v_duration, duration_ms) else coalesce(duration_ms, v_duration) end,
    width = case when p_override then coalesce(v_width, width) else coalesce(width, v_width) end,
    height = case when p_override then coalesce(v_height, height) else coalesce(height, v_height) end,
    codec = coalesce(v_codec, codec),
    fps = coalesce(round(v_fps, 3), fps)
  where id = p_object and kind = 'original';
end;
$$;

-- A derivative became ready (or will not come): the folders that show the object hear it.
create function private.space_derivative_changed(p_team uuid, p_object uuid) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_revision bigint;
  v_folders uuid[];
begin
  update public.teams set content_revision = content_revision + 1
   where id = p_team and storage_backend = 'r2'
  returning content_revision into v_revision;
  if v_revision is null then
    raise exception 'STORAGE_BACKEND_MISMATCH' using errcode = '55000';
  end if;
  select array_agg(distinct material.parent_folder_id::uuid) into v_folders
    from public.team_materials material
   where material.space_object_id = p_object and material.connection_id is null
     and material.parent_folder_id is not null;
  if v_folders is null or cardinality(v_folders) = 0 or cardinality(v_folders) > 20 then
    -- No folder, or too many to name: every open page of the space checks itself.
    insert into public.team_space_storage_signals (team_id, kind, folder_id, revision)
    values (p_team, 'derivative', null, v_revision);
  else
    insert into public.team_space_storage_signals (team_id, kind, folder_id, revision)
    select p_team, 'derivative', folder, v_revision from unnest(v_folders) as folder;
  end if;
  return v_revision;
end;
$$;

-- 4. Uploads: declared derivatives -------------------------------------------------------------

-- The session the edge function sees now also carries the declared derivatives (stripped before
-- answering). `derivativeSlots` stays empty here: the edge function fills it from the category.
create or replace function private.space_upload_session(u public.space_uploads) returns jsonb
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
    'teamId', u.team_id,
    'derivatives', coalesce((
      select jsonb_agg(jsonb_build_object(
        'variant', d.variant, 'contentType', d.content_type, 'bytes', d.bytes,
        'width', d.width, 'height', d.height, 'md5', d.md5, 'stagingKey', d.staging_key)
        order by d.variant)
      from public.space_upload_derivatives d
      where d.upload_id = u.id and d.state = 'declared'), '[]'::jsonb));
$$;

-- What the uploading client made, declared after admit and before it PUTs them. Replaces any
-- earlier declaration of the same upload (a retry after a reload). p_input: category (from the
-- edge function's classifier), derivatives [{variant, contentType, bytes, width, height, md5}],
-- media {durationMs, width, height}, unsupported (the browser could not decode the file).
create function public.service_declare_space_upload_derivatives(
  p_upload uuid, p_team uuid, p_actor uuid, p_input jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u public.space_uploads%rowtype;
  v_category text := nullif(p_input ->> 'category', '');
  v_items jsonb := coalesce(p_input -> 'derivatives', '[]'::jsonb);
  v_media jsonb := p_input -> 'media';
  v_item jsonb;
  v_slots text[];
  v_seen text[] := array[]::text[];
  v_duration bigint;
  v_width integer;
  v_height integer;
begin
  perform private.require_space_actor(p_team, p_actor, 'upload');
  select * into u from public.space_uploads where id = p_upload and team_id = p_team and actor_id = p_actor for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if u.state <> 'open' or u.expires_at <= now() then
    raise exception 'UPLOAD_EXPIRED' using errcode = '55000';
  end if;
  if v_category is not null and v_category not in ('video', 'image', 'archive', 'transcript', 'landing', 'other') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) > 5 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  v_slots := private.space_derivative_slots(v_category);
  for v_item in select value from jsonb_array_elements(v_items) loop
    if not private.space_derivative_fits(v_item)
       or not ((v_item ->> 'variant') = any(v_slots))
       or (v_item ->> 'variant') = any(v_seen)
       or coalesce(v_item ->> 'md5', '') !~ '^[0-9a-f]{32}$' then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    v_seen := v_seen || (v_item ->> 'variant');
  end loop;
  if v_media is not null and jsonb_typeof(v_media) = 'object' then
    begin
      v_duration := (v_media ->> 'durationMs')::bigint;
      v_width := (v_media ->> 'width')::integer;
      v_height := (v_media ->> 'height')::integer;
    exception when others then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end;
    if (v_duration is not null and v_duration not between 0 and 604800000)
       or (v_width is not null and v_width not between 1 and 65535)
       or (v_height is not null and v_height not between 1 and 65535) then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
  end if;

  delete from public.space_upload_derivatives where upload_id = u.id;
  insert into public.space_upload_derivatives (upload_id, variant, content_type, bytes, width, height, staging_key, md5)
  select u.id, item ->> 'variant', item ->> 'contentType', (item ->> 'bytes')::integer,
         (item ->> 'width')::integer, (item ->> 'height')::integer,
         u.staging_key || '/' || (item ->> 'variant'), item ->> 'md5'
    from jsonb_array_elements(v_items) as item;
  update public.space_uploads set
    category = v_category,
    media_duration_ms = v_duration,
    media_width = v_width,
    media_height = v_height,
    derivatives_unsupported = coalesce((p_input ->> 'unsupported')::boolean, false),
    updated_at = now()
  where id = u.id;
  return coalesce((
    select jsonb_agg(jsonb_build_object('variant', d.variant, 'contentType', d.content_type, 'md5', d.md5,
      'stagingKey', d.staging_key) order by d.variant)
    from public.space_upload_derivatives d where d.upload_id = u.id), '[]'::jsonb);
end;
$$;

-- An R2 file on an object, as before, and its picture state right away (a link to content that
-- already has its tile is ready at once; one without opens the agent job).
create or replace function private.space_insert_file(
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
  perform private.space_object_preview_sync(o.id, coalesce(nullif(p_input ->> 'derivativeReason', ''), 'client_skipped'));
  return v_id;
end;
$$;

-- The commit (T022), now with the derivatives the edge function checked (T047). p_input carries
-- the classification and `derivatives`: [{variant, contentType, bytes, width, height, accepted}].
create or replace function public.service_complete_space_upload(p_upload uuid, p_team uuid, p_actor uuid, p_input jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u public.space_uploads%rowtype;
  v_object uuid;
  v_parent uuid;
  v_material uuid;
  v_checked jsonb := coalesce(p_input -> 'derivatives', '[]'::jsonb);
  v_accepted jsonb;
  v_reason text;
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
  if jsonb_typeof(v_checked) <> 'array' or jsonb_array_length(v_checked) > 5 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
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

  -- Only what the edge function checked and was declared for this upload becomes a derivative.
  select coalesce(jsonb_agg(item), '[]'::jsonb) into v_accepted
    from jsonb_array_elements(v_checked) as item
   where (item ->> 'accepted')::boolean is true
     and exists (select 1 from public.space_upload_derivatives d
                  where d.upload_id = u.id and d.variant = item ->> 'variant');
  perform private.space_put_derivatives(v_object, v_accepted);
  update public.space_upload_derivatives d set
    state = case when exists (select 1 from jsonb_array_elements(v_accepted) a where a ->> 'variant' = d.variant)
                 then 'accepted' else 'rejected' end,
    reject_reason = (select nullif(c ->> 'reason', '') from jsonb_array_elements(v_checked) c
                      where c ->> 'variant' = d.variant and (c ->> 'accepted')::boolean is not true limit 1)
  where d.upload_id = u.id and d.state = 'declared';
  perform private.space_put_media_facts(v_object, jsonb_build_object(
    'durationMs', u.media_duration_ms, 'width', u.media_width, 'height', u.media_height), false);

  v_reason := case when u.derivatives_unsupported then 'browser_unsupported' else 'client_skipped' end;
  v_material := private.space_insert_file(p_team, v_parent, v_object, u.name,
    coalesce(p_input, '{}'::jsonb) - 'derivatives' || jsonb_build_object('derivativeReason', v_reason));
  update public.space_storage_reservations set state = 'committed', settled_at = now()
   where id = u.reservation_id and state in ('reserved', 'uncertain');
  update public.space_uploads set state = 'committed', result_material_id = v_material, object_id = v_object,
    parent_material_id = v_parent, updated_at = now()
   where id = u.id;

  perform private.space_content_changed(p_team, v_parent);
  return private.space_material_snapshot(v_material);
end;
$$;

-- 5. Agent backfill ----------------------------------------------------------------------------

-- Up to p_limit open jobs of one space for a member who may download, each with its own claim id
-- (the staging prefix of what the agent makes) and the lease the edge function minted (only its
-- hash is kept). An expired lease is open again; a job tried three times is over (`failed`).
create function public.service_claim_space_derivative_jobs(
  p_team uuid, p_actor uuid, p_lease_hash text, p_device uuid default null, p_limit integer default 1
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  j record;
  v_out jsonb := '[]'::jsonb;
  v_claim uuid;
  v_material record;
begin
  if p_lease_hash is null or p_lease_hash !~ '^[0-9a-f]{64}$' or p_limit is null or p_limit not between 1 and 10 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform private.require_space_actor(p_team, p_actor, 'download');

  -- Leases that ran out three times are over; the files say why.
  for j in
    update public.space_derivative_jobs set state = 'failed', claim_id = null, lease_hash = null,
           lease_until = null, error_code = coalesce(error_code, 'LEASE_EXPIRED'), updated_at = now()
     where team_id = p_team and state = 'claimed' and lease_until < now() and attempts >= 3
    returning object_id
  loop
    perform private.space_object_preview_sync(j.object_id);
    perform private.space_derivative_changed(p_team, j.object_id);
  end loop;

  for j in
    select job.object_id, job.recipe_version, job.reason, job.attempts
      from public.space_derivative_jobs job
      join public.space_objects object on object.id = job.object_id and object.state = 'committed'
     where job.team_id = p_team
       and (job.state = 'pending_agent' or (job.state = 'claimed' and job.lease_until < now()))
       and job.attempts < 3
       and exists (select 1 from public.team_materials material
                    where material.space_object_id = job.object_id and material.connection_id is null
                      and material.lifecycle = 'active')
     order by case job.reason when 'browser_unsupported' then 0 when 'client_skipped' then 1 else 2 end,
              job.created_at, job.object_id
     limit p_limit
     for update of job skip locked
  loop
    v_claim := gen_random_uuid();
    update public.space_derivative_jobs set state = 'claimed', claim_id = v_claim, lease_hash = p_lease_hash,
           lease_until = now() + interval '600 seconds', attempts = attempts + 1, claimed_by = p_actor,
           claimed_by_device = p_device, updated_at = now()
     where object_id = j.object_id and recipe_version = j.recipe_version;
    select material.id, material.name, material.category, object.content_id, object.content_type,
           object.byte_size, object.codec, object.fps,
           array(select d.variant from public.space_objects d
                  where d.derivative_of = object.id and d.recipe_version = 1 and d.state = 'committed'
                  order by d.variant) as made
      into v_material
      from public.team_materials material
      join public.space_objects object on object.id = material.space_object_id
     where material.space_object_id = j.object_id and material.connection_id is null and material.lifecycle = 'active'
     order by material.created_at limit 1;
    v_out := v_out || jsonb_build_object(
      'objectId', j.object_id,
      'recipeVersion', j.recipe_version,
      'claimId', v_claim,
      'reason', j.reason,
      'attempt', j.attempts + 1,
      'materialId', v_material.id,
      'name', v_material.name,
      'category', v_material.category,
      'contentId', v_material.content_id,
      'contentType', v_material.content_type,
      'bytes', v_material.byte_size::text,
      'made', to_jsonb(v_material.made),
      'needsMediaFacts', v_material.category = 'video' and (v_material.codec is null or v_material.fps is null),
      'leaseUntil', now() + interval '600 seconds');
  end loop;
  return jsonb_build_object('jobs', v_out);
end;
$$;

-- The claim a lease token stands for: what the agent may stage and where.
create function public.service_space_derivative_lease(p_team uuid, p_object uuid, p_lease_hash text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  job public.space_derivative_jobs%rowtype;
  v_category text;
  v_content text;
  v_type text;
begin
  select * into job from public.space_derivative_jobs
   where object_id = p_object and recipe_version = 1 and team_id = p_team;
  if not found or job.state <> 'claimed' or job.lease_hash is distinct from p_lease_hash then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if job.lease_until < now() then
    raise exception 'UPLOAD_EXPIRED' using errcode = '55000';
  end if;
  select object.content_id, object.content_type into v_content, v_type
    from public.space_objects object where object.id = p_object;
  select material.category into v_category from public.team_materials material
   where material.space_object_id = p_object and material.connection_id is null
   order by material.created_at limit 1;
  return jsonb_build_object(
    'objectId', p_object, 'claimId', job.claim_id, 'contentId', v_content, 'contentType', v_type,
    'category', v_category,
    -- A PDF's first page is the one picture an agent makes for a file of no media category.
    'slots', to_jsonb(case when v_type = 'application/pdf' and v_category not in ('image', 'video')
                           then array['row', 'tile', 'full'] else private.space_derivative_slots(v_category) end),
    'teamId', p_team);
end;
$$;

-- The agent's outcome under its lease. ready: the checked derivatives and the media facts it
-- read (they override the browser's); unsupported: no picture will come (FR-012); failed: tried
-- again by the next claim, until the third attempt.
create function public.service_finish_space_derivative(
  p_team uuid, p_object uuid, p_lease_hash text, p_input jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  job public.space_derivative_jobs%rowtype;
  v_outcome text := p_input ->> 'outcome';
  v_error text := nullif(p_input ->> 'errorCode', '');
  v_state text;
begin
  perform 1 from public.teams where id = p_team for no key update;
  select * into job from public.space_derivative_jobs
   where object_id = p_object and recipe_version = 1 and team_id = p_team for update;
  if not found or job.state <> 'claimed' or job.lease_hash is distinct from p_lease_hash then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if job.lease_until < now() then
    raise exception 'UPLOAD_EXPIRED' using errcode = '55000';
  end if;
  if v_outcome is null or v_outcome not in ('ready', 'unsupported', 'failed')
     or (v_error is not null and v_error !~ '^[A-Z][A-Z0-9_]{0,95}$') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if v_outcome = 'ready' then
    perform private.space_put_derivatives(p_object, coalesce(p_input -> 'derivatives', '[]'::jsonb));
    perform private.space_put_media_facts(p_object, p_input -> 'media', true);
    v_state := 'ready';
  elsif v_outcome = 'unsupported' then
    v_state := 'unsupported';
  else
    v_state := case when job.attempts >= 3 then 'failed' else 'pending_agent' end;
  end if;
  update public.space_derivative_jobs set state = v_state, claim_id = null, lease_hash = null, lease_until = null,
         error_code = case when v_outcome = 'ready' then null else coalesce(v_error, error_code) end,
         updated_at = now()
   where object_id = p_object and recipe_version = 1;
  perform private.space_object_preview_sync(p_object);
  if v_state <> 'pending_agent' then
    perform private.space_derivative_changed(p_team, p_object);
  end if;
  return jsonb_build_object('state', v_state);
end;
$$;

-- 6. Grants ----------------------------------------------------------------------------------

revoke all on function private.space_derivative_slots(text), private.space_derivative_fits(jsonb),
  private.space_object_preview_sync(uuid, text), private.space_put_derivatives(uuid, jsonb),
  private.space_put_media_facts(uuid, jsonb, boolean), private.space_derivative_changed(uuid, uuid)
  from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'public.service_declare_space_upload_derivatives(uuid, uuid, uuid, jsonb)',
    'public.service_claim_space_derivative_jobs(uuid, uuid, text, uuid, integer)',
    'public.service_space_derivative_lease(uuid, uuid, text)',
    'public.service_finish_space_derivative(uuid, uuid, text, jsonb)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
