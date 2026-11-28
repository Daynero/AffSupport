-- 057 T101/T102: a catalog of an R2 space can publish its video link later (FR-011, FR-050;
-- research.md R15 «Відкладена публікація»).
--
-- On Drive a scheduled link is a publication policy and a job of the catalog_video_publication_*
-- lane (20261207169000): the catalog is made with empty video cells, the targeted cell writer
-- fills them when the job is due, and the updater keeps them as they are meanwhile
-- (service_catalog_publication_allows_legacy_write). An R2 space reuses that lane — policy, job,
-- reserve/dispatch/settle, the manager's actions — with three differences:
--
-- * the target is `source` with a space version (`space-v1:<content id>` of the video's committed
--   original), and a catalog of re-stitched variations keeps that target too: its variations are
--   the set bound to the catalog (20261226250000), not a Drive set;
-- * the policy and its job are registered by the link itself, in the same transaction
--   (service_link_space_catalog_feed with `spacePublicationKey`): there is no Drive sheet to read
--   back first, so no catalog_initial_publication_checks and no legacy adoption — the policy is
--   verified from the start and its job waits for its time;
-- * the writer is the feed's (catalog-updater/space-publication.ts over applyFeedPublicationCells):
--   its own claim (service_claim_space_catalog_publication_jobs) and context
--   (service_space_catalog_publication_context: the feed, the R2 copies of the video or of each
--   variation, the plan's assignment), never the Drive context or the sheet's baseline check.
--
-- Also:
-- * private.catalog_publication_source_matches (patched) — a `space-v1:` version is compared with
--   the space's content; content-v1 and strict-v1 answer exactly as before.
-- * private.catalog_publication_work_due (patched) — the ten-second lane also wakes for a due job
--   of an R2 catalog (the Drive condition requires a Drive connection, which an R2 catalog has not).
-- * service_mark_due_catalog_publications_unsupported (patched) — never marks an R2 job: its writer
--   is not the targeted Drive writer whose absence that marks.
-- * service_list_initial_catalog_recovery (patched) — never lists a creation of an R2 space: that
--   lane runs creations through Drive (a scheduled R2 creation is protocol 1 and was listed).
-- * When an R2 catalog row is deleted for good, its publication rows leave first (their keys have
--   no cascade); before, its policy would have kept the catalog in the trash for good.

-- 1. The version of a space's video ----------------------------------------------------------

create function private.space_catalog_publication_source_version(p_material uuid, p_team uuid) returns text
language sql stable security definer set search_path = '' as $$
  select 'space-v1:' || object.content_id
  from public.team_materials material
  join public.space_objects object on object.id = material.space_object_id and object.team_id = material.team_id
  where material.id = p_material and material.team_id = p_team and material.connection_id is null
    and material.kind = 'file' and material.category = 'video'
    and object.kind = 'original' and object.state = 'committed' and object.content_id ~ '^[0-9a-f]{64}$';
$$;
revoke all on function private.space_catalog_publication_source_version(uuid, uuid) from public, anon, authenticated, service_role;

do $patch$
declare d text; needle text := $n$if p_version like 'content-v1:%' then$n$;
begin
  select pg_get_functiondef('private.catalog_publication_source_matches(uuid,uuid,text)'::regprocedure) into d;
  if strpos(d, 'space-v1:') = 0 then
    if strpos(d, needle) = 0 then raise exception 'SPACE_SOURCE_MATCH_PATCH_MISSING'; end if;
    d := replace(d, needle,
      $r$if p_version like 'space-v1:%' then return p_version is not distinct from private.space_catalog_publication_source_version(p_material,p_team);end if;
 $r$ || needle);
    execute d;
  end if;
end $patch$;

-- 2. The policy a scheduled creation registers with its link ---------------------------------

create function private.register_space_catalog_publication(p_team uuid, p_actor uuid, p_catalog uuid, p_key text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  i private.catalog_generation_intents%rowtype;
  plan jsonb;
  due timestamptz;
  zone text;
  v_version text;
  v_target uuid;
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
  v_version := private.space_catalog_publication_source_version(i.video_material_id, p_team);
  if v_version is null then raise exception 'SOURCE_CHANGED' using errcode = '55000'; end if;
  insert into private.catalog_publication_targets (team_id, kind, source_material_id, source_version)
  values (p_team, 'source', i.video_material_id, v_version) returning id into v_target;
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

create or replace function public.service_link_space_catalog_feed(
  p_team uuid, p_video uuid, p_companion uuid, p_replaces uuid, p_record jsonb, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_feed text := p_record ->> 'feedId';
  v_bytes text := p_record ->> 'feedBytes';
  v_set_text text := p_record ->> 'spaceVariantSetId';
  v_publication text := p_record ->> 'spacePublicationKey';
  s private.space_catalog_variant_sets%rowtype;
  v_output uuid;
  result jsonb;
begin
  if p_record is null or jsonb_typeof(p_record) <> 'object'
     or v_feed is null or v_feed !~ '^[0-9a-f]{32}$' or v_bytes is null or v_bytes !~ '^[1-9][0-9]{0,8}$'
     or (v_set_text is not null and v_set_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     or (p_record ? 'spacePublicationKey' and (v_publication is null or char_length(v_publication) not between 8 and 200)) then
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
    p_team, p_video, p_companion, p_replaces,
    p_record - 'feedId' - 'feedBytes' - 'spaceVariantSetId' - 'spacePublicationKey');
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
    -- T102: a link published later is the publication lane's from now on, in this transaction:
    -- the updater keeps the empty video cells until its job writes them.
    if v_publication is not null then
      perform private.register_space_catalog_publication(p_team, p_actor, p_companion, v_publication);
    end if;
    perform private.catalog_video_r2_signal(p_companion);
    if s.id is null then
      perform public.service_catalog_video_r2_resolve_current(p_companion);
    end if;
  end if;
  return result;
end;
$$;

-- 3. The claim of the feed's writer ------------------------------------------------------------

create function private.space_catalog_publication_claimable(p_catalog uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.team_materials material
    join public.team_product_catalogs catalog on catalog.material_id = material.id and catalog.team_id = material.team_id
    where material.id = p_catalog and material.connection_id is null and catalog.feed_id is not null
      and private.space_is_r2(material.team_id));
$$;
revoke all on function private.space_catalog_publication_claimable(uuid) from public, anon, authenticated, service_role;

-- The Drive claim (service_claim_catalog_publication_jobs) asks for a usable Drive connection,
-- which an R2 catalog never has; this is the same claim for the catalogs of R2 spaces.
create function public.service_claim_space_catalog_publication_jobs(p_worker uuid, p_limit integer default 3)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  j private.catalog_video_publication_jobs%rowtype;
  p private.catalog_video_publication_policies%rowtype;
  items jsonb := '[]'::jsonb;
begin
  if p_worker is null or p_limit is null or p_limit < 1 or p_limit > 3 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  for j in
    select q.* from private.catalog_video_publication_jobs q
    join private.catalog_video_publication_policies policy_row
      on policy_row.catalog_material_id = q.catalog_material_id and policy_row.revision = q.revision
    where (q.state in ('waiting', 'preparing', 'retry_wait') and q.dispatched_at is null
           or q.state in ('applying', 'verifying', 'unknown') and q.dispatched_at is not null and q.writer_fence is not null)
      and q.next_attempt_at <= clock_timestamp()
      and private.space_catalog_publication_claimable(q.catalog_material_id)
      and (q.lease_until is null or q.lease_until <= clock_timestamp())
      and (policy_row.mode = 'immediate' or (policy_row.mode = 'scheduled' and policy_row.due_at <= clock_timestamp()))
    order by q.next_attempt_at, q.id
    limit p_limit
    for update of q skip locked
  loop
    select * into p from private.catalog_video_publication_policies where catalog_material_id = j.catalog_material_id;
    if not private.catalog_publication_job_actor_allowed(j.id)
       or not exists (select 1 from public.team_materials where id = j.catalog_material_id and team_id = j.team_id and lifecycle = 'active') then
      update private.catalog_video_publication_jobs set state = 'blocked', blocked_reason = 'target_unavailable' where id = j.id;
      continue;
    end if;
    update private.catalog_video_publication_jobs
       set worker_id = p_worker, lease_until = clock_timestamp() + interval '5 minutes'
     where id = j.id;
    items := items || jsonb_build_array(jsonb_build_object(
      'jobId', j.id, 'teamId', j.team_id, 'actorId', j.actor_id, 'catalogId', j.catalog_material_id,
      'policy', jsonb_build_object('mode', p.mode, 'revision', p.revision, 'dueAt', p.due_at, 'timeZone', p.time_zone),
      'job', jsonb_build_object('revision', j.revision, 'writerFence', j.writer_fence, 'state', j.state,
        'target', private.catalog_publication_target_json(j.target_id)),
      'active', (public.service_read_catalog_publication(j.team_id, j.actor_id, j.catalog_material_id)) -> 'active'));
  end loop;
  return jsonb_build_object('serverNow', floor(extract(epoch from clock_timestamp()) * 1000), 'items', items);
end;
$$;

-- 4. What the feed's writer writes ---------------------------------------------------------------

-- The feed, the public address of each video the rows link (the source's R2 copy, or each
-- variation's) and, for variations, the plan that assigns them to rows. `waiting` while a copy is
-- not ready yet (the writer nudges the copy worker); `blocked` when the catalog or its source is
-- gone. Once every copy is ready its address is recorded as the job's link receipt (`r2`): the
-- 050 follow-ups (catalog_video_r2_reconcile) then find nothing to replace.
create function public.service_space_catalog_publication_context(p_job uuid, p_worker uuid)
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

-- 5. The lanes that run it -----------------------------------------------------------------------

create function private.space_catalog_publication_work_due(p_recent boolean default false) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.catalog_video_publication_jobs q
    join private.catalog_video_publication_policies p on p.catalog_material_id = q.catalog_material_id and p.revision = q.revision
    where q.next_attempt_at <= clock_timestamp()
      and (q.lease_until is null or q.lease_until <= clock_timestamp())
      and (p.mode = 'immediate' or (p.mode = 'scheduled' and p.due_at <= clock_timestamp()))
      and ((q.state in ('waiting', 'preparing', 'retry_wait') and q.dispatched_at is null
            and (not p_recent or coalesce(p.due_at, q.created_at) > clock_timestamp() - interval '30 minutes'))
        or (q.state in ('applying', 'verifying', 'unknown') and q.dispatched_at is not null and q.writer_fence is not null
            and (not p_recent or q.dispatched_at > clock_timestamp() - interval '5 minutes')))
      and private.space_catalog_publication_claimable(q.catalog_material_id));
$$;
revoke all on function private.space_catalog_publication_work_due(boolean) from public, anon, authenticated, service_role;

do $patch$
declare
  d text;
  needle text := $n$(r.lease_until is null or r.lease_until<=clock_timestamp()))$n$;
begin
  select pg_get_functiondef('private.catalog_publication_work_due(boolean)'::regprocedure) into d;
  if strpos(d, 'space_catalog_publication_work_due') = 0 then
    if strpos(d, needle) = 0 or strpos(substr(d, strpos(d, needle) + 1), needle) > 0 then
      raise exception 'SPACE_PUBLICATION_WORK_DUE_PATCH_MISSING';
    end if;
    d := replace(d, needle, needle || E'\n or private.space_catalog_publication_work_due(p_recent)');
    execute d;
  end if;
end $patch$;

do $patch$
declare
  d text;
  needle text := $n$and not exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=j.catalog_material_id)$n$;
begin
  select pg_get_functiondef('public.service_mark_due_catalog_publications_unsupported(integer)'::regprocedure) into d;
  if strpos(d, 'space_is_r2') = 0 then
    if strpos(d, needle) = 0 then raise exception 'SPACE_PUBLICATION_UNSUPPORTED_PATCH_MISSING'; end if;
    d := replace(d, needle, needle || ' and not private.space_is_r2(j.team_id)');
    execute d;
  end if;
end $patch$;

-- The Drive lane that finishes and re-verifies interrupted creations
-- (service_list_initial_catalog_recovery) runs them through Drive; a creation of an R2 space with
-- a later link is protocol 1 too, and is never its to list (its variations are finished by
-- service_list_space_catalog_completions, its link needs no Drive read-back).
do $patch$
declare
  d text;
  needle text := $n$       where private.can(o.team_id, 'view', o.actor_id)$n$;
begin
  select pg_get_functiondef('public.service_list_initial_catalog_recovery(integer)'::regprocedure) into d;
  if strpos(d, 'space_is_r2') = 0 then
    if strpos(d, needle) = 0 or strpos(substr(d, strpos(d, needle) + 1), needle) > 0 then
      raise exception 'SPACE_INITIAL_RECOVERY_PATCH_MISSING';
    end if;
    d := replace(d, needle, $r$       where not private.space_is_r2(o.team_id)
         and private.can(o.team_id, 'view', o.actor_id)$r$);
    execute d;
  end if;
end $patch$;

-- 6. An R2 catalog deleted for good takes its publication with it ------------------------------

create function private.space_catalog_publication_removed() returns trigger
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
  delete from private.catalog_publication_targets target
   where target.id = any(v_targets)
     and not exists (select 1 from private.catalog_video_publication_policies x where x.target_id = target.id)
     and not exists (select 1 from private.catalog_video_publication_jobs x where x.target_id = target.id)
     and not exists (select 1 from private.catalog_video_deliveries x where x.target_id = target.id)
     and not exists (select 1 from private.catalog_growth_video_recipes x where x.base_target_id = target.id);
  return old;
end;
$$;
revoke all on function private.space_catalog_publication_removed() from public, anon, authenticated;
-- A Drive catalog has a connection: the condition keeps every Drive row off this function.
create trigger space_catalog_publication_removed before delete on public.team_materials
for each row when (old.connection_id is null and old.companion_kind = 'product_catalog')
execute function private.space_catalog_publication_removed();

-- Grants -------------------------------------------------------------------------------------------

revoke all on function public.service_claim_space_catalog_publication_jobs(uuid, integer) from public, anon, authenticated;
revoke all on function public.service_space_catalog_publication_context(uuid, uuid) from public, anon, authenticated;
grant execute on function public.service_claim_space_catalog_publication_jobs(uuid, integer) to service_role;
grant execute on function public.service_space_catalog_publication_context(uuid, uuid) to service_role;
