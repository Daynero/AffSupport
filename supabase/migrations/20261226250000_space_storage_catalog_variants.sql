-- 057 T091–T100: re-stitched video variations of a catalog in an R2 space (FR-011, US9, US10;
-- research.md R15).
--
-- A Drive space keeps its own set machinery (catalog_video_sets and the native executor). An R2
-- space has none of it: a variation is an ordinary tool run of the space (team_operations, kind
-- `process`, tool `restitch`) whose output is an R2 file in the space's «Restitched» folder.
-- These tables bind the runs to the catalog creation that asked for them. Nothing below is
-- reached by a Drive space: every service function goes through private.require_space_actor,
-- which refuses a Drive space with STORAGE_BACKEND_MISMATCH, and the replaced functions are the
-- R2-only ones of 20261226150000, 20261226190000 and 20261226230000.
--
-- * private.space_catalog_variant_sets / private.space_catalog_variants — one set per creation
--   intent, one row per variation (its request id from the creation plan, the run it is on, the
--   output once the run succeeded). A run is opened by space-storage only when the variation is
--   handed to the agent (`/catalog-variants/run`), under the idempotency key
--   `space-variant:<request>:<attempt>`; at most three runs per variation.
-- * service_space_catalog_variant_defaults — the re-stitch settings the set freezes.
-- * service_admit_space_catalog_variants — the set and its rows, idempotently; its progress.
-- * service_space_catalog_variant_run / service_bind_space_catalog_variant_run — what the next
--   hand-out of a variation needs (a new run, the run it is on, or nothing), and the CAS that
--   binds a newly opened run to it.
-- * service_finalize_space_process_output (replaced) — a variation's output is registered the
--   moment its run is finalized, so it counts under `catalogs` from the first byte (US9).
-- * private.space_material_category (replaced) — an output of a live set counts under
--   `catalogs`, ahead of `process`.
-- * service_space_catalog_variant_outputs — the outputs in variation order once all are there.
-- * service_link_space_catalog_feed (replaced) — a catalog of variations links them: the set
--   is bound to the catalog, each output's R2 copy is used by it (catalog_video_r2_uses, so the
--   copies live as long as the catalog and leave with it), and no copy of the original is made.
--   A plain catalog's copy of its video is now used by it from the link on as well: a copy
--   nobody used was retired six hours after it became ready (service_catalog_video_r2_retire_orphans).
-- * service_space_catalog_variant_links — the variations' public addresses for the updater.
-- * service_read_space_catalog_variants / service_cancel_space_catalog_variants — the dialog's
--   progress read and its cancel for an R2 creation.
-- * When the catalog row is deleted for good (its feed companion leaves the trash), the set goes
--   with it (FK), and each output is deleted with reason `catalog_deleted`: its object is purged
--   from R2 at once (US10, FR-048). A catalog in the trash keeps its variations, so a restored
--   catalog still has them.
-- * private.team_validate_operation_transition (patched) — in an R2 space only, a finished
--   operation may lose its references to a file deleted for good (the FKs' `on delete set null`);
--   before, deleting any file a finished run had named raised TERMINAL_OPERATION_IMMUTABLE, so
--   such a file could never leave the trash. A Drive space raises exactly as before.

-- 1. Tables ------------------------------------------------------------------------------------

create table private.space_catalog_variant_sets (
  id uuid primary key,
  team_id uuid not null references public.teams(id) on delete cascade,
  actor_id uuid not null,
  catalog_intent_id uuid references private.catalog_generation_intents(id) on delete set null,
  source_material_id uuid references public.team_materials(id) on delete set null,
  source_content_id text not null check (source_content_id ~ '^[0-9a-f]{64}$'),
  settings jsonb not null check (jsonb_typeof(settings) = 'object'),
  settings_digest text not null check (settings_digest ~ '^[0-9a-f]{64}$'),
  variant_count integer not null check (variant_count between 1 and 400),
  state text not null default 'preparing' check (state in ('preparing', 'ready', 'canceled')),
  catalog_material_id uuid references public.team_materials(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create unique index space_catalog_variant_sets_intent on private.space_catalog_variant_sets (catalog_intent_id)
  where catalog_intent_id is not null;
create index space_catalog_variant_sets_catalog on private.space_catalog_variant_sets (catalog_material_id)
  where catalog_material_id is not null;
alter table private.space_catalog_variant_sets enable row level security;
alter table private.space_catalog_variant_sets force row level security;
revoke all on private.space_catalog_variant_sets from public, anon, authenticated, service_role;
-- jsonb and an FK to team_materials: part of the shared cleanup admission fence.
create trigger task_cleanup_reference_fence before insert or update on private.space_catalog_variant_sets
for each row execute function private.guard_task_cleanup_reference();

create table private.space_catalog_variants (
  set_id uuid not null references private.space_catalog_variant_sets(id) on delete cascade,
  ordinal integer not null check (ordinal between 0 and 399),
  request_id uuid not null unique,
  team_id uuid not null,
  attempt integer not null default 0 check (attempt between 0 and 3),
  operation_id uuid references public.team_operations(id) on delete set null,
  output_material_id uuid references public.team_materials(id) on delete set null,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (set_id, ordinal)
);
create index space_catalog_variants_output on private.space_catalog_variants (output_material_id)
  where output_material_id is not null;
create index space_catalog_variants_operation on private.space_catalog_variants (operation_id)
  where operation_id is not null;
alter table private.space_catalog_variants enable row level security;
alter table private.space_catalog_variants force row level security;
revoke all on private.space_catalog_variants from public, anon, authenticated, service_role;
create trigger task_cleanup_reference_fence before insert or update on private.space_catalog_variants
for each row execute function private.guard_task_cleanup_reference();

-- 2. Where an output counts ------------------------------------------------------------------

create function private.space_catalog_variant_output(p_material uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.space_catalog_variants v
    join private.space_catalog_variant_sets s on s.id = v.set_id
    where v.output_material_id = p_material and s.state <> 'canceled');
$$;
revoke all on function private.space_catalog_variant_output(uuid) from public, anon, authenticated;

create or replace function private.space_material_category(p_material uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when material.lifecycle <> 'active' then 'trash'
    when exists (select 1 from private.task_owned_uploads owned where owned.material_id = material.id) then 'attachments'
    when private.space_catalog_variant_output(material.id) then 'catalogs'
    when exists (
      select 1 from public.team_material_links link
      where link.derivative_material_id = material.id and link.team_id = material.team_id
        and link.relation = 'processed_from') then 'process'
    else 'materials' end
  from public.team_materials material where material.id = p_material;
$$;

-- 3. Progress --------------------------------------------------------------------------------

-- One variation as the server sees it: registered (its output is an active file), working (its
-- run is open), failed (three runs ended without an output) or pending (nothing on it yet).
create function private.space_catalog_variant_state(v private.space_catalog_variants) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when v.output_material_id is not null and exists (
      select 1 from public.team_materials m
      where m.id = v.output_material_id and m.team_id = v.team_id and m.lifecycle = 'active') then 'registered'
    when exists (
      select 1 from public.team_operations o
      where o.id = v.operation_id and o.state in ('pending', 'running')) then 'working'
    when v.attempt >= 3 then 'failed'
    else 'pending' end;
$$;
revoke all on function private.space_catalog_variant_state(private.space_catalog_variants) from public, anon, authenticated;

create function private.space_catalog_variant_progress(p_set uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s private.space_catalog_variant_sets%rowtype;
  v_rows jsonb;
  v_registered integer;
  v_failed integer;
begin
  select * into s from private.space_catalog_variant_sets where id = p_set;
  if s.id is null then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'index', v.ordinal,
           'requestId', v.request_id,
           'state', private.space_catalog_variant_state(v),
           'attempt', v.attempt,
           'operationId', v.operation_id,
           'outputMaterialId', v.output_material_id) order by v.ordinal), '[]'::jsonb),
         count(*) filter (where private.space_catalog_variant_state(v) = 'registered'),
         count(*) filter (where private.space_catalog_variant_state(v) = 'failed')
    into v_rows, v_registered, v_failed
  from private.space_catalog_variants v where v.set_id = p_set;
  return jsonb_build_object(
    'setId', s.id,
    'catalogIntentId', s.catalog_intent_id,
    'requestedCount', s.variant_count,
    'registeredCount', v_registered,
    'state', case
      when s.state = 'canceled' then 'canceled'
      when v_failed > 0 then 'unknown'
      when s.state = 'ready' or v_registered = s.variant_count then 'ready'
      else 'preparing' end,
    'variants', v_rows);
end;
$$;
revoke all on function private.space_catalog_variant_progress(uuid) from public, anon, authenticated;

-- 4. The settings a set freezes, and the set ----------------------------------------------------

create function public.service_space_catalog_variant_defaults(p_team uuid, p_actor uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_space_actor(p_team, p_actor, 'process');
  return private.effective_restitch_defaults_json(p_team, p_actor);
end;
$$;

create function public.service_admit_space_catalog_variants(
  p_team uuid, p_actor uuid, p_intent uuid, p_set uuid, p_source uuid,
  p_requests uuid[], p_settings jsonb, p_settings_digest text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s private.space_catalog_variant_sets%rowtype;
  v_content text;
  v_index integer;
begin
  if p_set is null or p_intent is null or p_source is null or p_requests is null
     or cardinality(p_requests) not between 1 and 400
     or cardinality(p_requests) <> cardinality(array(select distinct unnest(p_requests)))
     or array_position(p_requests, null) is not null
     or (p_settings is not null and (jsonb_typeof(p_settings) <> 'object'
         or p_settings_digest is null or p_settings_digest !~ '^[0-9a-f]{64}$')) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform 1 from public.teams where id = p_team for no key update;
  perform private.require_space_actor(p_team, p_actor, 'process');
  perform private.require_space_actor(p_team, p_actor, 'upload');
  if not exists (
    select 1 from private.catalog_generation_intents i
    where i.id = p_intent and i.team_id = p_team and i.actor_id = p_actor
      and i.video_material_id = p_source
      and i.request_payload ->> 'catalogVideoProtocolVersion' = '1'
      and i.request_payload ->> 'restitchEnabled' = 'true'
      and i.state <> 'canceled'
  ) then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;

  select * into s from private.space_catalog_variant_sets where catalog_intent_id = p_intent for update;
  if s.id is not null then
    -- The same plan admitted again (a resumed creation) answers what it admitted.
    if s.id <> p_set or s.team_id <> p_team or s.actor_id <> p_actor
       or s.source_material_id is distinct from p_source or s.variant_count <> cardinality(p_requests)
       or (select array_agg(v.request_id order by v.ordinal) from private.space_catalog_variants v where v.set_id = s.id)
          is distinct from p_requests then
      raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode = '55000';
    end if;
    return private.space_catalog_variant_progress(s.id);
  end if;
  -- A new set freezes settings that make a file (the caller parsed them); none: nothing to admit.
  if p_settings is null then raise exception 'RESTITCH_INVALID' using errcode = '22023'; end if;

  select object.content_id into v_content
  from public.team_materials material
  join public.space_objects object on object.id = material.space_object_id and object.team_id = material.team_id
  where material.id = p_source and material.team_id = p_team and material.connection_id is null
    and material.kind = 'file' and material.category = 'video' and material.lifecycle = 'active'
    and object.kind = 'original' and object.state = 'committed';
  if v_content is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  insert into private.space_catalog_variant_sets (
    id, team_id, actor_id, catalog_intent_id, source_material_id, source_content_id,
    settings, settings_digest, variant_count)
  values (p_set, p_team, p_actor, p_intent, p_source, v_content,
    p_settings, p_settings_digest, cardinality(p_requests));
  for v_index in 1 .. cardinality(p_requests) loop
    insert into private.space_catalog_variants (set_id, ordinal, request_id, team_id)
    values (p_set, v_index - 1, p_requests[v_index], p_team);
  end loop;
  return private.space_catalog_variant_progress(p_set);
end;
$$;

-- 5. Handing a variation to the agent ---------------------------------------------------------

create function public.service_space_catalog_variant_run(
  p_team uuid, p_actor uuid, p_set uuid, p_index integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s private.space_catalog_variant_sets%rowtype;
  v private.space_catalog_variants%rowtype;
  v_state text;
  v_source record;
begin
  perform private.require_space_actor(p_team, p_actor, 'process');
  select * into s from private.space_catalog_variant_sets where id = p_set and team_id = p_team;
  -- Only the member who asked for the catalog hands its variations to an agent (their own).
  if s.id is null or s.actor_id <> p_actor then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  select * into v from private.space_catalog_variants where set_id = p_set and ordinal = p_index for update;
  if v.set_id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if s.state = 'canceled' then return jsonb_build_object('state', 'canceled', 'index', p_index); end if;
  v_state := private.space_catalog_variant_state(v);
  if v_state = 'registered' then
    return jsonb_build_object('state', 'registered', 'index', p_index, 'outputMaterialId', v.output_material_id);
  end if;
  if v_state = 'failed' then return jsonb_build_object('state', 'failed', 'index', p_index); end if;
  select material.id, material.name into v_source
  from public.team_materials material
  join public.space_objects object on object.id = material.space_object_id and object.team_id = material.team_id
  where material.id = s.source_material_id and material.team_id = p_team and material.lifecycle = 'active'
    and object.content_id = s.source_content_id and object.state = 'committed';
  if v_source.id is null then raise exception 'SOURCE_CHANGED' using errcode = '55000'; end if;
  return jsonb_build_object(
    'state', case when v_state = 'working' then 'running' else 'open' end,
    'index', p_index,
    'requestId', v.request_id,
    'attempt', case when v_state = 'working' then v.attempt else v.attempt + 1 end,
    'operationId', case when v_state = 'working' then v.operation_id else null end,
    'destinationFolderId', case when v_state = 'working'
      then (select o.destination_folder_id from public.team_operations o where o.id = v.operation_id) else null end,
    'sourceMaterialId', v_source.id,
    'sourceName', v_source.name,
    'variantCount', s.variant_count,
    'settings', s.settings,
    'settingsDigest', s.settings_digest);
end;
$$;

create function public.service_bind_space_catalog_variant_run(
  p_team uuid, p_actor uuid, p_set uuid, p_index integer, p_attempt integer, p_operation uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s private.space_catalog_variant_sets%rowtype;
  v private.space_catalog_variants%rowtype;
  o public.team_operations%rowtype;
begin
  perform private.require_space_actor(p_team, p_actor, 'process');
  select * into s from private.space_catalog_variant_sets where id = p_set and team_id = p_team and actor_id = p_actor;
  if s.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if s.state = 'canceled' then raise exception 'WRONG_STATE' using errcode = '55000'; end if;
  select * into v from private.space_catalog_variants where set_id = p_set and ordinal = p_index for update;
  select * into o from public.team_operations where id = p_operation;
  if v.set_id is null or o.id is null or o.team_id <> p_team or o.actor_id <> p_actor or o.kind <> 'process'
     or o.source_material_id is distinct from s.source_material_id
     or o.idempotency_key <> 'space-variant:' || v.request_id::text || ':' || p_attempt::text then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;
  -- The same run bound twice (a retried hand-out) is the binding it already is.
  if v.attempt = p_attempt and v.operation_id = p_operation then
    return jsonb_build_object('bound', true, 'operationId', p_operation);
  end if;
  if p_attempt <> v.attempt + 1 or p_attempt > 3
     or private.space_catalog_variant_state(v) not in ('pending') then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;
  update private.space_catalog_variants
     set attempt = p_attempt, operation_id = p_operation, output_material_id = null, updated_at = clock_timestamp()
   where set_id = p_set and ordinal = p_index;
  return jsonb_build_object('bound', true, 'operationId', p_operation);
end;
$$;

-- 6. A variation's output is registered when its run is finalized ----------------------------

create function private.space_catalog_variant_finalized(p_operation uuid, p_material uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update private.space_catalog_variants
     set output_material_id = p_material, updated_at = clock_timestamp()
   where operation_id = p_operation and output_material_id is distinct from p_material;
  if found then
    perform private.space_material_ref_sync(p_material);
  end if;
end;
$$;
revoke all on function private.space_catalog_variant_finalized(uuid, uuid) from public, anon, authenticated;

create or replace function public.service_finalize_space_process_output(
  p_operation uuid, p_actor uuid, p_upload uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o public.team_operations%rowtype;
  i private.team_operation_intents%rowtype;
  u public.space_uploads%rowtype;
  v_source_name text;
  v_parent uuid;
begin
  select * into o from public.team_operations where id = p_operation and actor_id = p_actor for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if o.kind <> 'process' then raise exception 'WRONG_STATE' using errcode = '55000'; end if;
  if o.state = 'succeeded' then
    return jsonb_build_object('operationId', o.id, 'state', 'succeeded',
      'materialId', o.result_material_id, 'reused', true);
  end if;
  if o.state <> 'running' then raise exception 'WRONG_STATE' using errcode = '55000'; end if;
  perform 1 from public.teams where id = o.team_id for no key update;
  perform private.require_space_actor(o.team_id, p_actor, 'process');

  select * into i from private.team_operation_intents where operation_id = o.id;
  if not found or i.tool_id is null or i.version_of_material_id is not null or o.source_material_id is null then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;

  select * into u from public.space_uploads
   where id = p_upload and team_id = o.team_id and actor_id = p_actor and ingress = 'agent_output'
     and idempotency_key = 'process_output_' || o.id::text
   for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if u.state <> 'committed' or u.result_material_id is null then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;

  select material.name into v_source_name from public.team_materials material
   where material.id = o.source_material_id and material.team_id = o.team_id;
  insert into public.team_material_links (
    team_id, source_material_id, derivative_material_id, relation, source_name_snapshot,
    tool_id, tool_contract_version, created_by)
  values (
    o.team_id, o.source_material_id, u.result_material_id, 'processed_from',
    coalesce(v_source_name, u.name), i.tool_id, i.tool_contract_version, p_actor)
  on conflict (team_id, source_material_id, derivative_material_id, relation) do nothing;
  perform private.space_material_ref_sync(u.result_material_id);

  perform public.service_transition_team_operation(
    o.id, 'succeeded', 'completed', 100, u.result_material_id, null, false);
  -- 057 T092: a catalog variation's output belongs to its catalog from now on.
  perform private.space_catalog_variant_finalized(o.id, u.result_material_id);

  select (material.parent_folder_id)::uuid into v_parent from public.team_materials material
   where material.id = u.result_material_id;
  perform private.space_content_changed(o.team_id, v_parent, true);
  return jsonb_build_object('operationId', o.id, 'state', 'succeeded',
    'materialId', u.result_material_id, 'reused', false);
end;
$$;

-- 7. The outputs, in variation order, once every one is there ----------------------------------

create function public.service_space_catalog_variant_outputs(p_team uuid, p_actor uuid, p_set uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  s private.space_catalog_variant_sets%rowtype;
  v_progress jsonb;
begin
  perform private.require_space_actor(p_team, p_actor, 'view');
  select * into s from private.space_catalog_variant_sets where id = p_set and team_id = p_team and actor_id = p_actor;
  if s.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  v_progress := private.space_catalog_variant_progress(p_set);
  if v_progress ->> 'state' <> 'ready' then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode = '55000'; end if;
  return (
    select jsonb_agg(jsonb_build_object('index', v.ordinal, 'materialId', v.output_material_id) order by v.ordinal)
    from private.space_catalog_variants v where v.set_id = p_set);
end;
$$;

-- 8. Linking a catalog --------------------------------------------------------------------------

-- The catalog uses this copy of a file of its space (planned or ready): the copy lives as long as
-- a catalog uses it, and its ready signal reaches the catalog.
create function private.space_catalog_use_copy(p_catalog uuid, p_team uuid, p_material uuid, p_required boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c private.catalog_video_r2_copies%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('catalog-video-r2:' || p_team::text, 0));
  select copy.* into c
  from private.catalog_video_r2_copies copy
  join public.team_materials material on material.id = copy.source_material_id and material.team_id = copy.team_id
  join public.space_objects object on object.id = material.space_object_id and object.team_id = material.team_id
  where copy.team_id = p_team and copy.source_material_id = p_material
    and copy.source_version = object.content_id and copy.state not in ('deleted', 'failed')
  order by copy.created_at desc limit 1
  for update of copy;
  if c.id is null then
    if p_required then raise exception 'VIDEO_R2_SOURCE_UNAVAILABLE' using errcode = '55000'; end if;
    return;
  end if;
  if c.state = 'retiring' then
    update private.catalog_video_r2_copies set state = 'ready', retire_after = null, retire_reason = null where id = c.id;
  end if;
  update private.catalog_video_r2_copies set requested_by_catalog = p_catalog
   where id = c.id and requested_by_catalog is null;
  insert into private.catalog_video_r2_uses (catalog_material_id, source_material_id, copy_id, team_id)
  values (p_catalog, p_material, c.id, p_team)
  on conflict (catalog_material_id, source_material_id) do update set copy_id = excluded.copy_id, confirmed_at = clock_timestamp();
end;
$$;
revoke all on function private.space_catalog_use_copy(uuid, uuid, uuid, boolean) from public, anon, authenticated;

create or replace function public.service_link_space_catalog_feed(
  p_team uuid, p_video uuid, p_companion uuid, p_replaces uuid, p_record jsonb, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_feed text := p_record ->> 'feedId';
  v_bytes text := p_record ->> 'feedBytes';
  v_set_text text := p_record ->> 'spaceVariantSetId';
  s private.space_catalog_variant_sets%rowtype;
  v_output uuid;
  result jsonb;
begin
  if p_record is null or jsonb_typeof(p_record) <> 'object'
     or v_feed is null or v_feed !~ '^[0-9a-f]{32}$' or v_bytes is null or v_bytes !~ '^[1-9][0-9]{0,8}$'
     or (v_set_text is not null and v_set_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform private.require_space_actor(p_team, p_actor, 'upload');
  if not exists (
    select 1 from public.team_materials companion
    where companion.id = p_companion and companion.team_id = p_team and companion.connection_id is null
      and companion.mime_type = 'text/csv' and companion.companion_kind = 'product_catalog'
  ) then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;
  if v_set_text is not null then
    -- A catalog of variations: its set must be this video's, this member's and complete.
    select * into s from private.space_catalog_variant_sets
     where id = v_set_text::uuid and team_id = p_team and actor_id = p_actor and source_material_id = p_video
     for update;
    if s.id is null or s.state = 'canceled' or (s.catalog_material_id is not null and s.catalog_material_id <> p_companion)
       or private.space_catalog_variant_progress(s.id) ->> 'state' <> 'ready' then
      raise exception 'WRONG_STATE' using errcode = '55000';
    end if;
  end if;
  result := public.service_link_product_catalog_companion(
    p_team, p_video, p_companion, p_replaces, p_record - 'feedId' - 'feedBytes' - 'spaceVariantSetId');
  if coalesce((result ->> 'linked')::boolean, false) then
    perform public.service_record_catalog_feed(p_companion, v_feed, v_bytes::bigint, 0);
    -- The video of an R2 space's catalog is always its R2 copy: the preference is part of it,
    -- not a setting (050's set_preference asks for catalog settings rights; this does not).
    insert into private.catalog_video_r2_preferences(catalog_material_id, team_id, enabled, configured_by)
    values (p_companion, p_team, true, p_actor)
    on conflict (catalog_material_id) do update set
      enabled = true,
      revision = private.catalog_video_r2_preferences.revision + 1,
      configured_by = excluded.configured_by,
      updated_at = clock_timestamp();
    perform private.catalog_video_r2_journal_write(p_team, null, p_companion, null, p_actor, 'configured', null);
    if s.id is not null then
      update private.space_catalog_variant_sets
         set state = 'ready', catalog_material_id = p_companion, updated_at = clock_timestamp()
       where id = s.id;
      for v_output in
        select v.output_material_id from private.space_catalog_variants v where v.set_id = s.id order by v.ordinal
      loop
        perform private.space_catalog_use_copy(p_companion, p_team, v_output, true);
      end loop;
      -- The initial publication of a catalog of variations is its feed: nothing is owed to the
      -- Drive re-verification lane (service_list_initial_catalog_recovery), so it never lists it.
      if s.catalog_intent_id is not null then
        insert into private.catalog_initial_publication_reverify (intent_id, team_id, exhausted_at)
        values (s.catalog_intent_id, p_team, clock_timestamp())
        on conflict (intent_id) do update set exhausted_at = coalesce(private.catalog_initial_publication_reverify.exhausted_at, excluded.exhausted_at);
      end if;
    else
      -- Best effort: the copy was planned before the feed was written; a missing one is the
      -- updater's to resolve again, as before.
      perform private.space_catalog_use_copy(p_companion, p_team, p_video, false);
    end if;
    perform private.catalog_video_r2_signal(p_companion);
    if s.id is null then
      perform public.service_catalog_video_r2_resolve_current(p_companion);
    end if;
  end if;
  return result;
end;
$$;

-- 9. The variations' public addresses, for the updater -----------------------------------------

create function public.service_space_catalog_variant_links(p_catalog uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when s.id is null then null else (
    select jsonb_agg(cfg.public_origin || '/' || copy.object_key order by v.ordinal)
    from private.space_catalog_variants v
    join private.catalog_video_r2_uses use on use.catalog_material_id = s.catalog_material_id
      and use.source_material_id = v.output_material_id
    join private.catalog_video_r2_copies copy on copy.id = use.copy_id
    cross join private.catalog_video_r2_config cfg
    where v.set_id = s.id and cfg.public_origin is not null
    having count(*) = s.variant_count) end
  from (select null) as one
  left join private.space_catalog_variant_sets s on s.catalog_material_id = p_catalog and s.state = 'ready';
$$;

-- 10. The dialog's read and cancel --------------------------------------------------------------

create function public.service_read_space_catalog_variants(p_team uuid, p_actor uuid, p_key text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  i private.catalog_generation_intents%rowtype;
  s private.space_catalog_variant_sets%rowtype;
  v_progress jsonb;
begin
  perform private.require_space_actor(p_team, p_actor, 'view');
  select * into i from private.catalog_generation_intents
   where team_id = p_team and actor_id = p_actor and request_key = p_key;
  if i.id is null then return null; end if;
  if i.state = 'registered' then return i.result; end if;
  select * into s from private.space_catalog_variant_sets where catalog_intent_id = i.id;
  if s.id is null then return null; end if;
  v_progress := private.space_catalog_variant_progress(s.id);
  return jsonb_build_object(
    'outcome', 'preparing_video',
    'catalogIntentId', i.id,
    'videoSetId', s.id,
    'requestedCount', s.variant_count,
    'registeredCount', (v_progress ->> 'registeredCount')::integer,
    -- A complete set is still «preparing» until the catalog is registered: the dialog resumes it.
    'state', case
      when i.state = 'canceled' or s.state = 'canceled' then 'canceled'
      when v_progress ->> 'state' = 'unknown' then 'unknown'
      else 'preparing' end);
end;
$$;

create function public.service_cancel_space_catalog_variants(p_team uuid, p_actor uuid, p_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  i private.catalog_generation_intents%rowtype;
  s private.space_catalog_variant_sets%rowtype;
  v_operation uuid;
begin
  perform private.require_space_actor(p_team, p_actor, 'process');
  select * into i from private.catalog_generation_intents
   where team_id = p_team and actor_id = p_actor and request_key = p_key for update;
  if i.id is null then raise exception 'WRONG_STATE' using errcode = '55000'; end if;
  select * into s from private.space_catalog_variant_sets where catalog_intent_id = i.id for update;
  if s.id is null or i.state = 'registered' or i.operation_id is not null
     or i.state in ('create_started', 'created', 'finalized') then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;
  update private.space_catalog_variant_sets set state = 'canceled', updated_at = clock_timestamp()
   where id = s.id and state <> 'canceled';
  for v_operation in
    select o.id from private.space_catalog_variants v
    join public.team_operations o on o.id = v.operation_id
    where v.set_id = s.id and o.state in ('pending', 'running')
  loop
    perform public.service_transition_team_operation(v_operation, 'canceled', 'canceled', 0, null, null, false);
  end loop;
  update private.catalog_generation_intents
     set state = 'canceled', lease_owner = null, lease_expires_at = null, next_attempt_at = null, updated_at = clock_timestamp()
   where id = i.id and state <> 'canceled';
  -- Outputs already made stay as files of the space; they no longer count under catalogs.
  perform private.space_material_ref_sync(v.output_material_id)
     from private.space_catalog_variants v where v.set_id = s.id and v.output_material_id is not null;
  return jsonb_build_object(
    'outcome', 'preparing_video',
    'catalogIntentId', i.id,
    'videoSetId', s.id,
    'requestedCount', s.variant_count,
    'registeredCount', (private.space_catalog_variant_progress(s.id) ->> 'registeredCount')::integer,
    'state', 'canceled');
end;
$$;

-- 11. A catalog deleted for good takes its variations with it ---------------------------------

create function private.space_catalog_variant_removed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_previous text := coalesce(pg_catalog.current_setting('soty.space_purge_reason', true), '');
begin
  if old.output_material_id is null then return null; end if;
  perform pg_catalog.set_config('soty.space_purge_reason', 'catalog_deleted', true);
  begin
    -- Its own provenance goes with it (the link restricts the delete); anything made from it
    -- since still restricts it, and then the file stays.
    delete from public.team_material_links
     where team_id = old.team_id and derivative_material_id = old.output_material_id and relation = 'processed_from';
    delete from public.team_materials
     where id = old.output_material_id and team_id = old.team_id and connection_id is null;
  exception when foreign_key_violation then
    -- Still referenced elsewhere (a task, another catalog): the file stays where it is.
    null;
  end;
  perform pg_catalog.set_config('soty.space_purge_reason', v_previous, true);
  return null;
end;
$$;
revoke all on function private.space_catalog_variant_removed() from public, anon, authenticated;
-- Only a set that belonged to a catalog leaves with it: the set row is deleted by its FK when the
-- catalog companion row is deleted. An abandoned set (no catalog) keeps its files.
create function private.space_catalog_variant_set_removed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.catalog_material_id is null then
    -- Its rows cascade without taking the files: detach them first.
    update private.space_catalog_variants set output_material_id = null where set_id = old.id;
  end if;
  return old;
end;
$$;
revoke all on function private.space_catalog_variant_set_removed() from public, anon, authenticated;
create trigger space_catalog_variant_set_removed before delete on private.space_catalog_variant_sets
for each row execute function private.space_catalog_variant_set_removed();
create trigger space_catalog_variant_removed after delete on private.space_catalog_variants
for each row execute function private.space_catalog_variant_removed();

-- 12. A file of an R2 space deleted for good leaves its finished runs -------------------------

-- The operation FKs say `on delete set null`, but a finished operation is immutable, so deleting
-- any file a finished run named (its source, its folder, its output) raised
-- TERMINAL_OPERATION_IMMUTABLE: an R2 trash with a tool's output in it could not be emptied, and
-- a catalog's variations could not leave with it. In an R2 space only, a finished operation may
-- lose exactly those references to null and nothing else. A Drive space raises as before.
do $guard$
declare d text;
begin
  select pg_get_functiondef('private.team_validate_operation_transition()'::regprocedure) into d;
  if strpos(d, '    raise exception ''TERMINAL_OPERATION_IMMUTABLE'' using errcode = ''23514'';') = 0 then
    raise exception 'TERMINAL_OPERATION_GUARD_PATCH_MISSING';
  end if;
  d := replace(d,
    '    raise exception ''TERMINAL_OPERATION_IMMUTABLE'' using errcode = ''23514'';',
    '    if to_jsonb(new) - ''source_material_id'' - ''destination_folder_id'' - ''result_material_id'' - ''updated_at''
         = to_jsonb(old) - ''source_material_id'' - ''destination_folder_id'' - ''result_material_id'' - ''updated_at''
       and (new.source_material_id is null or new.source_material_id is not distinct from old.source_material_id)
       and (new.destination_folder_id is null or new.destination_folder_id is not distinct from old.destination_folder_id)
       and (new.result_material_id is null or new.result_material_id is not distinct from old.result_material_id)
       and exists (select 1 from public.teams team where team.id = old.team_id and team.storage_backend = ''r2'') then
      return new;
    end if;
    raise exception ''TERMINAL_OPERATION_IMMUTABLE'' using errcode = ''23514'';');
  execute d;
end;
$guard$;

-- Grants -----------------------------------------------------------------------------------------

revoke all on function public.service_space_catalog_variant_defaults(uuid, uuid) from public, anon, authenticated;
revoke all on function public.service_admit_space_catalog_variants(uuid, uuid, uuid, uuid, uuid, uuid[], jsonb, text) from public, anon, authenticated;
revoke all on function public.service_space_catalog_variant_run(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.service_bind_space_catalog_variant_run(uuid, uuid, uuid, integer, integer, uuid) from public, anon, authenticated;
revoke all on function public.service_space_catalog_variant_outputs(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.service_space_catalog_variant_links(uuid) from public, anon, authenticated;
revoke all on function public.service_read_space_catalog_variants(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.service_cancel_space_catalog_variants(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.service_space_catalog_variant_defaults(uuid, uuid) to service_role;
grant execute on function public.service_admit_space_catalog_variants(uuid, uuid, uuid, uuid, uuid, uuid[], jsonb, text) to service_role;
grant execute on function public.service_space_catalog_variant_run(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.service_bind_space_catalog_variant_run(uuid, uuid, uuid, integer, integer, uuid) to service_role;
grant execute on function public.service_space_catalog_variant_outputs(uuid, uuid, uuid) to service_role;
grant execute on function public.service_space_catalog_variant_links(uuid) to service_role;
grant execute on function public.service_read_space_catalog_variants(uuid, uuid, text) to service_role;
grant execute on function public.service_cancel_space_catalog_variants(uuid, uuid, text) to service_role;
