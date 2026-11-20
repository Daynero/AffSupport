-- 062: a catalog Launch with several videos restitches each video in its own set.
--
-- The edge plan (plan V2) cuts the catalog rows into one contiguous block per
-- creative ("segment") and gives every restitched video its own
-- catalog_video_sets row over its block, with its share of the variations and
-- the seed hex(sha256(<plan seed> || ':' || <ordinal>)). The background agent
-- already takes sets one at a time, so the agent does not change.
--
--   * private.launch_catalog_video_segments: the frozen segments of a
--     generation with several creatives (one creative keeps the old model);
--   * one set per (intent, source) instead of one per intent, and one recipe
--     reference per (intent, set);
--   * the set acceptance finds a set by (intent, source) and accepts a source
--     only when it is one of the intent's planned video segments;
--   * Launch acceptance accepts every segment set; reuse of a ready set stays
--     for one video only; several videos never run in the foreground;
--   * waiting, progress, the Launch list, the initial read, the ready binding
--     and cancellation see every set of the generation;
--   * retry_launch_catalog_video_segment reopens the one set that failed.
-- A plan without segments (or with one) takes exactly the path it took before.
begin;

-- A guarded text patch of a live function body: the anchor must be present once.
create function private.patch_function_062(p_function regprocedure, p_find text, p_replace text)
returns void language plpgsql set search_path = '' as $$
declare d text;
begin
  d := pg_catalog.pg_get_functiondef(p_function);
  if pg_catalog.strpos(d, p_find) = 0 then
    raise exception 'PATCH_062_ANCHOR_MISSING: %', p_function;
  end if;
  if pg_catalog.strpos(pg_catalog.substr(d, pg_catalog.strpos(d, p_find) + pg_catalog.length(p_find)), p_find) > 0 then
    raise exception 'PATCH_062_ANCHOR_AMBIGUOUS: %', p_function;
  end if;
  execute pg_catalog.replace(d, p_find, p_replace);
end $$;
revoke all on function private.patch_function_062(regprocedure, text, text) from public, anon, authenticated, service_role;

