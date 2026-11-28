-- 057 T116/T117: a Launch catalog of an R2 space with several creatives or pictures publishes its
-- links later (research.md R15 «Пізнє посилання для кількох креативів»).
--
-- The lane is T102's (20261226300000): the link registers the scheduled policy in its own
-- transaction, the feed's claim takes the job when it is due, the feed's writer writes it. What a
-- catalog of several creatives needs on top is the publication target per creative — the 062 kind
-- 'creatives' (20261221116000), one segment per block of rows:
--
-- * private.register_space_catalog_publication (replaced) — a creation of several creatives or of
--   pictures registers a 'creatives' target from its frozen plan's segments, each named by its
--   space content (`space-v1:<content id>`); a re-stitched segment keeps that name too (its
--   variations are the space set bound to the catalog, found by catalog and video, as for
--   'source': the segment's video_set_id is a Drive recipe key). One video keeps 'source'.
-- * private.space_catalog_publication_source_version (replaced) — a picture is named by its
--   content as a video is, so a picture segment matches its space file (the Drive versions are
--   another function and untouched).
-- * service_space_catalog_publication_context (replaced) — a 'creatives' target answers its
--   segments with their rows: a video's R2 copy, a re-stitched video's variations (with the
--   segment's seed and rows), a picture's published `c1/` address; `waiting` while a copy is not
--   ready; a receipt `r2` for every address. The 'source' answer is the text it was.
-- * private.space_catalog_publication_removed (replaced) — an R2 catalog deleted for good takes
--   the segments of its targets too (their key has no cascade; before, a 'creatives' target would
--   have kept the catalog in the trash for good).
--
-- Growth of a 'creatives' target stays refused for every space (prepare_catalog_growth_video_recipe,
-- MULTI_CREATIVE_UNSUPPORTED); the manager's hold, reschedule and «add now» re-save the same
-- target (service_save_catalog_publication, 20261221116000). Nothing here is reached by a Drive
-- catalog: every function is an R2 one.

-- 1. A picture of a space is named by its content too -------------------------------------------

create or replace function private.space_catalog_publication_source_version(p_material uuid, p_team uuid) returns text
language sql stable security definer set search_path = '' as $$
  select 'space-v1:' || object.content_id
  from public.team_materials material
  join public.space_objects object on object.id = material.space_object_id and object.team_id = material.team_id
  where material.id = p_material and material.team_id = p_team and material.connection_id is null
    and material.kind = 'file' and material.category in ('video', 'image')
    and object.kind = 'original' and object.state = 'committed' and object.content_id ~ '^[0-9a-f]{64}$';
$$;
revoke all on function private.space_catalog_publication_source_version(uuid, uuid) from public, anon, authenticated, service_role;

-- 2. The target of several creatives --------------------------------------------------------------

-- The segments of the creation's plan (or one block of every row for a plan without them), each
-- a live space file of the catalog's kind at its content; a re-stitched one must have its set
-- bound to the catalog already (the link bound it in this transaction).
create function private.register_space_catalog_creatives_target(
  p_team uuid, p_catalog uuid, p_primary uuid, p_plan jsonb, p_kind text, p_product_count integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  segs jsonb := case when jsonb_typeof(p_plan -> 'segments') = 'array' then p_plan -> 'segments' else '[]'::jsonb end;
  seg jsonb;
  v_target uuid;
  v_material uuid;
  v_version text;
  total integer := 0;
begin
  if p_kind not in ('video', 'image') then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  if jsonb_array_length(segs) = 0 then
    segs := jsonb_build_array(jsonb_build_object('ordinal', 0, 'materialId', p_primary, 'kind', p_kind,
      'rowStart', 0, 'rowCount', p_product_count, 'setId', null));
  end if;
  insert into private.catalog_publication_targets (team_id, kind) values (p_team, 'creatives') returning id into v_target;
  for seg in select value from jsonb_array_elements(segs) order by (value ->> 'ordinal')::integer loop
    if seg ->> 'kind' is distinct from p_kind or (seg ->> 'rowStart')::integer is distinct from total
       or (seg ->> 'rowCount')::integer is null or (seg ->> 'rowCount')::integer < 1 then
      raise exception 'WRONG_STATE' using errcode = '55000';
    end if;
    select material.id into v_material from public.team_materials material
     where material.id = (seg ->> 'materialId')::uuid and material.team_id = p_team and material.connection_id is null
       and material.lifecycle = 'active' and material.category = p_kind;
    v_version := private.space_catalog_publication_source_version(v_material, p_team);
    if v_material is null or v_version is null then raise exception 'SOURCE_CHANGED' using errcode = '55000'; end if;
    if jsonb_typeof(seg -> 'setId') = 'string' and not exists (
      select 1 from private.space_catalog_variant_sets s
      where s.catalog_material_id = p_catalog and s.team_id = p_team and s.source_material_id = v_material
        and s.state = 'ready') then
      raise exception 'WRONG_STATE' using errcode = '55000';
    end if;
    insert into private.catalog_publication_target_segments (
      target_id, ordinal, team_id, kind, source_material_id, source_version, row_start, row_count)
    values (v_target, (seg ->> 'ordinal')::integer, p_team, p_kind, v_material, v_version,
      (seg ->> 'rowStart')::integer, (seg ->> 'rowCount')::integer);
    total := total + (seg ->> 'rowCount')::integer;
  end loop;
  if total <> p_product_count then raise exception 'WRONG_STATE' using errcode = '55000'; end if;
  return v_target;
end;
$$;
revoke all on function private.register_space_catalog_creatives_target(uuid, uuid, uuid, jsonb, text, integer) from public, anon, authenticated, service_role;

create or replace function private.register_space_catalog_publication(p_team uuid, p_actor uuid, p_catalog uuid, p_key text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  i private.catalog_generation_intents%rowtype;
  plan jsonb;
  due timestamptz;
  zone text;
  v_version text;
  v_target uuid;
  v_kind text;
  v_count integer;
begin
  select * into i from private.catalog_generation_intents
   where team_id = p_team and actor_id = p_actor and request_key = p_key for update;
  plan := i.checkpoint -> 'initialVideoPlan';
  if i.id is null or i.request_payload ->> 'catalogVideoProtocolVersion' is distinct from '1'
     or i.request_payload #>> '{videoPublication,mode}' is distinct from 'scheduled'
     or jsonb_typeof(plan) is distinct from 'object'
     or plan #> '{preferences,videoPublication}' is distinct from i.request_payload -> 'videoPublication'
     or i.video_material_id is null then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;
  -- The same link answered twice (a resumed creation) registers nothing new.
  if exists (select 1 from private.catalog_video_publication_policies where catalog_material_id = p_catalog) then
    return;
  end if;
  due := (plan #>> '{preferences,videoPublication,dueAt}')::timestamptz;
  zone := plan #>> '{preferences,videoPublication,timeZone}';
  if due is null or not isfinite(due) or due <= to_timestamp((plan ->> 'acceptedAt')::numeric / 1000)
     or not exists (select 1 from pg_timezone_names where name = zone) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  v_kind := coalesce(i.request_payload ->> 'creativeKind', 'video');
  if v_kind = 'image' or jsonb_array_length(
       case when jsonb_typeof(plan -> 'segments') = 'array' then plan -> 'segments' else '[]'::jsonb end) > 1 then
    -- T117: several creatives or pictures — a target per creative, its rows the plan's blocks.
    select c.product_count into v_count from public.team_product_catalogs c
     where c.material_id = p_catalog and c.team_id = p_team;
    if v_count is null then raise exception 'WRONG_STATE' using errcode = '55000'; end if;
    v_target := private.register_space_catalog_creatives_target(p_team, p_catalog, i.video_material_id, plan, v_kind, v_count);
  else
    v_version := private.space_catalog_publication_source_version(i.video_material_id, p_team);
    if v_version is null then raise exception 'SOURCE_CHANGED' using errcode = '55000'; end if;
    insert into private.catalog_publication_targets (team_id, kind, source_material_id, source_version)
    values (p_team, 'source', i.video_material_id, v_version) returning id into v_target;
  end if;
  insert into private.catalog_video_publication_policies (
    catalog_material_id, team_id, actor_id, revision, mode, due_at, time_zone, legacy_delivery_unverified, target_id)
  values (p_catalog, p_team, p_actor, 1, 'scheduled', due, zone, false, v_target);
  insert into private.catalog_publication_commands (request_id, team_id, actor_id, payload, receipt)
  values (i.id, p_team, p_actor,
    jsonb_build_object('catalogId', p_catalog, 'mode', 'scheduled', 'dueAt', due, 'timeZone', zone,
      'target', private.catalog_publication_target_json(v_target)),
    '{}'::jsonb);
  insert into private.catalog_video_publication_jobs (catalog_material_id, team_id, revision, command_id, target_id, actor_id, state)
  values (p_catalog, p_team, 1, i.id, v_target, p_actor, 'waiting');
  update private.catalog_publication_commands
     set receipt = public.service_read_catalog_publication(p_team, p_actor, p_catalog)
   where request_id = i.id and team_id = p_team and actor_id = p_actor;
end;
$$;
revoke all on function private.register_space_catalog_publication(uuid, uuid, uuid, text) from public, anon, authenticated, service_role;

-- 3. What the feed's writer writes for several creatives -----------------------------------------

-- {state, feedId, productCount, creativeKind, sources, segments:[{ordinal, kind, rowStart,
-- rowCount, sources, assignmentSeed?, recipeRowIds?}]}: `sources` is every address in segment
-- order (each segment's own list is what its rows link); `blocked` (with SOURCE_CHANGED when a
-- creative is not the content its segment names) or `waiting` (a copy not ready yet) otherwise.
create function private.space_catalog_creatives_publication_context(
  p_job uuid, p_team uuid, p_actor uuid, p_catalog uuid, p_target uuid, p_feed text, p_count integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  g private.catalog_publication_target_segments%rowtype;
  s private.space_catalog_variant_sets%rowtype;
  plan jsonb;
  seg jsonb;
  v_link jsonb;
  v_url text;
  v_sources jsonb;
  v_all jsonb := '[]'::jsonb;
  v_segments jsonb := '[]'::jsonb;
  v_ready boolean;
  v_kind text;
  r record;
begin
  for g in select * from private.catalog_publication_target_segments where target_id = p_target and team_id = p_team order by ordinal loop
    v_kind := g.kind;
    s := null;
    select * into s from private.space_catalog_variant_sets x
     where x.catalog_material_id = p_catalog and x.team_id = p_team and x.source_material_id = g.source_material_id
       and g.kind = 'video'
     order by (x.state = 'ready') desc limit 1;
    -- A re-stitched video links its variations or nothing: never its original instead.
    if s.id is not null and s.state <> 'ready' then return jsonb_build_object('state', 'blocked'); end if;
    if s.id is not null then
      -- A re-stitched video: its variations, over its own rows and with its own seed.
      select i.checkpoint -> 'initialVideoPlan' into plan from private.catalog_generation_intents i where i.id = s.catalog_intent_id;
      seg := null;
      select e.value into seg from jsonb_array_elements(case when jsonb_typeof(plan -> 'segments') = 'array' then plan -> 'segments' else '[]'::jsonb end) e
       where (e.value ->> 'ordinal')::integer = g.ordinal and lower(e.value ->> 'materialId') = g.source_material_id::text;
      if jsonb_typeof(plan -> 'recipeRowIds') is distinct from 'array' or seg is null
         or jsonb_typeof(seg -> 'setId') is distinct from 'string' or seg ->> 'assignmentSeed' is null then
        return jsonb_build_object('state', 'blocked');
      end if;
      v_sources := '[]'::jsonb;
      for r in select v.output_material_id from private.space_catalog_variants v where v.set_id = s.id order by v.ordinal loop
        if r.output_material_id is null then return jsonb_build_object('state', 'blocked'); end if;
        v_link := public.service_space_catalog_video_link(p_team, p_actor, r.output_material_id);
        v_sources := v_sources || jsonb_build_array(jsonb_build_object('materialId', r.output_material_id,
          'url', v_link ->> 'url', 'sourceVersion', v_link ->> 'sourceVersion', 'ready', v_link ->> 'state' = 'ready'));
      end loop;
      v_segments := v_segments || jsonb_build_array(jsonb_build_object(
        'ordinal', g.ordinal, 'kind', g.kind, 'rowStart', g.row_start, 'rowCount', g.row_count, 'sources', v_sources,
        'assignmentSeed', seg ->> 'assignmentSeed',
        'recipeRowIds', (select coalesce(jsonb_agg(x.value order by x.ordinality), '[]'::jsonb)
                           from jsonb_array_elements(plan -> 'recipeRowIds') with ordinality x(value, ordinality)
                          where x.ordinality - 1 between g.row_start and g.row_start + g.row_count - 1)));
    elsif not private.catalog_publication_source_matches(g.source_material_id, p_team, g.source_version) then
      return jsonb_build_object('state', 'blocked', 'code', 'SOURCE_CHANGED');
    elsif g.kind = 'video' then
      v_link := public.service_space_catalog_video_link(p_team, p_actor, g.source_material_id);
      v_sources := jsonb_build_array(jsonb_build_object('materialId', g.source_material_id,
        'url', v_link ->> 'url', 'sourceVersion', v_link ->> 'sourceVersion', 'ready', v_link ->> 'state' = 'ready'));
      v_segments := v_segments || jsonb_build_array(jsonb_build_object(
        'ordinal', g.ordinal, 'kind', g.kind, 'rowStart', g.row_start, 'rowCount', g.row_count, 'sources', v_sources));
    else
      -- A picture: the one its creation published (062, `c1/`), reserved by its content.
      select image.url into v_url from private.launch_creative_images image
       where image.team_id = p_team and image.material_id = g.source_material_id
         and image.source_version = g.source_version and image.source_checksum = left(substr(g.source_version, 10), 32)
         and image.state in ('ready', 'retiring');
      if v_url is null then return jsonb_build_object('state', 'blocked', 'code', 'SOURCE_CHANGED'); end if;
      v_sources := jsonb_build_array(jsonb_build_object('materialId', g.source_material_id,
        'url', v_url, 'sourceVersion', g.source_version, 'ready', true, 'kind', 'image'));
      v_segments := v_segments || jsonb_build_array(jsonb_build_object(
        'ordinal', g.ordinal, 'kind', g.kind, 'rowStart', g.row_start, 'rowCount', g.row_count, 'sources', v_sources));
    end if;
    v_all := v_all || v_sources;
  end loop;
  if jsonb_array_length(v_segments) = 0 then return jsonb_build_object('state', 'blocked'); end if;
  v_ready := not exists (select 1 from jsonb_array_elements(v_all) e where (e ->> 'ready')::boolean is not true);
  if v_ready then
    for r in select e ->> 'materialId' as material, e ->> 'sourceVersion' as version, e ->> 'url' as url
             from jsonb_array_elements(v_all) e loop
      insert into private.catalog_publication_link_receipts (job_id, material_id, source_version, url, link_kind, due_verified_at)
      values (p_job, r.material::uuid, r.version, r.url, 'r2', clock_timestamp())
      on conflict (job_id, material_id) do update set
        source_version = excluded.source_version, url = excluded.url, link_kind = 'r2', due_verified_at = excluded.due_verified_at;
    end loop;
  end if;
  return jsonb_build_object(
    'state', case when v_ready then 'ready' else 'waiting' end,
    'feedId', p_feed,
    'productCount', p_count,
    'creativeKind', v_kind,
    'sources', v_all,
    'segments', v_segments);
end;
$$;
revoke all on function private.space_catalog_creatives_publication_context(uuid, uuid, uuid, uuid, uuid, text, integer) from public, anon, authenticated, service_role;

-- The feed, the public address of each video the rows link (the source's R2 copy, or each
-- variation's) and, for variations, the plan that assigns them to rows. `waiting` while a copy is
-- not ready yet (the writer nudges the copy worker); `blocked` when the catalog or its source is
-- gone. Once every copy is ready its address is recorded as the job's link receipt (`r2`): the
-- 050 follow-ups (catalog_video_r2_reconcile) then find nothing to replace. T117: a 'creatives'
-- target answers its segments (private.space_catalog_creatives_publication_context).
create or replace function public.service_space_catalog_publication_context(p_job uuid, p_worker uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  j private.catalog_video_publication_jobs%rowtype;
  p private.catalog_video_publication_policies%rowtype;
  t private.catalog_publication_targets%rowtype;
  c public.team_product_catalogs%rowtype;
  s private.space_catalog_variant_sets%rowtype;
  plan jsonb;
  v_material uuid;
  v_link jsonb;
  v_sources jsonb := '[]'::jsonb;
  v_ready boolean := true;
  r record;
begin
  select * into j from private.catalog_video_publication_jobs where id = p_job;
  if j.id is null or j.worker_id is distinct from p_worker or j.lease_until is null or j.lease_until <= clock_timestamp() then
    raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode = '55000';
  end if;
  if not private.space_is_r2(j.team_id) then raise exception 'STORAGE_BACKEND_MISMATCH' using errcode = '55000'; end if;
  select * into p from private.catalog_video_publication_policies where catalog_material_id = j.catalog_material_id;
  if p.revision is distinct from j.revision then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode = '55000'; end if;
  select * into t from private.catalog_publication_targets where id = j.target_id and team_id = j.team_id;
  select catalog.* into c from public.team_product_catalogs catalog
  join public.team_materials material on material.id = catalog.material_id and material.team_id = catalog.team_id
  where catalog.material_id = j.catalog_material_id and material.lifecycle = 'active' and material.connection_id is null;
  if c.material_id is not null and c.feed_id is not null and t.kind = 'creatives' then
    return private.space_catalog_creatives_publication_context(
      j.id, j.team_id, j.actor_id, j.catalog_material_id, t.id, c.feed_id, c.product_count);
  end if;
  if c.material_id is null or c.feed_id is null or t.kind is distinct from 'source' then
    return jsonb_build_object('state', 'blocked');
  end if;
  select * into s from private.space_catalog_variant_sets
   where catalog_material_id = j.catalog_material_id and team_id = j.team_id and state = 'ready';
  if s.id is not null then
    select i.checkpoint -> 'initialVideoPlan' into plan from private.catalog_generation_intents i where i.id = s.catalog_intent_id;
    if jsonb_typeof(plan -> 'recipeRowIds') is distinct from 'array' or plan ->> 'assignmentSeed' is null then
      return jsonb_build_object('state', 'blocked');
    end if;
    for r in select v.output_material_id from private.space_catalog_variants v where v.set_id = s.id order by v.ordinal loop
      if r.output_material_id is null then return jsonb_build_object('state', 'blocked'); end if;
      v_link := public.service_space_catalog_video_link(j.team_id, j.actor_id, r.output_material_id);
      v_sources := v_sources || jsonb_build_array(jsonb_build_object('materialId', r.output_material_id,
        'url', v_link ->> 'url', 'sourceVersion', v_link ->> 'sourceVersion', 'ready', v_link ->> 'state' = 'ready'));
    end loop;
  else
    -- The source must still be the version the policy named (a replaced video has another copy).
    if not private.catalog_publication_source_matches(t.source_material_id, j.team_id, t.source_version) then
      return jsonb_build_object('state', 'blocked', 'code', 'SOURCE_CHANGED');
    end if;
    v_link := public.service_space_catalog_video_link(j.team_id, j.actor_id, t.source_material_id);
    v_sources := jsonb_build_array(jsonb_build_object('materialId', t.source_material_id,
      'url', v_link ->> 'url', 'sourceVersion', v_link ->> 'sourceVersion', 'ready', v_link ->> 'state' = 'ready'));
  end if;
  v_ready := not exists (select 1 from jsonb_array_elements(v_sources) e where (e ->> 'ready')::boolean is not true);
  if v_ready then
    for r in select e ->> 'materialId' as material, e ->> 'sourceVersion' as version, e ->> 'url' as url
             from jsonb_array_elements(v_sources) e loop
      v_material := r.material::uuid;
      insert into private.catalog_publication_link_receipts (job_id, material_id, source_version, url, link_kind, due_verified_at)
      values (j.id, v_material, r.version, r.url, 'r2', clock_timestamp())
      on conflict (job_id, material_id) do update set
        source_version = excluded.source_version, url = excluded.url, link_kind = 'r2', due_verified_at = excluded.due_verified_at;
    end loop;
  end if;
  return jsonb_build_object(
    'state', case when v_ready then 'ready' else 'waiting' end,
    'feedId', c.feed_id,
    'productCount', c.product_count,
    'sources', v_sources)
    || case when s.id is null then '{}'::jsonb else jsonb_build_object(
         'recipeRowIds', plan -> 'recipeRowIds', 'assignmentSeed', plan ->> 'assignmentSeed') end;
end;
$$;
revoke all on function public.service_space_catalog_publication_context(uuid, uuid) from public, anon, authenticated;
grant execute on function public.service_space_catalog_publication_context(uuid, uuid) to service_role;

-- 4. Deleted for good, with the segments of its targets ------------------------------------------

create or replace function private.space_catalog_publication_removed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_jobs uuid[];
  v_targets uuid[];
begin
  if not private.space_is_r2(old.team_id) then return old; end if;
  select array_agg(id) into v_jobs from private.catalog_video_publication_jobs where catalog_material_id = old.id;
  select array_agg(distinct x.id) into v_targets from (
    select target_id as id from private.catalog_video_publication_jobs where catalog_material_id = old.id
    union select target_id from private.catalog_video_publication_policies where catalog_material_id = old.id
    union select target_id from private.catalog_video_deliveries where catalog_material_id = old.id) x;
  if v_jobs is null and v_targets is null then return old; end if;
  delete from private.catalog_update_reconciliations where catalog_material_id = old.id or publication_job_id = any(v_jobs);
  delete from private.catalog_publication_link_receipts where job_id = any(v_jobs);
  delete from private.catalog_video_deliveries where catalog_material_id = old.id;
  delete from private.catalog_video_publication_jobs where catalog_material_id = old.id;
  delete from private.catalog_video_publication_policies where catalog_material_id = old.id;
  -- The targets nothing else names any more leave, their segments first (no cascade).
  select array_agg(target.id) into v_targets from private.catalog_publication_targets target
   where target.id = any(v_targets)
     and not exists (select 1 from private.catalog_video_publication_policies x where x.target_id = target.id)
     and not exists (select 1 from private.catalog_video_publication_jobs x where x.target_id = target.id)
     and not exists (select 1 from private.catalog_video_deliveries x where x.target_id = target.id)
     and not exists (select 1 from private.catalog_growth_video_recipes x where x.base_target_id = target.id);
  delete from private.catalog_publication_target_segments where target_id = any(v_targets);
  delete from private.catalog_publication_targets where id = any(v_targets);
  return old;
end;
$$;
revoke all on function private.space_catalog_publication_removed() from public, anon, authenticated;
