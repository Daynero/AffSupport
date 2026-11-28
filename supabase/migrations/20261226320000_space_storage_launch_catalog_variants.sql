-- 057 T114/T115: a re-stitched Launch catalog in an R2 space — one video, or one variation set per
-- video creative (062) — and bulk launches there (research.md R15 «Каталоги запусків і креативи»).
--
-- The Launch, its acceptance and its catalog step are the Drive ones; under them the variations are
-- the space's own (20261226250000: `private.space_catalog_variant_sets`, run by the member's agent,
-- finished in the background by its recovery delegation, T107). A Drive space answers exactly as
-- before: every patched Drive body keeps its Drive text and asks `private.space_is_r2` first, and a
-- new trigger fires for R2 spaces only.
--
-- * private.space_catalog_variant_sets — one set per (creation, video) instead of one per creation,
--   so a Launch of several videos has a set per video segment; service_admit_space_catalog_variants
--   (patched) admits a source when it is the creation's video or one of its plan's video segments,
--   and finds the set by (creation, video).
-- * service_accept_launch_catalog_video_generation (patched) — in an R2 space a re-stitched Launch
--   names no executor (the member's recovery delegation must exist: AGENT_REQUIRED otherwise), its
--   one set is admitted in the space (private.admit_launch_space_catalog_set), and the frozen
--   context names no Drive set; accept_launch_catalog_video_segments (patched) admits one space set
--   per video segment and records the segments without a Drive set.
-- * service_wait_launch_catalog_video (patched) — the waiting generation of an R2 space reads its
--   space sets (worst one wins, as for Drive sets).
-- * private.launch_space_video_generation_json — the Launch's video progress from its space sets;
--   get_launch_before_started_at and private.list_launches_pre_assignment (patched) fall back to it.
-- * service_attach_launch_catalog_before_catalog_sub (patched) — an R2 catalog of variations is
--   attached only when every set of its creation is ready and bound to it.
-- * private.cancel_launch_space_catalog_variants — a canceled Launch generation of an R2 space
--   cancels its sets and their open runs (a Drive generation's sets are the Drive trigger's).
-- * service_link_space_catalog_feed (replaced) — `spaceVariantSetIds`: a catalog of several videos
--   binds each video's set and uses the copy of every output.
-- * service_space_catalog_variant_links (replaced) — a catalog with several sets has no single list
--   of variations to hand the updater (it keeps each block's video from the feed instead).
-- Bulk launches (spec 053) need nothing here: their acceptance is this one, and their settlement's
-- Drive-only dependency wait (20261207183000) joins Drive sets, which an R2 Launch has none of.

create function private.patch_function_057(p_function regprocedure, p_find text, p_replace text)
returns void language plpgsql set search_path = '' as $$
declare d text;
begin
  d := pg_catalog.pg_get_functiondef(p_function);
  if pg_catalog.strpos(d, p_find) = 0 then
    raise exception 'PATCH_057_ANCHOR_MISSING: %', p_function;
  end if;
  if pg_catalog.strpos(pg_catalog.substr(d, pg_catalog.strpos(d, p_find) + pg_catalog.length(p_find)), p_find) > 0 then
    raise exception 'PATCH_057_ANCHOR_AMBIGUOUS: %', p_function;
  end if;
  execute pg_catalog.replace(d, p_find, p_replace);
end $$;
revoke all on function private.patch_function_057(regprocedure, text, text) from public, anon, authenticated, service_role;

-- 1. One set per video of a creation ------------------------------------------------------------

drop index private.space_catalog_variant_sets_intent;
create unique index space_catalog_variant_sets_intent_source
  on private.space_catalog_variant_sets (catalog_intent_id, source_material_id)
  where catalog_intent_id is not null;

select private.patch_function_057(
  'public.service_admit_space_catalog_variants(uuid,uuid,uuid,uuid,uuid,uuid[],jsonb,text)'::regprocedure,
  $f$and i.video_material_id = p_source$f$,
  $r$and (i.video_material_id = p_source or exists (
        -- T115: one of the plan's video segments (a Launch of several videos), with this set.
        select 1 from jsonb_array_elements(case when jsonb_typeof(i.checkpoint #> '{initialVideoPlan,segments}') = 'array'
          then i.checkpoint #> '{initialVideoPlan,segments}' else '[]'::jsonb end) seg
        where seg ->> 'kind' = 'video' and lower(seg ->> 'materialId') = p_source::text and seg ->> 'setId' = p_set::text))$r$);
select private.patch_function_057(
  'public.service_admit_space_catalog_variants(uuid,uuid,uuid,uuid,uuid,uuid[],jsonb,text)'::regprocedure,
  $f$select * into s from private.space_catalog_variant_sets where catalog_intent_id = p_intent for update;$f$,
  $r$select * into s from private.space_catalog_variant_sets
   where catalog_intent_id = p_intent and (source_material_id = p_source or id = p_set)
   order by (id = p_set) desc limit 1 for update;$r$);

-- 2. Launch acceptance --------------------------------------------------------------------------

-- One video's set of a Launch's creation, admitted in the space with the Launch's frozen settings.
create function private.admit_launch_space_catalog_set(p_team uuid, p_actor uuid, p_intent uuid, p_source uuid,
  p_set uuid, p_requests jsonb, p_settings jsonb, p_digest text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_progress jsonb;
begin
  if jsonb_typeof(p_requests) is distinct from 'array' or jsonb_typeof(p_settings) is distinct from 'object' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  v_progress := public.service_admit_space_catalog_variants(p_team, p_actor, p_intent, p_set, p_source,
    array(select value::uuid from jsonb_array_elements_text(p_requests) with ordinality x(value, ordinal) order by ordinal),
    p_settings, p_digest);
  if (v_progress ->> 'requestedCount')::integer is distinct from jsonb_array_length(p_requests) then
    raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode = '55000';
  end if;
end $$;
revoke all on function private.admit_launch_space_catalog_set(uuid, uuid, uuid, uuid, uuid, jsonb, jsonb, text) from public, anon, authenticated, service_role;

-- No executor in an R2 space: the member's own agent runs the variations through its recovery
-- delegation (T107), which must exist, as a Drive Launch needs its background executor.
select private.patch_function_057(
  'public.service_accept_launch_catalog_video_generation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure,
  $f$  else
  catalog:=public.service_initial_catalog_video_context($f$,
  $r$  elsif private.space_is_r2(p_team) then
  if executor is not null or preferences ? 'expectedExecutorId' or preferences ? 'foregroundExecutor' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  perform private.require_space_actor(p_team,p_actor,'process');
  if private.recovery_executor_for(p_team,p_actor) is null then raise exception 'AGENT_REQUIRED' using errcode='42501';end if;
  else
  catalog:=public.service_initial_catalog_video_context($r$);
select private.patch_function_057(
  'public.service_accept_launch_catalog_video_generation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure,
  $f$ elsif set_id is not null then
  select * into source from public.team_materials where id=(p_config->>'materialId')::uuid and team_id=p_team for update;$f$,
  $r$ elsif set_id is not null and private.space_is_r2(p_team) then
  perform private.admit_launch_space_catalog_set(p_team,p_actor,(intent->>'id')::uuid,(p_config->>'materialId')::uuid,set_id,plan->'childRequestIds',settings,p_video->>'settingsDigest');
 elsif set_id is not null then
  select * into source from public.team_materials where id=(p_config->>'materialId')::uuid and team_id=p_team for update;$r$);
-- The frozen context of an R2 Launch names no Drive set (its sets are found by its creation).
select private.patch_function_057(
  'public.service_accept_launch_catalog_video_generation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure,
  $f$(intent->>'id')::uuid,set_id);$f$,
  $r$(intent->>'id')::uuid,case when private.space_is_r2(p_team) then null else set_id end);$r$);

-- Several videos: one space set per video segment, the segments recorded without a Drive set.
select private.patch_function_057(
  'private.accept_launch_catalog_video_segments(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb)'::regprocedure,
  $f$      -- The same proof the first video got: an active connected video and this actor's executor.$f$,
  $r$      if private.space_is_r2(p_team) then
        perform private.admit_launch_space_catalog_set(p_team, p_actor, p_intent, (seg->>'materialId')::uuid,
          (seg->>'setId')::uuid, seg->'childRequestIds', p_video->'settings', p_video->>'settingsDigest');
        continue;
      end if;
      -- The same proof the first video got: an active connected video and this actor's executor.$r$);
select private.patch_function_057(
  'private.accept_launch_catalog_video_segments(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb)'::regprocedure,
  $f$nullif(s.value->>'setId', '')::uuid, s.value->>'assignmentSeed'$f$,
  $r$case when private.space_is_r2(p_team) then null else nullif(s.value->>'setId', '')::uuid end, s.value->>'assignmentSeed'$r$);

-- 3. The sets of a Launch generation of an R2 space, and its waiting -------------------------------

create function private.launch_space_video_sets(p_team uuid, p_generation uuid)
returns table(ordinal integer, set_id uuid, progress jsonb)
language sql stable security definer set search_path = '' as $$
  select coalesce(seg.ordinal, 0), s.id, private.space_catalog_variant_progress(s.id)
  from private.launch_catalog_video_contexts c
  join private.space_catalog_variant_sets s on s.catalog_intent_id = c.catalog_intent_id and s.team_id = c.team_id
  left join private.launch_catalog_video_segments seg
    on seg.generation_id = c.generation_id and seg.material_id = s.source_material_id and seg.kind = 'video'
  where c.generation_id = p_generation and c.team_id = p_team and private.space_is_r2(p_team)
  order by 1, 2;
$$;
revoke all on function private.launch_space_video_sets(uuid, uuid) from public, anon, authenticated, service_role;

select private.patch_function_057(
  'public.service_wait_launch_catalog_video(uuid,uuid,uuid,text,text)'::regprocedure,
  $f$ if states is null then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'$f$,
  $r$ if states is null and private.space_is_r2(p_team) then
  select array_agg(x.progress->>'state' order by x.ordinal),min(x.ordinal) filter (where x.progress->>'state'='unknown') into states,failed
    from private.launch_space_video_sets(p_team,g.id) x;
 end if;
 if states is null then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'$r$);

-- The Launch's video progress, in the shape of the Drive one (launch_video_generation_json).
create function private.launch_space_video_generation_json(p_team uuid, p_generation uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when count(*) = 0 then null else jsonb_strip_nulls(jsonb_build_object(
    'setId', (array_agg(x.set_id order by x.ordinal))[1],
    'requestedCount', sum((x.progress ->> 'requestedCount')::integer),
    'registeredCount', sum((x.progress ->> 'registeredCount')::integer),
    'state', private.catalog_video_sets_state(array_agg(x.progress ->> 'state')),
    'activeChildOperationId', (select v.operation_id from private.launch_space_video_sets(p_team, p_generation) y
        join private.space_catalog_variants v on v.set_id = y.set_id
        join public.team_operations o on o.id = v.operation_id and o.team_id = p_team
       where o.state in ('pending', 'running') order by y.ordinal, v.ordinal limit 1),
    'segments', case when count(*) > 1 then jsonb_agg(jsonb_build_object('ordinal', x.ordinal, 'setId', x.set_id,
        'state', x.progress ->> 'state', 'requestedCount', (x.progress ->> 'requestedCount')::integer,
        'registeredCount', (x.progress ->> 'registeredCount')::integer) order by x.ordinal) end,
    'failedOrdinal', case when count(*) > 1 then min(x.ordinal) filter (where x.progress ->> 'state' = 'unknown') end
  )) end
  from private.launch_space_video_sets(p_team, p_generation) x;
$$;
revoke all on function private.launch_space_video_generation_json(uuid, uuid) from public, anon, authenticated, service_role;

select private.patch_function_057(
  'public.get_launch_before_started_at(uuid,uuid,uuid)'::regprocedure,
  $f$video:=private.launch_video_generation_json(p_team,(result#>>'{generation,id}')::uuid);$f$,
  $r$video:=coalesce(private.launch_video_generation_json(p_team,(result#>>'{generation,id}')::uuid),
   private.launch_space_video_generation_json(p_team,(result#>>'{generation,id}')::uuid));$r$);
select private.patch_function_057(
  'private.list_launches_pre_assignment(uuid,jsonb,integer)'::regprocedure,
  $f$'videoGeneration',case when exists(select 1 from private.launch_catalog_video_segments seg where seg.generation_id=g.id and seg.video_set_id is not null)$f$,
  $r$'videoGeneration',case when private.space_is_r2(l.team_id) then private.launch_space_video_generation_json(l.team_id,g.id)-'executor'-'activeChildOperationId'
            when exists(select 1 from private.launch_catalog_video_segments seg where seg.generation_id=g.id and seg.video_set_id is not null)$r$);

-- 4. Attaching the catalog to its Launch ------------------------------------------------------------

select private.patch_function_057(
  'public.service_attach_launch_catalog_before_catalog_sub(uuid,uuid,uuid,text,text)'::regprocedure,
  $f$ insert into public.team_launch_revision_catalogs(team_id,revision_id,$f$,
  $r$ -- 057 T115: an R2 catalog of variations has every set of its creation ready and bound to it.
 if private.space_is_r2(p_team) and x.initial_video_plan#>>'{preferences,restitchEnabled}'='true' and (
   (select count(*) from private.space_catalog_variant_sets s where s.catalog_intent_id=i.id and s.team_id=p_team and s.actor_id=p_actor
      and s.state='ready' and s.catalog_material_id=c.material_id and private.space_catalog_variant_progress(s.id)->>'state'='ready')
   is distinct from greatest(1,(select count(*) from jsonb_array_elements(case when jsonb_typeof(x.initial_video_plan->'segments')='array' then x.initial_video_plan->'segments' else '[]'::jsonb end) seg where jsonb_typeof(seg->'setId')='string'))
   or exists(select 1 from private.space_catalog_variant_sets s where s.catalog_intent_id=i.id and (s.state<>'ready' or s.catalog_material_id is distinct from c.material_id))) then
  raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';
 end if;
 insert into public.team_launch_revision_catalogs(team_id,revision_id,$r$);

-- 5. A canceled Launch generation of an R2 space stops its variations ---------------------------

create function private.cancel_launch_space_catalog_variants() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_set uuid;
  v_operation uuid;
begin
  for v_set in
    select s.id from private.launch_catalog_video_contexts c
    join private.space_catalog_variant_sets s on s.catalog_intent_id = c.catalog_intent_id and s.team_id = c.team_id
    where c.generation_id = new.id and c.team_id = new.team_id and s.state = 'preparing'
    for update of s
  loop
    update private.space_catalog_variant_sets set state = 'canceled', updated_at = clock_timestamp() where id = v_set;
    for v_operation in
      select o.id from private.space_catalog_variants v
      join public.team_operations o on o.id = v.operation_id
      where v.set_id = v_set and o.state in ('pending', 'running')
    loop
      perform public.service_transition_team_operation(v_operation, 'canceled', 'canceled', 0, null, null, false);
    end loop;
    -- Outputs already made stay as files of the space; they no longer count under catalogs.
    perform private.space_material_ref_sync(v.output_material_id)
       from private.space_catalog_variants v where v.set_id = v_set and v.output_material_id is not null;
  end loop;
  return null;
end;
$$;
revoke all on function private.cancel_launch_space_catalog_variants() from public, anon, authenticated;
create trigger launch_space_catalog_variants_cancel after update of state on public.team_launch_generations
for each row when (new.state in ('cancel_requested', 'canceled_with_cleanup_pending', 'canceled')
  and old.state is distinct from new.state and private.space_is_r2(new.team_id))
execute function private.cancel_launch_space_catalog_variants();

-- 6. The link of a catalog of several videos binds each video's set --------------------------------

create or replace function public.service_link_space_catalog_feed(
  p_team uuid, p_video uuid, p_companion uuid, p_replaces uuid, p_record jsonb, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_feed text := p_record ->> 'feedId';
  v_bytes text := p_record ->> 'feedBytes';
  v_set_text text := p_record ->> 'spaceVariantSetId';
  v_sets jsonb := p_record -> 'spaceVariantSetIds';
  v_set_ids uuid[];
  v_publication text := p_record ->> 'spacePublicationKey';
  s private.space_catalog_variant_sets%rowtype;
  v_output uuid;
  v_intent uuid;
  v_creatives jsonb := p_record -> 'settingsSnapshot' -> '_catalogCreatives';
  v_image boolean := coalesce(p_record -> 'settingsSnapshot' ->> '_catalogCreativeKind', 'video') = 'image';
  result jsonb;
begin
  if p_record is null or jsonb_typeof(p_record) <> 'object'
     or v_feed is null or v_feed !~ '^[0-9a-f]{32}$' or v_bytes is null or v_bytes !~ '^[1-9][0-9]{0,8}$'
     or (v_set_text is not null and v_set_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     or (p_record ? 'spaceVariantSetIds' and (v_set_text is not null or v_image
         or jsonb_typeof(v_sets) is distinct from 'array' or jsonb_array_length(v_sets) not between 2 and 400
         or exists (select 1 from jsonb_array_elements(v_sets) e
                    where jsonb_typeof(e) <> 'string' or e #>> '{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')))
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
  if v_sets is not null then
    -- T115: a catalog of several videos, each with its own set: this member's, of one of the
    -- catalog's own video creatives (the first is the catalog's video), complete, no other catalog's.
    v_set_ids := array(select (e #>> '{}')::uuid from jsonb_array_elements(v_sets) e);
    if cardinality(v_set_ids) <> cardinality(array(select distinct unnest(v_set_ids))) then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    perform 1 from private.space_catalog_variant_sets x where x.id = any(v_set_ids) order by x.id for update;
    if (select count(distinct x.source_material_id) from private.space_catalog_variant_sets x
        where x.id = any(v_set_ids) and x.team_id = p_team and x.actor_id = p_actor and x.state <> 'canceled'
          and (x.catalog_material_id is null or x.catalog_material_id = p_companion)
          and private.space_catalog_variant_progress(x.id) ->> 'state' = 'ready'
          and x.source_material_id::text in (
            select creative ->> 'materialId'
            from jsonb_array_elements(case when jsonb_typeof(v_creatives) = 'array' then v_creatives else '[]'::jsonb end) creative))
       is distinct from cardinality(v_set_ids)
       or not exists (select 1 from private.space_catalog_variant_sets x where x.id = any(v_set_ids) and x.source_material_id = p_video) then
      raise exception 'WRONG_STATE' using errcode = '55000';
    end if;
  end if;
  result := public.service_link_product_catalog_companion(
    p_team, p_video, p_companion, p_replaces,
    p_record - 'feedId' - 'feedBytes' - 'spaceVariantSetId' - 'spaceVariantSetIds' - 'spacePublicationKey');
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
    if s.id is not null or v_set_ids is not null then
      update private.space_catalog_variant_sets
         set state = 'ready', catalog_material_id = p_companion, updated_at = clock_timestamp()
       where id = s.id or id = any(v_set_ids);
      for v_output in
        select v.output_material_id from private.space_catalog_variants v
        join private.space_catalog_variant_sets x on x.id = v.set_id
        where v.set_id = s.id or v.set_id = any(v_set_ids)
        order by x.created_at, x.id, v.ordinal
      loop
        perform private.space_catalog_use_copy(p_companion, p_team, v_output, true);
      end loop;
      -- The initial publication of a catalog of variations is its feed: nothing is owed to the
      -- Drive re-verification lane (service_list_initial_catalog_recovery), so it never lists it.
      for v_intent in
        select distinct x.catalog_intent_id from private.space_catalog_variant_sets x
        where (x.id = s.id or x.id = any(v_set_ids)) and x.catalog_intent_id is not null
      loop
        insert into private.catalog_initial_publication_reverify (intent_id, team_id, exhausted_at)
        values (v_intent, p_team, clock_timestamp())
        on conflict (intent_id) do update set exhausted_at = coalesce(private.catalog_initial_publication_reverify.exhausted_at, excluded.exhausted_at);
      end loop;
    elsif not v_image then
      -- Best effort: the copy was planned before the feed was written; a missing one is the
      -- updater's to resolve again, as before.
      perform private.space_catalog_use_copy(p_companion, p_team, p_video, false);
      -- T104: every other video of a Launch's creatives is its own copy, planned before the
      -- feed named it; the catalog uses each one, so none is retired while the catalog lives.
      for v_output in
        select (creative ->> 'materialId')::uuid
        from jsonb_array_elements(case when jsonb_typeof(v_creatives) = 'array' then v_creatives else '[]'::jsonb end) creative
        where creative ->> 'materialId' is distinct from p_video::text
      loop
        perform private.space_catalog_use_copy(p_companion, p_team, v_output, true);
      end loop;
    end if;
    -- T102: a link published later is the publication lane's from now on, in this transaction:
    -- the updater keeps the empty video cells until its job writes them.
    if v_publication is not null then
      perform private.register_space_catalog_publication(p_team, p_actor, p_companion, v_publication);
    end if;
    perform private.catalog_video_r2_signal(p_companion);
    -- A picture catalog has no video to copy: its pictures are its creatives' own (c1/).
    if s.id is null and v_set_ids is null and not v_image then
      perform public.service_catalog_video_r2_resolve_current(p_companion);
    end if;
  end if;
  return result;
end;
$$;

-- 7. The updater's variations: one set's, never several sets' ----------------------------------

create or replace function public.service_space_catalog_variant_links(p_catalog uuid) returns jsonb
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
  -- T115: a catalog of several videos keeps each block's variation from its feed instead.
  left join private.space_catalog_variant_sets s on s.catalog_material_id = p_catalog and s.state = 'ready'
    and (select count(*) from private.space_catalog_variant_sets x where x.catalog_material_id = p_catalog and x.state = 'ready') = 1;
$$;

revoke all on function public.service_link_space_catalog_feed(uuid, uuid, uuid, uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.service_link_space_catalog_feed(uuid, uuid, uuid, uuid, jsonb, uuid) to service_role;
revoke all on function public.service_space_catalog_variant_links(uuid) from public, anon, authenticated;
grant execute on function public.service_space_catalog_variant_links(uuid) to service_role;

drop function private.patch_function_057(regprocedure, text, text);