create table private.launch_catalog_video_segments (
  generation_id uuid not null,
  ordinal integer not null check (ordinal between 0 and 399),
  team_id uuid not null references public.teams(id),
  material_id uuid not null,
  kind text not null check (kind in ('video', 'image')),
  row_start integer not null check (row_start between 0 and 399),
  row_count integer not null check (row_count between 1 and 400),
  variant_count integer not null check (variant_count between 0 and 400),
  video_set_id uuid unique references private.catalog_video_sets(id),
  assignment_seed text not null check (assignment_seed ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  primary key (generation_id, ordinal),
  foreign key (generation_id, team_id) references public.team_launch_generations(id, team_id) on delete restrict,
  foreign key (material_id, team_id) references public.team_materials(id, team_id),
  check (row_start + row_count <= 400),
  check (kind = 'video' or (variant_count = 0 and video_set_id is null)),
  check (video_set_id is null or variant_count between 1 and row_count)
);
alter table private.launch_catalog_video_segments enable row level security;
alter table private.launch_catalog_video_segments force row level security;
revoke all on table private.launch_catalog_video_segments from public, anon, authenticated, service_role;
create trigger launch_catalog_video_segment_immutable before update on private.launch_catalog_video_segments
  for each row execute function private.restitch_candidate_version_immutable();
-- Every table naming a material keeps the attachment cleanup fence (20261205122000).
create trigger task_cleanup_reference_fence before insert or update on private.launch_catalog_video_segments
  for each row execute function private.guard_task_cleanup_reference();

-- One set per source of an intent; one recipe reference per set of an intent.
alter table private.catalog_video_sets drop constraint catalog_video_sets_catalog_intent_id_key;
alter table private.catalog_video_sets add constraint catalog_video_sets_catalog_intent_source_key
  unique (catalog_intent_id, source_material_id);
alter table private.catalog_video_recipe_references drop constraint catalog_video_recipe_references_catalog_intent_id_key;
alter table private.catalog_video_recipe_references add constraint catalog_video_recipe_references_catalog_intent_set_key
  unique (catalog_intent_id, video_set_id);

-- The sets of a generation in creative order: its segments, or its one set.
create function private.launch_generation_video_sets(p_team uuid, p_generation uuid)
returns table(ordinal integer, video_set_id uuid) language sql stable security definer set search_path = '' as $$
  select seg.ordinal, seg.video_set_id from private.launch_catalog_video_segments seg
   where seg.generation_id = p_generation and seg.team_id = p_team and seg.video_set_id is not null
  union all
  select 0, c.video_set_id from private.launch_catalog_video_contexts c
   where c.generation_id = p_generation and c.team_id = p_team and c.video_set_id is not null
     and not exists (select 1 from private.launch_catalog_video_segments seg
                      where seg.generation_id = p_generation and seg.video_set_id is not null)
  order by 1;
$$;
revoke all on function private.launch_generation_video_sets(uuid, uuid) from public, anon, authenticated, service_role;

-- One state for several sets: the worst one wins, ready only when all are.
create function private.catalog_video_sets_state(p_states text[])
returns text language sql immutable set search_path = '' as $$
  select case
    when p_states is null or cardinality(p_states) = 0 then null
    when 'unknown' = any(p_states) then 'unknown'
    when 'cancel_requested' = any(p_states) then 'cancel_requested'
    when 'canceled' = all(p_states) then 'canceled'
    when 'canceled' = any(p_states) then 'cancel_requested'
    when 'ready' = all(p_states) then 'ready'
    when 'preparing' = any(p_states) or 'ready' = any(p_states) then 'preparing'
    else 'accepted' end;
$$;
revoke all on function private.catalog_video_sets_state(text[]) from public, anon, authenticated, service_role;

-- The video generation of a Launch generation: its one set as before, or every
-- segment set added up, each listed, and the first failed segment named.
create function private.launch_video_generation_json(p_team uuid, p_generation uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when count(*) = 0 then null else jsonb_strip_nulls(jsonb_build_object(
    'setId', (array_agg(s.id order by x.ordinal))[1],
    'executor', private.catalog_video_public_executor((array_agg(s.id order by x.ordinal))[1]),
    'requestedCount', sum(s.requested_count),
    'registeredCount', sum((select count(*) from private.catalog_video_variants v where v.video_set_id = s.id and v.state = 'registered')),
    'state', private.catalog_video_sets_state(array_agg(s.state)),
    'activeChildOperationId', (select v.operation_id from private.catalog_video_variants v
        join public.team_operations o on o.id = v.operation_id and o.team_id = p_team
        join private.launch_generation_video_sets(p_team, p_generation) y on y.video_set_id = v.video_set_id
       where v.state in ('working', 'unknown') and o.state in ('pending', 'running')
       order by y.ordinal, v.video_variant_index limit 1),
    'segments', case when count(*) > 1 then jsonb_agg(jsonb_build_object('ordinal', x.ordinal, 'setId', s.id, 'state', s.state,
        'requestedCount', s.requested_count,
        'registeredCount', (select count(*) from private.catalog_video_variants v where v.video_set_id = s.id and v.state = 'registered'))
      order by x.ordinal) end,
    'failedOrdinal', case when count(*) > 1 then min(x.ordinal) filter (where s.state = 'unknown') end
  )) end
  from private.launch_generation_video_sets(p_team, p_generation) x
  join private.catalog_video_sets s on s.id = x.video_set_id and s.team_id = p_team;
$$;
revoke all on function private.launch_video_generation_json(uuid, uuid) from public, anon, authenticated, service_role;

-- Accept every segment of a plan with several creatives. Called by Launch
-- acceptance after the catalog intent holds the plan in its checkpoint.
create function private.accept_launch_catalog_video_segments(p_team uuid, p_actor uuid, p_generation uuid, p_intent uuid,
  p_executor uuid, p_config jsonb, p_video jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare plan jsonb := p_video->'plan'; segs jsonb := p_video->'plan'->'segments'; creatives jsonb := p_config->'creatives';
  preferences jsonb := p_video->'plan'->'preferences'; kind text := p_config->>'creativeKind';
  restitch boolean; k integer; n integer; seg jsonb; c jsonb; ord integer; row_at integer := 0; variants integer := 0;
  children jsonb := '[]'::jsonb; seed text; slice jsonb; assignments jsonb; source public.team_materials%rowtype;
  set_ids uuid[] := '{}';
begin
  restitch := preferences->'restitchEnabled' = 'true'::jsonb;
  n := (p_config->'catalog'->>'productCount')::integer;
  if jsonb_typeof(segs) is distinct from 'array' or jsonb_typeof(creatives) is distinct from 'array'
     or jsonb_array_length(segs) <> jsonb_array_length(creatives) or jsonb_array_length(segs) < 2
     or kind not in ('video', 'image') or (kind = 'image' and restitch)
     or jsonb_typeof(plan->'recipeRowIds') is distinct from 'array' or jsonb_array_length(plan->'recipeRowIds') <> n
     or (select count(distinct value) from jsonb_array_elements_text(plan->'recipeRowIds')) <> n
     or jsonb_typeof(plan->'assignmentSeed') is distinct from 'string' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  k := jsonb_array_length(segs);
  -- The foreground controller drives one set per enrollment: several videos run in the background.
  if restitch and (preferences ? 'foregroundExecutor'
     or exists (select 1 from private.catalog_video_foreground_authorities where enrollment_id = p_executor)) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  for ord in 0 .. k - 1 loop
    seg := segs->ord; c := creatives->ord;
    seed := encode(pg_catalog.sha256(convert_to((plan->>'assignmentSeed') || ':' || ord::text, 'UTF8')), 'hex');
    if jsonb_typeof(seg) is distinct from 'object' or seg->'ordinal' is distinct from to_jsonb(ord)
       or lower(seg->>'materialId') is distinct from lower(c->>'materialId')
       or seg->>'alias' is distinct from private.launch_normalize_sub(c->'alias')
       or seg->>'kind' is distinct from kind
       or seg->'rowStart' is distinct from to_jsonb(row_at) or seg->'rowCount' is distinct from c->'copies'
       or seg->>'assignmentSeed' is distinct from seed
       or jsonb_typeof(seg->'childRequestIds') is distinct from 'array' then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    if kind = 'image' or not restitch then
      if seg->'variantCount' is distinct from to_jsonb(case when kind = 'image' then 0 else 1 end)
         or seg->'setId' is distinct from 'null'::jsonb or jsonb_array_length(seg->'childRequestIds') <> 0 then
        raise exception 'INVALID_INPUT' using errcode = '22023';
      end if;
    else
      if jsonb_typeof(seg->'variantCount') is distinct from 'number' or (seg->>'variantCount')::integer not between 1 and (seg->>'rowCount')::integer
         or jsonb_typeof(seg->'setId') is distinct from 'string' or (seg->>'setId')::uuid = any(set_ids)
         or jsonb_array_length(seg->'childRequestIds') <> (seg->>'variantCount')::integer then
        raise exception 'INVALID_INPUT' using errcode = '22023';
      end if;
      set_ids := set_ids || (seg->>'setId')::uuid;
      variants := variants + (seg->>'variantCount')::integer;
    end if;
    children := children || (seg->'childRequestIds');
    row_at := row_at + (seg->>'rowCount')::integer;
  end loop;
  if row_at <> n or children is distinct from plan->'childRequestIds'
     or (restitch and (variants <> (preferences->>'videoVariationCount')::integer or plan->>'setId' is distinct from segs->0->>'setId'))
     or (not restitch and plan->'setId' is distinct from 'null'::jsonb) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if restitch then
    if jsonb_typeof(p_video->'segmentAssignments') is distinct from 'array' or jsonb_array_length(p_video->'segmentAssignments') <> k then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    for ord in 0 .. k - 1 loop
      seg := segs->ord; assignments := p_video->'segmentAssignments'->ord;
      select coalesce(jsonb_agg(e.value order by e.value), '[]'::jsonb) into slice
        from jsonb_array_elements_text(plan->'recipeRowIds') with ordinality e
       where e.ordinality - 1 between (seg->>'rowStart')::integer and (seg->>'rowStart')::integer + (seg->>'rowCount')::integer - 1;
      if jsonb_typeof(assignments) is distinct from 'array'
         or (select coalesce(jsonb_agg(a->>'recipeRowId' order by a->>'recipeRowId'), '[]'::jsonb) from jsonb_array_elements(assignments) a) is distinct from slice then
        raise exception 'INVALID_INPUT' using errcode = '22023';
      end if;
      -- The same proof the first video got: an active connected video and this actor's executor.
      perform public.service_initial_catalog_video_context_before_foreground(p_team, p_actor, (seg->>'materialId')::uuid, p_executor, true);
      select * into source from public.team_materials where id = (seg->>'materialId')::uuid and team_id = p_team for update;
      perform public.service_accept_catalog_video_set(p_team, p_actor, p_executor,
        jsonb_build_object('setId', seg->'setId', 'catalogIntentId', p_intent, 'sourceMaterialId', source.id,
          'sourceVersion', source.drive_version, 'settings', p_video->'settings', 'settingsDigest', p_video->'settingsDigest',
          'requestedCount', seg->'variantCount', 'productCount', seg->'rowCount', 'recipeRevision', 1, 'seed', seg->'assignmentSeed'),
        (select jsonb_agg(jsonb_build_object('index', x.ordinality - 1, 'requestId', x.value) order by x.ordinality)
           from jsonb_array_elements(seg->'childRequestIds') with ordinality x),
        assignments);
    end loop;
  end if;
  insert into private.launch_catalog_video_segments(generation_id, ordinal, team_id, material_id, kind, row_start, row_count,
    variant_count, video_set_id, assignment_seed)
  select p_generation, (s.value->>'ordinal')::integer, p_team, (s.value->>'materialId')::uuid, s.value->>'kind',
    (s.value->>'rowStart')::integer, (s.value->>'rowCount')::integer, (s.value->>'variantCount')::integer,
    nullif(s.value->>'setId', '')::uuid, s.value->>'assignmentSeed'
    from jsonb_array_elements(segs) s;
end $$;
revoke all on function private.accept_launch_catalog_video_segments(uuid, uuid, uuid, uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;

-- Launch acceptance: several creatives go through their segments.
select private.patch_function_062(
  'public.service_accept_launch_catalog_video_generation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure,
  $find$
 if set_id is not null then
  select * into source from public.team_materials where id=(p_config->>'materialId')::uuid and team_id=p_team for update;$find$,
  $repl$
 if jsonb_array_length(case when jsonb_typeof(p_config->'creatives')='array' then p_config->'creatives' else '[]'::jsonb end)>1
  or jsonb_array_length(case when jsonb_typeof(plan->'segments')='array' then plan->'segments' else '[]'::jsonb end)>1 then
  if reuse is not null then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  perform private.accept_launch_catalog_video_segments(p_team,p_actor,g.id,(intent->>'id')::uuid,executor,p_config,p_video);
 elsif set_id is not null then
  select * into source from public.team_materials where id=(p_config->>'materialId')::uuid and team_id=p_team for update;$repl$);

-- A ready set is reused for one video only.
select private.patch_function_062('private.launch_ready_video_reuse(uuid,uuid,uuid,jsonb,text)'::regprocedure,
  $find$ if private.can(p_team,'view',p_actor) is not true or private.can(p_team,'process',p_actor) is not true or private.can(p_team,'upload',p_actor) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;$find$,
  $repl$ if private.can(p_team,'view',p_actor) is not true or private.can(p_team,'process',p_actor) is not true or private.can(p_team,'upload',p_actor) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if jsonb_typeof(p_config->'creatives')='array' and jsonb_array_length(p_config->'creatives')>1 then return null;end if;$repl$);

-- Set acceptance: a source is accepted when it is the intent's video or one of its planned video segments,
-- and the existing set is found by (intent, source).
select private.patch_function_062('public.service_accept_catalog_video_set_before_foreground(uuid,uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure,
  $find$x.video_material_id=(p_payload->>'sourceMaterialId')::uuid and (p_payload->>'catalogMaterialId' is null$find$,
  $repl$(x.video_material_id=(p_payload->>'sourceMaterialId')::uuid or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(x.checkpoint#>'{initialVideoPlan,segments}')='array' then x.checkpoint#>'{initialVideoPlan,segments}' else '[]'::jsonb end) seg where seg->>'kind'='video' and lower(seg->>'materialId')=lower(p_payload->>'sourceMaterialId') and seg->>'setId'=p_payload->>'setId')) and (p_payload->>'catalogMaterialId' is null$repl$);
select private.patch_function_062('public.service_accept_catalog_video_set_before_foreground(uuid,uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure,
  $find$ select * into s from private.catalog_video_sets where catalog_video_sets.id=set_id or catalog_intent_id=intent or update_attempt_id=attempt for update;$find$,
  $repl$ select * into s from private.catalog_video_sets where catalog_video_sets.id=set_id or (catalog_intent_id=intent and source_material_id=(p_payload->>'sourceMaterialId')::uuid) or update_attempt_id=attempt order by (catalog_video_sets.id=set_id) desc limit 1 for update;$repl$);

-- Waiting: every set of the generation; the first uncertain segment is named.
drop function public.service_wait_launch_catalog_video(uuid, uuid, uuid, text, text);
create function public.service_wait_launch_catalog_video(p_team uuid, p_generation uuid, p_actor uuid, p_owner text, p_fence text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare g public.team_launch_generations%rowtype;states text[];failed integer;agg text;
begin
 perform public.service_read_launch_catalog_video_context(p_team,p_generation,p_actor,p_owner,p_fence);
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 select array_agg(s.state order by x.ordinal),min(x.ordinal) filter (where s.state='unknown') into states,failed
   from private.launch_generation_video_sets(p_team,g.id) x join private.catalog_video_sets s on s.id=x.video_set_id;
 if states is null then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 agg:=private.catalog_video_sets_state(states);
 update public.team_launch_generations set state=case when agg='unknown' then 'interrupted' else 'accepted' end,stage='catalog_planning',
  safe_error_code=case when agg='unknown' then 'PROCESS_RESULT_UNCERTAIN' else null end,retryable=false,
  lease_owner=null,lease_expires_at=clock_timestamp(),next_attempt_at=clock_timestamp()+interval '15 seconds',state_version=state_version+1,updated_at=clock_timestamp() where id=g.id;
 perform private.launch_signal(p_team,g.launch_id,(select aggregate_version from public.team_launches where id=g.launch_id));
 return jsonb_strip_nulls(jsonb_build_object('state',agg,'setCount',cardinality(states),'failedOrdinal',failed));
end;
$$;
revoke all on function public.service_wait_launch_catalog_video(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.service_wait_launch_catalog_video(uuid, uuid, uuid, text, text) to service_role;

-- Launch detail: progress and videoGeneration add up every set.
create or replace function public.get_launch_before_started_at(p_team uuid, p_launch uuid, p_revision uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;video jsonb;
begin
 result:=public.get_launch_before_catalog_video(p_team,p_launch,p_revision);
 if result#>>'{generation,id}' is null then return result;end if;
 video:=private.launch_video_generation_json(p_team,(result#>>'{generation,id}')::uuid);
 if video is null then return result;end if;
 if result#>>'{generation,stage}' in('accepted','preparing','catalog_planning') and result#>>'{generation,state}' not in('succeeded','canceled') then
  result:=jsonb_set(result,'{generation,progress}',jsonb_build_object('completed',(video->>'registeredCount')::integer,'total',(video->>'requestedCount')::integer,'unit','videos','source','registered_video_variants'));
 end if;
 return jsonb_set(result,'{generation,videoGeneration}',video);
end;
$$;

-- The Launch list: the same aggregate (one set stays as it was).
select private.patch_function_062('private.list_launches_pre_assignment(uuid,jsonb,integer)'::regprocedure,
  $find$'videoGeneration',(select jsonb_build_object('setId',v.id,'state',v.state,'requestedCount',v.requested_count,'registeredCount',(select count(*) from private.catalog_video_variants c where c.video_set_id=v.id and c.state='registered'))
            from private.catalog_video_sets v join private.catalog_generation_intents i on i.id=v.catalog_intent_id and i.team_id=v.team_id where v.team_id=l.team_id and i.request_key='launch:'||g.id::text||':catalog' limit 1))$find$,
  $repl$'videoGeneration',case when exists(select 1 from private.launch_catalog_video_segments seg where seg.generation_id=g.id and seg.video_set_id is not null)
            then (select jsonb_build_object('setId',x->'setId','state',x->'state','requestedCount',x->'requestedCount','registeredCount',x->'registeredCount','segments',x->'segments')||case when x ? 'failedOrdinal' then jsonb_build_object('failedOrdinal',x->'failedOrdinal') else '{}'::jsonb end from private.launch_video_generation_json(l.team_id,g.id) x)
            else (select jsonb_build_object('setId',v.id,'state',v.state,'requestedCount',v.requested_count,'registeredCount',(select count(*) from private.catalog_video_variants c where c.video_set_id=v.id and c.state='registered'))
            from private.catalog_video_sets v join private.catalog_generation_intents i on i.id=v.catalog_intent_id and i.team_id=v.team_id where v.team_id=l.team_id and i.request_key='launch:'||g.id::text||':catalog' limit 1) end)$repl$);

-- The initial read: the plan's own set first; while preparing, every set of the intent added up.
create or replace function public.service_read_initial_catalog_video_before_foreground(p_team uuid, p_actor uuid, p_key text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare i private.catalog_generation_intents%rowtype;s private.catalog_video_sets%rowtype;n integer;sets jsonb;total integer;states text[];failed integer;
begin
 if private.can(p_team,'view',p_actor) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into i from private.catalog_generation_intents where team_id=p_team and actor_id=p_actor and request_key=p_key;
 if i.id is null or i.request_payload->>'catalogVideoProtocolVersion' is distinct from '1' then return null;end if;
 select * into s from private.catalog_video_sets where team_id=p_team and (catalog_intent_id=i.id and actor_id=p_actor or exists(select 1 from private.catalog_video_recipe_references ref where ref.video_set_id=catalog_video_sets.id and ref.team_id=p_team and ref.actor_id=p_actor and ref.catalog_intent_id=i.id and ref.recipe_revision=1))
  order by (catalog_video_sets.id::text=i.checkpoint#>>'{initialVideoPlan,setId}') desc,created_at,id limit 1;
 if i.state='registered' then
  if s.id is null then return i.result;end if;
  return i.result||jsonb_build_object('videoGenerationObservation',private.catalog_initial_video_progress(s.id,case when i.request_payload#>>'{videoPublication,mode}'='scheduled' then 'deferred_blank' else 'assigned' end,exists(select 1 from private.catalog_video_publication_policies where catalog_material_id=(i.checkpoint->>'materialId')::uuid and mode='held')));
 end if;
 if s.id is null then return null;end if;
 -- 062: several sets of one intent (one per video of a Launch with several creatives).
 select jsonb_agg(jsonb_build_object('ordinal',coalesce(seg.ordinal,0),'setId',x.id,'sourceMaterialId',x.source_material_id,'state',x.state,'requestedCount',x.requested_count,
          'registeredCount',(select count(*) from private.catalog_video_variants v where v.video_set_id=x.id and v.state='registered')) order by coalesce(seg.ordinal,0)),
        sum(x.requested_count),array_agg(x.state),min(seg.ordinal) filter (where x.state='unknown')
   into sets,total,states,failed
   from private.catalog_video_sets x left join private.launch_catalog_video_segments seg on seg.video_set_id=x.id
  where x.team_id=p_team and x.actor_id=p_actor and x.catalog_intent_id=i.id;
 if jsonb_array_length(coalesce(sets,'[]'::jsonb))>1 then
  select count(*) into n from private.catalog_video_variants v join private.catalog_video_sets x on x.id=v.video_set_id where x.team_id=p_team and x.actor_id=p_actor and x.catalog_intent_id=i.id and v.state='registered';
  return jsonb_strip_nulls(jsonb_build_object('outcome','preparing_video','catalogIntentId',i.id,'videoSetId',s.id,'requestedCount',total,'registeredCount',n,
   'state',case when i.state='canceled' then 'canceled' when private.catalog_video_sets_state(states) in('unknown','cancel_requested','canceled') then private.catalog_video_sets_state(states) else 'preparing' end,
   'videoSets',sets,'failedOrdinal',failed));
 end if;
 select count(*) into n from private.catalog_video_variants where video_set_id=s.id and state='registered';
 return jsonb_build_object('outcome','preparing_video','catalogIntentId',i.id,'videoSetId',s.id,'requestedCount',s.requested_count,'registeredCount',n,'state',case when i.state='canceled' then 'canceled' when s.state in('unknown','cancel_requested','canceled') then s.state else 'preparing' end);
end;$$;

-- The ready binding of one video of the plan: with several segments the source names its segment,
-- whose set must be ready over exactly its rows, requests and seed.
do $binding$
declare d text;
begin
  select pg_get_functiondef('public.service_read_initial_catalog_ready_binding(uuid,uuid,uuid,text)'::regprocedure) into d;
  if strpos(d, $find$ select * into i from private.catalog_generation_intents where team_id=p_team and actor_id=p_actor and video_material_id=p_source and request_key=p_key$find$) = 0 then
    raise exception 'PATCH_062_ANCHOR_MISSING: service_read_initial_catalog_ready_binding';
  end if;
end $binding$;
alter function public.service_read_initial_catalog_ready_binding(uuid, uuid, uuid, text) rename to service_read_initial_catalog_ready_binding_before_segments;
revoke all on function public.service_read_initial_catalog_ready_binding_before_segments(uuid, uuid, uuid, text) from public, anon, authenticated, service_role;
create function public.service_read_initial_catalog_ready_binding(p_team uuid, p_actor uuid, p_source uuid, p_key text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare i private.catalog_generation_intents%rowtype;s private.catalog_video_sets%rowtype;plan jsonb;seg jsonb;rows jsonb;
begin
 if private.can(p_team,'view',p_actor) is not true or private.can(p_team,'upload',p_actor) is not true or private.can(p_team,'process',p_actor) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into i from private.catalog_generation_intents where team_id=p_team and actor_id=p_actor and request_key=p_key and request_payload->>'catalogVideoProtocolVersion'='1' and request_payload->>'restitchEnabled'='true' and state<>'canceled';
 plan:=i.checkpoint->'initialVideoPlan';
 if i.id is null or jsonb_typeof(plan->'segments') is distinct from 'array' or jsonb_array_length(plan->'segments')<2 then
  return public.service_read_initial_catalog_ready_binding_before_segments(p_team,p_actor,p_source,p_key);
 end if;
 select value into seg from jsonb_array_elements(plan->'segments') where lower(value->>'materialId')=p_source::text and value->>'kind'='video' and jsonb_typeof(value->'setId')='string';
 if seg is null then return null;end if;
 select coalesce(jsonb_agg(e.value order by e.value),'[]'::jsonb) into rows from jsonb_array_elements_text(plan->'recipeRowIds') with ordinality e
  where e.ordinality-1 between (seg->>'rowStart')::integer and (seg->>'rowStart')::integer+(seg->>'rowCount')::integer-1;
 select * into s from private.catalog_video_sets where id=(seg->>'setId')::uuid and team_id=p_team and actor_id=p_actor and catalog_intent_id=i.id and source_material_id=p_source and state='ready';
 if s.id is null or s.recipe_revision<>1 or s.assignment_seed is distinct from seg->>'assignmentSeed' or s.product_count is distinct from (seg->>'rowCount')::integer or s.requested_count is distinct from (seg->>'variantCount')::integer or s.settings_snapshot->>'configured' is distinct from 'true' or not(s.settings_snapshot @> coalesce(i.request_payload->'restitchDuration','{}'::jsonb)) then return null;end if;
 if not exists(select 1 from private.catalog_video_recipe_references r where r.video_set_id=s.id and r.team_id=p_team and r.actor_id=p_actor and r.catalog_intent_id=i.id and r.recipe_revision=1)
  or (select jsonb_agg(coalesce(v.original_request_id,v.request_id)::text order by v.video_variant_index) from private.catalog_video_variants v where v.video_set_id=s.id) is distinct from seg->'childRequestIds'
  or (select coalesce(jsonb_agg(a.recipe_row_id::text order by a.recipe_row_id::text),'[]'::jsonb) from private.catalog_video_assignments a where a.video_set_id=s.id and a.recipe_revision=1) is distinct from rows then return null;end if;
 if not exists(select 1 from public.team_materials m join public.team_drive_connections d on d.id=m.connection_id and d.team_id=m.team_id where m.id=s.source_material_id and m.team_id=p_team and m.lifecycle='active' and d.state='connected' and m.drive_version=s.source_version and m.drive_file_id=s.source_snapshot->>'fileId' and m.connection_id=(s.source_snapshot->>'connectionId')::uuid and m.checksum=s.source_snapshot->>'checksum' and m.size_bytes=(s.source_snapshot->>'sizeBytes')::bigint and m.mime_type=s.source_snapshot->>'mimeType') then return null;end if;
 if (select count(*) from private.catalog_video_variants where video_set_id=s.id)<>s.requested_count or exists(select 1 from private.catalog_video_variants v left join public.team_materials m on m.id=v.output_material_id and m.team_id=p_team left join public.team_drive_connections d on d.id=m.connection_id and d.team_id=p_team left join public.team_operations o on o.id=v.operation_id and o.team_id=p_team where v.video_set_id=s.id and (v.state<>'registered' or m.lifecycle is distinct from 'active' or d.state is distinct from 'connected' or o.state is distinct from 'succeeded' or o.actor_id is distinct from p_actor or o.source_material_id is distinct from s.source_material_id or o.result_material_id is distinct from v.output_material_id or not exists(select 1 from private.team_operation_intents operation_intent where operation_intent.operation_id=o.id and operation_intent.team_id=p_team and operation_intent.tool_id='restitch' and operation_intent.expected_source_version=s.source_version))) then return null;end if;
 return jsonb_build_object('videoSetId',s.id,'catalogIntentId',i.id,'ordinal',(seg->>'ordinal')::integer);
exception when invalid_text_representation or numeric_value_out_of_range then return null;
end;$$;
revoke all on function public.service_read_initial_catalog_ready_binding(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.service_read_initial_catalog_ready_binding(uuid, uuid, uuid, text) to service_role;

-- Cancellation of a Launch reaches every segment set.
select private.patch_function_062('private.cancel_launch_catalog_video()'::regprocedure,
  $find$ if i.checkpoint->>'materialId' is not null then
  select * into policy$find$,
  $repl$ update private.catalog_video_sets x set state=case when exists(select 1 from private.catalog_video_variants v where v.video_set_id=x.id and v.state in('working','unknown')) then 'cancel_requested' else 'canceled' end,revision=revision+1,updated_at=clock_timestamp()
  where x.id in(select seg.video_set_id from private.launch_catalog_video_segments seg where seg.generation_id=new.id and seg.video_set_id is not null) and x.id is distinct from s.id and x.state in('accepted','preparing','unknown');
 if i.checkpoint->>'materialId' is not null then
  select * into policy$repl$);
select private.patch_function_062('private.cancel_launch_catalog_video()'::regprocedure,
  $find$ if new.state='canceled' and (s.state='cancel_requested' or not held) then$find$,
  $repl$ if new.state='canceled' and (s.state='cancel_requested' or not held or exists(select 1 from private.launch_catalog_video_segments seg join private.catalog_video_sets x on x.id=seg.video_set_id where seg.generation_id=new.id and x.state='cancel_requested')) then$repl$);

-- A segment set is quiescent on the same evidence as the plan's own set.
select private.patch_function_062('private.catalog_video_cancel_quiescent(uuid)'::regprocedure,
  $find$where original.video_set_id=s.id and original.catalog_intent_id=s.catalog_intent_id and original.team_id=s.team_id and original.actor_id=s.actor_id and parent.state in('cancel_requested','canceled_with_cleanup_pending'))then return false;end if;$find$,
  $repl$where (original.video_set_id=s.id or exists(select 1 from private.launch_catalog_video_segments seg where seg.generation_id=original.generation_id and seg.video_set_id=s.id)) and original.catalog_intent_id=s.catalog_intent_id and original.team_id=s.team_id and original.actor_id=s.actor_id and parent.state in('cancel_requested','canceled_with_cleanup_pending'))then return false;end if;$repl$);
select private.patch_function_062('private.catalog_video_cancel_quiescent(uuid)'::regprocedure,
  $find$and original.video_material_id=s.source_material_id and original.checkpoint#>>'{initialVideoPlan,setId}'=s.id::text)then return false;end if;$find$,
  $repl$and ((original.video_material_id=s.source_material_id and original.checkpoint#>>'{initialVideoPlan,setId}'=s.id::text) or exists(select 1 from private.launch_catalog_video_segments seg join private.launch_catalog_video_contexts ctx on ctx.generation_id=seg.generation_id where seg.video_set_id=s.id and seg.material_id=s.source_material_id and ctx.catalog_intent_id=original.id)))then return false;end if;$repl$);

-- Settlement: a segment set finds its generation; the generation ends only when no set still stops.
select private.patch_function_062('public.service_settle_catalog_video_cancellations(integer)'::regprocedure,
  $find$  select *into context from private.launch_catalog_video_contexts where catalog_intent_id=candidate.catalog_intent_id and video_set_id=candidate.id;$find$,
  $repl$  select *into context from private.launch_catalog_video_contexts where catalog_intent_id=candidate.catalog_intent_id and (video_set_id=candidate.id or exists(select 1 from private.launch_catalog_video_segments seg where seg.generation_id=launch_catalog_video_contexts.generation_id and seg.video_set_id=candidate.id));$repl$);
select private.patch_function_062('public.service_settle_catalog_video_cancellations(integer)'::regprocedure,
  $find$  if context.generation_id is not null and g.state in('cancel_requested','canceled_with_cleanup_pending')then$find$,
  $repl$  if context.generation_id is not null and g.state in('cancel_requested','canceled_with_cleanup_pending')
   and not exists(select 1 from private.launch_catalog_video_segments seg join private.catalog_video_sets other on other.id=seg.video_set_id where seg.generation_id=g.id and other.id<>s.id and other.state in('accepted','preparing','unknown','cancel_requested'))then$repl$);

-- Cancel of an initial catalog creation stops every unfinished set of its intent.
select private.patch_function_062('public.service_cancel_initial_catalog_video(uuid,uuid,text,uuid)'::regprocedure,
  $find$ if not created then update private.catalog_generation_intents set state='canceled'$find$,
  $repl$ update private.catalog_video_sets x set state=case when exists(select 1 from private.catalog_video_variants v where v.video_set_id=x.id and v.state in('working','unknown')) then 'cancel_requested' else 'canceled' end,revision=revision+1,updated_at=clock_timestamp()
  where x.catalog_intent_id=i.id and x.team_id=p_team and x.id is distinct from s.id and x.state in('accepted','preparing','unknown');
 if not created then update private.catalog_generation_intents set state='canceled'$repl$);

-- Retry of one failed segment of a Launch: reopens only that set's uncertain videos.
create function public.retry_launch_catalog_video_segment(p_generation uuid, p_ordinal integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare g public.team_launch_generations%rowtype;seg private.launch_catalog_video_segments%rowtype;answer jsonb;states text[];
begin
 select * into g from public.team_launch_generations where id=p_generation;
 if g.id is null then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 perform private.launch_access(g.team_id,'edit');
 perform 1 from public.team_launches where id=g.launch_id and team_id=g.team_id and archived_at is null for update;
 select * into g from public.team_launch_generations where id=p_generation for update;
 if g.actor_id is distinct from auth.uid() then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into seg from private.launch_catalog_video_segments where generation_id=g.id and ordinal=p_ordinal and team_id=g.team_id;
 if seg.video_set_id is null then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 if g.state not in('interrupted','accepted','running','waiting_dependency') or g.lease_expires_at>clock_timestamp() then raise exception 'WRONG_STATE' using errcode='55000';end if;
 answer:=public.service_retry_failed_catalog_video_variants(seg.video_set_id,g.team_id,g.actor_id);
 select array_agg(s.state) into states from private.launch_generation_video_sets(g.team_id,g.id) x join private.catalog_video_sets s on s.id=x.video_set_id;
 -- The generation resumes waiting once no set is uncertain any more.
 if g.state='interrupted' and g.safe_error_code='PROCESS_RESULT_UNCERTAIN' and private.catalog_video_sets_state(states) not in('unknown','canceled','cancel_requested') then
  update public.team_launch_generations set state='accepted',stage='catalog_planning',safe_error_code=null,retryable=false,lease_owner=null,lease_expires_at=null,
   fence=fence+1,state_version=state_version+1,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp() where id=g.id returning * into g;
 end if;
 perform private.launch_signal(g.team_id,g.launch_id,(select aggregate_version from public.team_launches where id=g.launch_id));
 return jsonb_build_object('generationId',g.id,'ordinal',seg.ordinal,'setId',seg.video_set_id,'generationState',g.state,
  'retried',answer->'retried','registered',answer->'registered','terminal',answer->'terminal','uncertain',answer->'uncertain',
  'code',answer->'code','parentState',answer->'parentState');
end $$;
revoke all on function public.retry_launch_catalog_video_segment(uuid, integer) from public, anon;
grant execute on function public.retry_launch_catalog_video_segment(uuid, integer) to authenticated, service_role;

drop function private.patch_function_062(regprocedure, text, text);

commit;
