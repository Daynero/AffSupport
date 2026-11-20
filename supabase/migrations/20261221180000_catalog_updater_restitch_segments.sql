-- 062 (research R28, R31; task T065): an updater restitch round of a catalog
-- with several videos makes one restitch set per video.
--
-- A catalog whose publication target is 'creatives' with video segments gets,
-- per round, one catalog_video_sets row per video segment, each over its own
-- block of rows, its own share of the round's variations and its own seed:
--   share   = distributeVariations(rowCounts, V) - one each, then in turn,
--             skipping a video that has one variation per row; k <= V <= N;
--   rows    = the round's recipe rows rowStart..rowStart+rowCount-1;
--   seed    = hex(sha256(roundSeed || ':' || ordinal)) (as launch segments);
--   set     = ordinal 0 keeps the round's set_id, the others are new.
-- The round keeps ONE request row and ONE snapshot row, as before: about thirty
-- functions read them as one row per attempt. The per-video identity lives in
-- private.catalog_updater_variant_segments, unique per (attempt, source) and
-- per set. catalog_video_sets is now unique per (update attempt, source) and
-- recipe references per (update attempt, set).
--
-- What changes for such a round (a single-video catalog takes the exact path
-- it took before - every patch keeps the old branch):
--   * accept / adopt / resume return segments[{ordinal, set_id,
--     source_material_id, recipe_row_ids, child_request_ids, assignment_seed,
--     requested_count, provider_context}] beside the first set's fields, which
--     drive-ops/updater-variants.ts parses (parseCatalogUpdaterVariantSegments);
--   * a set is admitted only for its own segment (source and set id);
--   * read / outputs / targets / rounds / registry see every set of the round;
--   * cancel and the sweeps stop every set of the round;
--   * attaching the ready round writes a NEW 'creatives' target revision whose
--     video segments name the round's sets, and the publication cells context
--     reads that round's rows;
--   * a scheduled round's variation count is normalized to max(V, k).
-- Several videos are always restitched in the background (as launches, R6): a
-- foreground enrollment offered for such a round is retired unused.
begin;

create function private.patch_function_062r(p_function regprocedure, p_find text, p_replace text, p_count integer default 1)
returns void language plpgsql set search_path = '' as $$
declare d text; n integer;
begin
  d := pg_catalog.pg_get_functiondef(p_function);
  n := (pg_catalog.length(d) - pg_catalog.length(pg_catalog.replace(d, p_find, ''))) / pg_catalog.length(p_find);
  if n = 0 then raise exception 'PATCH_062_ANCHOR_MISSING: %', p_function; end if;
  if n <> p_count then raise exception 'PATCH_062_ANCHOR_COUNT: % (% found, % expected)', p_function, n, p_count; end if;
  execute pg_catalog.replace(d, p_find, p_replace);
end $$;
revoke all on function private.patch_function_062r(regprocedure, text, text, integer) from public, anon, authenticated, service_role;

-- Constraints: one set per video of an update attempt.
alter table private.catalog_video_sets add constraint catalog_video_sets_update_attempt_source_key unique (update_attempt_id, source_material_id);
alter table private.catalog_video_sets drop constraint catalog_video_sets_update_attempt_id_key;
alter table private.catalog_video_recipe_references add constraint catalog_video_recipe_references_update_attempt_set_key unique (update_attempt_id, video_set_id);
alter table private.catalog_video_recipe_references drop constraint catalog_video_recipe_references_update_attempt_id_key;

-- The videos of one updater round: frozen when the round's request is written.
create table private.catalog_updater_variant_segments (
  attempt_id uuid not null,
  ordinal integer not null check (ordinal between 0 and 399),
  team_id uuid not null,
  request_id uuid not null references private.catalog_updater_variant_requests(request_id),
  catalog_material_id uuid not null,
  source_material_id uuid not null,
  set_id uuid not null unique,
  row_start integer not null check (row_start between 0 and 399),
  row_count integer not null check (row_count between 1 and 400),
  recipe_row_ids jsonb not null,
  child_request_ids jsonb not null,
  assignment_seed text not null check (assignment_seed ~ '^[a-f0-9]{64}$'),
  requested_count integer not null,
  provider_context jsonb not null check (jsonb_typeof(provider_context) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (attempt_id, ordinal),
  unique (attempt_id, source_material_id),
  foreign key (attempt_id, team_id) references public.team_catalog_update_attempts(attempt_id, team_id),
  foreign key (source_material_id, team_id) references public.team_materials(id, team_id),
  foreign key (catalog_material_id, team_id) references public.team_materials(id, team_id),
  check (row_start + row_count <= 400),
  check (jsonb_typeof(recipe_row_ids) = 'array' and jsonb_array_length(recipe_row_ids) = row_count),
  check (requested_count between 1 and row_count),
  check (jsonb_typeof(child_request_ids) = 'array' and jsonb_array_length(child_request_ids) = requested_count)
);
create index catalog_updater_variant_segments_request_idx on private.catalog_updater_variant_segments(request_id);
alter table private.catalog_updater_variant_segments enable row level security;
alter table private.catalog_updater_variant_segments force row level security;
revoke all on table private.catalog_updater_variant_segments from public, anon, authenticated, service_role;
create trigger catalog_updater_variant_segment_immutable before update on private.catalog_updater_variant_segments
  for each row execute function private.restitch_candidate_version_immutable();
create trigger task_cleanup_reference_fence before insert or update on private.catalog_updater_variant_segments
  for each row execute function private.guard_task_cleanup_reference();

-- The sets of the round a set belongs to, in video order; any other set is alone.
create function private.catalog_round_sets(p_set uuid)
returns table(set_id uuid, ordinal integer) language sql stable security definer set search_path = '' as $$
 select u.set_id, u.ordinal from private.catalog_updater_variant_segments u
  where u.attempt_id = (select x.attempt_id from private.catalog_updater_variant_segments x where x.set_id = p_set)
 union all
 select p_set, 0 where p_set is not null and not exists(select 1 from private.catalog_updater_variant_segments x where x.set_id = p_set)
$$;
revoke all on function private.catalog_round_sets(uuid) from public, anon, authenticated, service_role;

-- The state of a round: a lone set's own state (null when not admitted yet);
-- for several, the least advanced one (a set not admitted yet is 'accepted').
create function private.catalog_round_state(p_set uuid)
returns text language sql stable security definer set search_path = '' as $$
 select case
   when count(*) = 1 then max(s.state)
   when bool_or(s.state = 'cancel_requested') then 'cancel_requested'
   when bool_or(s.state = 'canceled') then 'canceled'
   when bool_or(s.state = 'unknown') then 'unknown'
   when bool_or(s.state = 'preparing') then 'preparing'
   when bool_or(s.id is null or s.state = 'accepted') then 'accepted'
   else 'ready' end
 from private.catalog_round_sets(p_set) x left join private.catalog_video_sets s on s.id = x.set_id
$$;
revoke all on function private.catalog_round_state(uuid) from public, anon, authenticated, service_role;

-- The video blocks of a catalog's current 'creatives' target.
create function private.catalog_updater_video_segments(p_catalog uuid)
returns table(ordinal integer, source_material_id uuid, row_start integer, row_count integer)
language sql stable security definer set search_path = '' as $$
 select g.ordinal, g.source_material_id, g.row_start, g.row_count
 from private.catalog_video_publication_policies p
 join private.catalog_publication_targets t on t.id = p.target_id and t.team_id = p.team_id and t.kind = 'creatives'
 join private.catalog_publication_target_segments g on g.target_id = t.id and g.kind = 'video'
 where p.catalog_material_id = p_catalog
$$;
revoke all on function private.catalog_updater_video_segments(uuid) from public, anon, authenticated, service_role;

-- What accept / adopt / resume answer: the request, plus its videos when it has several.
create function private.catalog_updater_variant_request_json(r private.catalog_updater_variant_requests)
returns jsonb language sql stable security definer set search_path = '' as $$
 select to_jsonb(r) || coalesce((select jsonb_build_object('segments', jsonb_agg(jsonb_build_object(
     'ordinal', u.ordinal, 'set_id', u.set_id, 'source_material_id', u.source_material_id,
     'recipe_row_ids', u.recipe_row_ids, 'child_request_ids', u.child_request_ids,
     'assignment_seed', u.assignment_seed, 'requested_count', u.requested_count,
     'provider_context', u.provider_context) order by u.ordinal))
   from private.catalog_updater_variant_segments u where u.attempt_id = r.attempt_id having count(*) > 0), '{}'::jsonb)
$$;
revoke all on function private.catalog_updater_variant_request_json(private.catalog_updater_variant_requests) from public, anon, authenticated, service_role;

-- Freeze the videos of a round of a catalog with several videos.
create function private.open_catalog_updater_round_segments(r private.catalog_updater_variant_requests)
returns void language plpgsql security definer set search_path = '' as $$
declare seg record; k integer; total integer; counts integer[]; shares integer[]; left_over integer; moved boolean;
  i integer; taken integer := 0; expected integer := 0; ctx jsonb;
begin
 if exists(select 1 from private.catalog_updater_variant_segments where attempt_id = r.attempt_id) then return; end if;
 select count(*)::integer, sum(s.row_count)::integer, array_agg(s.row_count order by s.ordinal)
   into k, total, counts from private.catalog_updater_video_segments(r.catalog_material_id) s;
 if k < 2 or total is distinct from r.product_count or jsonb_array_length(r.recipe_row_ids) <> r.product_count then
   raise exception 'WRONG_STATE' using errcode = '55000';
 end if;
 if r.requested_count < k or r.requested_count > total then raise exception 'VARIATIONS_RANGE' using errcode = '22023'; end if;
 -- distributeVariations: one each, then in turn, skipping a video with one variation per row.
 shares := array_fill(1, array[k]);
 left_over := r.requested_count - k;
 while left_over > 0 loop
   moved := false;
   for i in 1..k loop
     exit when left_over = 0;
     if shares[i] < counts[i] then shares[i] := shares[i] + 1; left_over := left_over - 1; moved := true; end if;
   end loop;
   exit when not moved;
 end loop;
 i := 0;
 for seg in select s.* from private.catalog_updater_video_segments(r.catalog_material_id) s order by s.ordinal loop
   if seg.ordinal <> i or seg.row_start <> expected or (i = 0 and seg.source_material_id <> r.source_material_id) then
     raise exception 'WRONG_STATE' using errcode = '55000';
   end if;
   ctx := case when i = 0 then r.provider_context
     else public.service_initial_catalog_video_context(r.team_id, r.actor_id, seg.source_material_id, r.executor_id, true)->'material' end;
   insert into private.catalog_updater_variant_segments(attempt_id, ordinal, team_id, request_id, catalog_material_id, source_material_id,
     set_id, row_start, row_count, recipe_row_ids, child_request_ids, assignment_seed, requested_count, provider_context)
   values (r.attempt_id, i, r.team_id, r.request_id, r.catalog_material_id, seg.source_material_id,
     case when i = 0 then r.set_id else gen_random_uuid() end, seg.row_start, seg.row_count,
     (select jsonb_agg(x.value order by x.o) from jsonb_array_elements(r.recipe_row_ids) with ordinality x(value, o)
       where x.o > seg.row_start and x.o <= seg.row_start + seg.row_count),
     (select jsonb_agg(x.value order by x.o) from jsonb_array_elements(r.child_request_ids) with ordinality x(value, o)
       where x.o > taken and x.o <= taken + shares[i + 1]),
     encode(sha256(convert_to(r.assignment_seed || ':' || i::text, 'UTF8')), 'hex'), shares[i + 1], ctx);
   taken := taken + shares[i + 1];
   expected := expected + seg.row_count;
   i := i + 1;
 end loop;
end $$;
revoke all on function private.open_catalog_updater_round_segments(private.catalog_updater_variant_requests) from public, anon, authenticated, service_role;

-- Stop every set of a round (a lone set: the same statement as before).
create function private.cancel_catalog_round_sets(p_set uuid)
returns void language sql security definer set search_path = '' as $$
 update private.catalog_video_sets s set state = case when exists(select 1 from private.catalog_video_variants v
     where v.video_set_id = s.id and v.state in ('working', 'unknown')) then 'cancel_requested' else 'canceled' end, revision = s.revision + 1
  where s.id in (select x.set_id from private.catalog_round_sets(p_set) x) and s.state not in ('cancel_requested', 'canceled');
$$;
revoke all on function private.cancel_catalog_round_sets(uuid) from public, anon, authenticated, service_role;

-- A new revision of the catalog's 'creatives' target whose video blocks name the round's sets.
create function private.open_catalog_round_creatives_target(r private.catalog_updater_variant_requests)
returns uuid language plpgsql security definer set search_path = '' as $$
declare p private.catalog_video_publication_policies%rowtype; target uuid; g record; n integer := 0; k integer;
begin
 select * into p from private.catalog_video_publication_policies where catalog_material_id = r.catalog_material_id and team_id = r.team_id;
 if p.target_id is null or not exists(select 1 from private.catalog_publication_targets t where t.id = p.target_id and t.kind = 'creatives') then
   raise exception 'WRONG_STATE' using errcode = '55000';
 end if;
 select count(*)::integer into k from private.catalog_updater_variant_segments where attempt_id = r.attempt_id;
 insert into private.catalog_publication_targets(team_id, kind) values (r.team_id, 'creatives') returning id into target;
 for g in select c.ordinal, c.kind, c.source_material_id, c.row_start, c.row_count, u.set_id
     from private.catalog_publication_target_segments c
     left join private.catalog_updater_variant_segments u on u.attempt_id = r.attempt_id and u.source_material_id = c.source_material_id
       and u.row_start = c.row_start and u.row_count = c.row_count
    where c.target_id = p.target_id order by c.ordinal loop
   if g.kind <> 'video' or g.set_id is null then raise exception 'WRONG_STATE' using errcode = '55000'; end if;
   insert into private.catalog_publication_target_segments(target_id, ordinal, team_id, kind, source_material_id, video_set_id, recipe_revision, row_start, row_count)
   values (target, g.ordinal, r.team_id, 'video', g.source_material_id, g.set_id, 1, g.row_start, g.row_count);
   n := n + 1;
 end loop;
 if n < 2 or n <> k then raise exception 'WRONG_STATE' using errcode = '55000'; end if;
 return target;
end $$;
revoke all on function private.open_catalog_round_creatives_target(private.catalog_updater_variant_requests) from public, anon, authenticated, service_role;

-- service_save_catalog_publication may adopt the round's fresh 'creatives' target
-- named (inside the same transaction) by service_attach_catalog_updater_variant_target.
create function private.catalog_round_creatives_target_allowed(p_team uuid, p_actor uuid, p_catalog uuid, p_target jsonb)
returns boolean language sql stable security definer set search_path = '' as $$
 select coalesce((select t.team_id = p_team and private.catalog_publication_target_json(t.id) = p_target
   and not exists(select 1 from private.catalog_video_publication_policies q where q.target_id = t.id)
   and not exists(select 1 from private.catalog_video_publication_jobs q where q.target_id = t.id)
   and exists(select 1 from private.catalog_publication_target_segments g where g.target_id = t.id)
   and not exists(select 1 from private.catalog_publication_target_segments g
       left join private.catalog_video_sets s on s.id = g.video_set_id and s.team_id = p_team
      where g.target_id = t.id and (g.video_set_id is null or s.id is null or s.state in ('canceled', 'cancel_requested')
        or not exists(select 1 from private.catalog_updater_variant_segments u where u.set_id = g.video_set_id and u.catalog_material_id = p_catalog)
        or private.catalog_video_recipe_consumer_allowed(g.video_set_id, p_team, g.recipe_revision, p_catalog, p_actor) is not true))
  from private.catalog_publication_targets t
  where t.kind = 'creatives' and t.id = nullif(pg_catalog.current_setting('soty.catalog_round_target', true), '')::uuid), false)
$$;
revoke all on function private.catalog_round_creatives_target_allowed(uuid, uuid, uuid, jsonb) from public, anon, authenticated, service_role;

-- Admission of a round: refusals, background executor, segments.
select private.patch_function_062r('public.service_accept_catalog_updater_variants(uuid,uuid,uuid,uuid,integer,bigint,uuid)'::regprocedure,
  $find$children jsonb;previous_actor text;$find$,
  $repl$children jsonb;previous_actor text;segmented boolean;executor uuid;$repl$);
select private.patch_function_062r('public.service_accept_catalog_updater_variants(uuid,uuid,uuid,uuid,integer,bigint,uuid)'::regprocedure,
  $find$ perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request::text,172));$find$,
  $repl$ if private.catalog_multi_creative_kind(p_catalog)='image' then raise exception 'MULTI_CREATIVE_UNSUPPORTED' using errcode='22023';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request::text,172));$repl$);
select private.patch_function_062r('public.service_accept_catalog_updater_variants(uuid,uuid,uuid,uuid,integer,bigint,uuid)'::regprocedure,
  $find$or(p_executor is not null and p_executor<>r.executor_id)then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
  return to_jsonb(r);$find$,
  $repl$or(p_executor is not null and p_executor<>r.executor_id and not exists(select 1 from private.catalog_updater_variant_segments u where u.attempt_id=r.attempt_id))then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
  return private.catalog_updater_variant_request_json(r);$repl$);
select private.patch_function_062r('public.service_accept_catalog_updater_variants(uuid,uuid,uuid,uuid,integer,bigint,uuid)'::regprocedure,
  $find$ ctx:=public.service_initial_catalog_video_context(p_team,p_actor,c.video_material_id,p_executor,true);$find$,
  $repl$ segmented:=coalesce(private.catalog_multi_creative_kind(p_catalog)='videos',false);
 executor:=p_executor;
 if segmented then
  if p_count<(select count(*) from private.catalog_updater_video_segments(p_catalog)) then raise exception 'VARIATIONS_RANGE' using errcode='22023';end if;
  -- Several videos are restitched in the background, one set per video.
  if exists(select 1 from private.catalog_video_foreground_authorities where enrollment_id=p_executor) then
   perform public.service_retire_unused_catalog_video_foreground(p_executor,p_team,p_actor);executor:=null;
  end if;
 end if;
 ctx:=public.service_initial_catalog_video_context(p_team,p_actor,c.video_material_id,executor,true);$repl$);
select private.patch_function_062r('public.service_accept_catalog_updater_variants(uuid,uuid,uuid,uuid,integer,bigint,uuid)'::regprocedure,
  $find$ where v.request_id=p_request returning v.*into r;
 return to_jsonb(r);$find$,
  $repl$ where v.request_id=p_request returning v.*into r;
 if segmented then perform private.open_catalog_updater_round_segments(r);end if;
 return private.catalog_updater_variant_request_json(r);$repl$);

-- Adoption of a scheduled round and resume return the segments too.
select private.patch_function_062r('public.service_adopt_catalog_variant_round(uuid,uuid,uuid,uuid,uuid)'::regprocedure,
  $find$then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;return to_jsonb(r);end if;$find$,
  $repl$then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;return private.catalog_updater_variant_request_json(r);end if;$repl$);
select private.patch_function_062r('public.service_adopt_catalog_variant_round(uuid,uuid,uuid,uuid,uuid)'::regprocedure,
  $find$policy.due_at,policy.time_zone)returning *into r;$find$,
  $repl$policy.due_at,policy.time_zone)returning *into r;
 if private.catalog_multi_creative_kind(p_catalog)='videos' then perform private.open_catalog_updater_round_segments(r);end if;$repl$);
select private.patch_function_062r('public.service_adopt_catalog_variant_round(uuid,uuid,uuid,uuid,uuid)'::regprocedure,
  $find$return to_jsonb(r);$find$, $repl$return private.catalog_updater_variant_request_json(r);$repl$);
select private.patch_function_062r('public.service_resume_catalog_updater_variants(uuid,uuid,uuid,uuid)'::regprocedure,
  $find$return to_jsonb(r);$find$, $repl$return private.catalog_updater_variant_request_json(r);$repl$);
select private.patch_function_062r('public.service_resume_catalog_variant_round(uuid,uuid,uuid,uuid,uuid)'::regprocedure,
  $find$return to_jsonb(r);$find$, $repl$return private.catalog_updater_variant_request_json(r);$repl$);

-- A scheduled round of several videos asks for at least one variation per video.
select private.patch_function_062r('private.capture_catalog_round_video_snapshot()'::regprocedure,
  $find$products:=least(400,c.product_count+case when new.profile_snapshot->>'growProducts'='true'then 1 else 0 end);$find$,
  $repl$products:=least(400,c.product_count+case when new.profile_snapshot->>'growProducts'='true'then 1 else 0 end);
 if private.catalog_multi_creative_kind(new.catalog_material_id)='videos' then
  n:=least(products,greatest(n,(select count(*)::integer from private.catalog_updater_video_segments(new.catalog_material_id))));
 end if;$repl$);

-- Set admission: a round of several videos admits each set only for its own video.
select private.patch_function_062r('public.service_accept_catalog_video_set_before_foreground(uuid,uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure,
  $find$and exists(select 1 from public.team_product_catalogs pc where pc.material_id=x.catalog_material_id and pc.team_id=p_team and pc.video_material_id=(p_payload->>'sourceMaterialId')::uuid)$find$,
  $repl$and case when exists(select 1 from private.catalog_updater_variant_segments u where u.attempt_id=x.attempt_id) then
   exists(select 1 from private.catalog_updater_variant_segments u where u.attempt_id=x.attempt_id and u.team_id=p_team and u.catalog_material_id=x.catalog_material_id
     and u.source_material_id=(p_payload->>'sourceMaterialId')::uuid and u.set_id=(p_payload->>'setId')::uuid)
   and exists(select 1 from private.catalog_updater_video_segments(x.catalog_material_id) g where g.source_material_id=(p_payload->>'sourceMaterialId')::uuid)
  else exists(select 1 from public.team_product_catalogs pc where pc.material_id=x.catalog_material_id and pc.team_id=p_team and pc.video_material_id=(p_payload->>'sourceMaterialId')::uuid) end$repl$);
select private.patch_function_062r('public.service_accept_catalog_video_set_before_foreground(uuid,uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure,
  $find$hashtextextended('catalog-video-set:'||coalesce(intent,attempt)::text,0)$find$,
  $repl$hashtextextended('catalog-video-set:'||coalesce(intent::text,attempt::text||':'||coalesce(p_payload->>'sourceMaterialId','')),0)$repl$);
select private.patch_function_062r('public.service_accept_catalog_video_set_before_foreground(uuid,uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure,
  $find$or update_attempt_id=attempt order by$find$,
  $repl$or (update_attempt_id=attempt and source_material_id=(p_payload->>'sourceMaterialId')::uuid) order by$repl$);

-- Read: the round's state, counts and failure over every set; segments for several.
select private.patch_function_062r('public.service_read_catalog_updater_variants_before_foreground(uuid,uuid,uuid,uuid)'::regprocedure,
  $find$select count(*)into ready from private.catalog_video_variants where video_set_id=r.set_id and state='registered';$find$,
  $repl$select count(*)into ready from private.catalog_video_variants where video_set_id in(select x.set_id from private.catalog_round_sets(r.set_id) x) and state='registered';$repl$);
select private.patch_function_062r('public.service_read_catalog_updater_variants_before_foreground(uuid,uuid,uuid,uuid)'::regprocedure,
  $find$else coalesce(s.state,'accepted')end$find$,
  $repl$else coalesce(private.catalog_round_state(r.set_id),'accepted')end$repl$);
select private.patch_function_062r('public.service_read_catalog_updater_variants_before_foreground(uuid,uuid,uuid,uuid)'::regprocedure,
  $find$coalesce(r.failure_code,private.catalog_video_failure_code(r.set_id))$find$,
  $repl$coalesce(r.failure_code,(select private.catalog_video_failure_code(x.set_id) from private.catalog_round_sets(r.set_id) x where private.catalog_video_failure_code(x.set_id) is not null order by x.ordinal limit 1))$repl$);
select private.patch_function_062r('public.service_read_catalog_updater_variants_before_foreground(uuid,uuid,uuid,uuid)'::regprocedure,
  $find$'serverNow',floor(extract(epoch from clock_timestamp())*1000)::bigint);
end;$find$,
  $repl$'serverNow',floor(extract(epoch from clock_timestamp())*1000)::bigint)
  ||coalesce((select jsonb_build_object('segments',jsonb_agg(jsonb_build_object('ordinal',u.ordinal,'setId',u.set_id,'materialId',u.source_material_id,
      'state',case when r.canceled_at is not null then 'canceled' else coalesce(x.state,'accepted') end,'requestedCount',u.requested_count,
      'registeredCount',(select count(*) from private.catalog_video_variants v where v.video_set_id=u.set_id and v.state='registered')) order by u.ordinal))
    from private.catalog_updater_variant_segments u left join private.catalog_video_sets x on x.id=u.set_id
   where u.attempt_id=r.attempt_id having count(*)>0),'{}'::jsonb);
end;$repl$);

-- Outputs: every row from its own video's set, in the round's row order.
select private.patch_function_062r('public.service_catalog_updater_variant_outputs(uuid,uuid,uuid)'::regprocedure,
  $find$if r.request_id is null or not exists(select 1 from private.catalog_video_sets s where s.id=r.set_id and s.team_id=p_team and s.state='ready')or not exists(select 1 from private.catalog_video_recipe_references ref where ref.video_set_id=r.set_id and ref.team_id=p_team and ref.recipe_revision=1 and ref.update_attempt_id=r.attempt_id and ref.actor_id=p_actor and ref.catalog_material_id=r.catalog_material_id)then$find$,
  $repl$if r.request_id is null or exists(select 1 from private.catalog_round_sets(r.set_id) x where not exists(select 1 from private.catalog_video_sets s where s.id=x.set_id and s.team_id=p_team and s.state='ready')or not exists(select 1 from private.catalog_video_recipe_references ref where ref.video_set_id=x.set_id and ref.team_id=p_team and ref.recipe_revision=1 and ref.update_attempt_id=r.attempt_id and ref.actor_id=p_actor and ref.catalog_material_id=r.catalog_material_id))then$repl$);
select private.patch_function_062r('public.service_catalog_updater_variant_outputs(uuid,uuid,uuid)'::regprocedure,
  $find$video_set_id=r.set_id$find$,
  $repl$video_set_id in(select x.set_id from private.catalog_round_sets(r.set_id) x)$repl$, 3);

-- The attach lane and the scheduled lane wait for every set.
select private.patch_function_062r('public.service_list_catalog_updater_variant_targets(integer)'::regprocedure,
  $find$s.state='ready'and private.can(q.team_id$find$,
  $repl$s.state='ready'and private.catalog_round_state(q.set_id)='ready'and private.can(q.team_id$repl$);
select private.patch_function_062r('public.service_list_catalog_variant_rounds(integer)'::regprocedure,
  $find$and not exists(select 1 from private.catalog_video_sets s where s.id=r.set_id)$find$,
  $repl$and exists(select 1 from private.catalog_round_sets(r.set_id) x where not exists(select 1 from private.catalog_video_sets s where s.id=x.set_id))$repl$);

-- Attach: a round of several videos publishes a new 'creatives' target revision.
select private.patch_function_062r('public.service_save_catalog_publication(uuid,uuid,uuid,uuid,bigint,text,timestamp with time zone,text,jsonb)'::regprocedure,
  $find$ elsif p_target->>'kind'='creatives' and p.target_id is not null and private.catalog_publication_target_json(p.target_id)=p_target then$find$,
  $repl$ elsif p_target->>'kind'='creatives' and private.catalog_round_creatives_target_allowed(p_team,p_actor,p_catalog,p_target) then
  target_id:=nullif(pg_catalog.current_setting('soty.catalog_round_target',true),'')::uuid;
 elsif p_target->>'kind'='creatives' and p.target_id is not null and private.catalog_publication_target_json(p.target_id)=p_target then$repl$);
select private.patch_function_062r('public.service_attach_catalog_updater_variant_target(uuid,uuid,uuid)'::regprocedure,
  $find$mode text;due timestamptz;zone text;$find$,
  $repl$mode text;due timestamptz;zone text;round_target uuid;$repl$);
select private.patch_function_062r('public.service_attach_catalog_updater_variant_target(uuid,uuid,uuid)'::regprocedure,
  $find$ receipt:=public.service_save_catalog_publication(p_team,p_actor,r.publication_request_id,r.catalog_material_id,private.catalog_variant_publication_revision(r.request_id),mode,due,zone,jsonb_build_object('kind','video_set','videoSetId',r.set_id,'recipeRevision',1));$find$,
  $repl$ if exists(select 1 from private.catalog_updater_variant_segments u where u.attempt_id=r.attempt_id) then
  round_target:=private.open_catalog_round_creatives_target(r);
  perform pg_catalog.set_config('soty.catalog_round_target',round_target::text,true);
  receipt:=public.service_save_catalog_publication(p_team,p_actor,r.publication_request_id,r.catalog_material_id,private.catalog_variant_publication_revision(r.request_id),mode,due,zone,private.catalog_publication_target_json(round_target));
  perform pg_catalog.set_config('soty.catalog_round_target','',true);
 else
  receipt:=public.service_save_catalog_publication(p_team,p_actor,r.publication_request_id,r.catalog_material_id,private.catalog_variant_publication_revision(r.request_id),mode,due,zone,jsonb_build_object('kind','video_set','videoSetId',r.set_id,'recipeRevision',1));
 end if;$repl$);

-- The round's own target: release, delivery, hold and displacement recognize a 'creatives' revision.
select private.patch_function_062r('public.service_release_catalog_variant_regular(uuid,uuid)'::regprocedure,
  $find$and vs.state='ready')then return false;end if;$find$,
  $repl$and vs.state='ready')and not(exists(select 1 from private.catalog_video_publication_policies p join private.catalog_publication_target_segments g on g.target_id=p.target_id where p.catalog_material_id=r.catalog_material_id and p.team_id=p_team and g.video_set_id=r.set_id and g.recipe_revision=1)and private.catalog_round_state(r.set_id)='ready')then return false;end if;$repl$);
select private.patch_function_062r('public.service_settle_catalog_variant_deliveries(integer)'::regprocedure,
  $find$where t.video_set_id=v.set_id and t.recipe_revision=1 and v.canceled_at$find$,
  $repl$where(t.video_set_id=v.set_id and t.recipe_revision=1 or exists(select 1 from private.catalog_publication_target_segments g where g.target_id=t.id and g.video_set_id=v.set_id and g.recipe_revision=1))and v.canceled_at$repl$);
select private.patch_function_062r('public.service_settle_catalog_variant_deliveries(integer)'::regprocedure,
  $find$and t.video_set_id=r.set_id and t.recipe_revision=1)then continue;$find$,
  $repl$and(t.video_set_id=r.set_id and t.recipe_revision=1 or exists(select 1 from private.catalog_publication_target_segments g where g.target_id=t.id and g.video_set_id=r.set_id and g.recipe_revision=1)))then continue;$repl$);
select private.patch_function_062r('private.cancel_displaced_catalog_variants()'::regprocedure,
  $find$and t.video_set_id=r.set_id and t.recipe_revision=1)then continue;$find$,
  $repl$and(t.video_set_id=r.set_id and t.recipe_revision=1 or exists(select 1 from private.catalog_publication_target_segments g where g.target_id=t.id and g.video_set_id=r.set_id and g.recipe_revision=1)))then continue;$repl$);
select private.patch_function_062r('private.cancel_displaced_catalog_variants()'::regprocedure,
  $find$update private.catalog_video_sets set state=case when exists(select 1 from private.catalog_video_variants where video_set_id=r.set_id and state in('working','unknown'))then 'cancel_requested'else 'canceled'end,revision=revision+1 where id=r.set_id and state not in('cancel_requested','canceled');$find$,
  $repl$perform private.cancel_catalog_round_sets(r.set_id);$repl$);
select private.patch_function_062r('private.hold_catalog_updater_variant_publication(private.catalog_updater_variant_requests)'::regprocedure,
  $find$t.kind='video_set'and t.video_set_id=r.set_id and t.recipe_revision=1 and exists($find$,
  $repl$(t.kind='video_set'and t.video_set_id=r.set_id and t.recipe_revision=1 or t.kind='creatives'and exists(select 1 from private.catalog_publication_target_segments g where g.target_id=t.id and g.video_set_id=r.set_id and g.recipe_revision=1))and exists($repl$);
select private.patch_function_062r('private.hold_catalog_updater_variant_publication(private.catalog_updater_variant_requests)'::regprocedure,
  $find$'held',null,null,jsonb_build_object('kind','video_set','videoSetId',r.set_id,'recipeRevision',1));$find$,
  $repl$'held',null,null,private.catalog_publication_target_json(policy.target_id));$repl$);
select private.patch_function_062r('private.catalog_video_cells_recovery_due_before_prepare()'::regprocedure,
  $find$and t.video_set_id=v.set_id)))$find$,
  $repl$and(t.video_set_id=v.set_id or exists(select 1 from private.catalog_publication_target_segments g where g.target_id=t.id and g.video_set_id=v.set_id)))))$repl$);

-- Cancel stops every set of the round.
select private.patch_function_062r('private.cancel_catalog_updater_variant_round(uuid,uuid,uuid)'::regprocedure,
  $find$ update private.catalog_video_sets set state=case when exists(select 1 from private.catalog_video_variants
   where video_set_id=r.set_id and state in('working','unknown')) then 'cancel_requested' else 'canceled' end,revision=revision+1
  where id=r.set_id and state not in('cancel_requested','canceled');$find$,
  $repl$ perform private.cancel_catalog_round_sets(r.set_id);$repl$);
select private.patch_function_062r('public.service_cancel_catalog_updater_variants(uuid,uuid,uuid,uuid)'::regprocedure,
  $find$update private.catalog_video_sets set state=case when exists(select 1 from private.catalog_video_variants where video_set_id=r.set_id and state in('working','unknown'))then 'cancel_requested'else 'canceled'end,revision=revision+1 where id=r.set_id and state not in('cancel_requested','canceled');$find$,
  $repl$perform private.cancel_catalog_round_sets(r.set_id);$repl$);

-- The manager's progress adds up every set of the round.
select private.patch_function_062r('private.catalog_registry_video_generation(uuid,uuid)'::regprocedure,
  $find$ if not found then select requested_count into n from private.catalog_variant_round_snapshots where set_id=sid and team_id=p_team;st:='accepted';end if;$find$,
  $repl$ if not found then select requested_count into n from private.catalog_variant_round_snapshots where set_id=sid and team_id=p_team;st:='accepted';end if;
 if exists(select 1 from private.catalog_updater_variant_segments u where u.set_id=sid) then
  select sum(u.requested_count)::integer into n from private.catalog_updater_variant_segments u
   where u.attempt_id=(select x.attempt_id from private.catalog_updater_variant_segments x where x.set_id=sid);
  st:=coalesce(private.catalog_round_state(sid),'accepted');
 end if;$repl$);
select private.patch_function_062r('private.catalog_registry_video_generation(uuid,uuid)'::regprocedure,
  $find$from private.catalog_video_variants where video_set_id=sid and state$find$,
  $repl$from private.catalog_video_variants where video_set_id in(select x.set_id from private.catalog_round_sets(sid) x) and state$repl$, 2);

-- Sweeps: every set of a round is looked at; a round already stopped is skipped.
select private.patch_function_062r('public.service_sweep_catalog_updater_rounds(integer)'::regprocedure,
  $find$  select req.request_id,req.team_id,req.catalog_material_id,req.set_id,req.attempt_id
  from private.catalog_updater_variant_requests req
  join public.team_catalog_update_attempts a on a.attempt_id=req.attempt_id and a.team_id=req.team_id and a.result='running'
  join private.catalog_video_sets s on s.id=req.set_id and s.team_id=req.team_id and s.state in('accepted','preparing','unknown')
  where req.canceled_at is null
    and exists(select 1 from private.catalog_video_variants v where v.video_set_id=req.set_id and v.state in('working','unknown'))$find$,
  $repl$  select req.request_id,req.team_id,req.catalog_material_id,rs.set_id,req.attempt_id
  from private.catalog_updater_variant_requests req
  cross join lateral private.catalog_round_sets(req.set_id) rs
  join public.team_catalog_update_attempts a on a.attempt_id=req.attempt_id and a.team_id=req.team_id and a.result='running'
  join private.catalog_video_sets s on s.id=rs.set_id and s.team_id=req.team_id and s.state in('accepted','preparing','unknown')
  where req.canceled_at is null
    and exists(select 1 from private.catalog_video_variants v where v.video_set_id=rs.set_id and v.state in('working','unknown'))$repl$);
select private.patch_function_062r('public.service_sweep_catalog_updater_rounds(integer)'::regprocedure,
  $find$  begin
  code:=null;$find$,
  $repl$  begin
  code:=null;
  if exists(select 1 from private.catalog_updater_variant_requests z where z.request_id=r.request_id and z.canceled_at is not null) then continue;end if;$repl$);
select private.patch_function_062r('private.settle_catalog_stuck_shapes(integer)'::regprocedure,
  $find$     where req.set_id=r.video_set_id and req.canceled_at is null limit 1;$find$,
  $repl$     where(req.set_id=r.video_set_id or exists(select 1 from private.catalog_updater_variant_segments u where u.request_id=req.request_id and u.set_id=r.video_set_id))and req.canceled_at is null limit 1;$repl$, 2);
select private.patch_function_062r('private.settle_catalog_stuck_shapes(integer)'::regprocedure,
  $find$  join private.catalog_video_sets s on s.id=req.set_id and s.state in('accepted','preparing','unknown')$find$,
  $repl$  cross join lateral private.catalog_round_sets(req.set_id) rs
  join private.catalog_video_sets s on s.id=rs.set_id and s.state in('accepted','preparing','unknown')$repl$);
select private.patch_function_062r('private.settle_catalog_stuck_shapes(integer)'::regprocedure,
  $find$  begin
   perform private.cancel_catalog_updater_variant_round(r.team_id,r.catalog_material_id,r.request_id);$find$,
  $repl$  begin
   if exists(select 1 from private.catalog_updater_variant_requests z where z.request_id=r.request_id and z.canceled_at is not null) then continue;end if;
   perform private.cancel_catalog_updater_variant_round(r.team_id,r.catalog_material_id,r.request_id);$repl$);

-- The non-video writer of a regular round finds the rows of a round's 'creatives' target.
select private.patch_function_062r('private.catalog_nonvideo_update_context(uuid,text)'::regprocedure,
  $find$ if recipe_ids is null then select request.recipe_row_ids into recipe_ids from private.catalog_updater_variant_requests request join private.catalog_publication_targets target on target.video_set_id=request.set_id and target.recipe_revision=1 where target.id=p.target_id and request.catalog_material_id=p_item;end if;$find$,
  $repl$ if recipe_ids is null then select request.recipe_row_ids into recipe_ids from private.catalog_updater_variant_requests request join private.catalog_publication_targets target on target.video_set_id=request.set_id and target.recipe_revision=1 where target.id=p.target_id and request.catalog_material_id=p_item;end if;
 if recipe_ids is null then select request.recipe_row_ids into recipe_ids from private.catalog_publication_target_segments g join private.catalog_updater_variant_segments u on u.set_id=g.video_set_id join private.catalog_updater_variant_requests request on request.request_id=u.request_id where g.target_id=p.target_id and g.recipe_revision=1 and request.catalog_material_id=p_item limit 1;end if;$repl$);

-- The publication cells context of a round's 'creatives' target: the round's rows,
-- after its regular update is verified (as the 'video_set' branch).
select private.patch_function_062r('public.service_catalog_publication_cells_context(uuid,uuid)'::regprocedure,
  $find$ if t.kind='creatives' then
  if exists($find$,
  $repl$ if t.kind='creatives' then
  if exists(select 1 from private.catalog_publication_target_segments g join private.catalog_updater_variant_segments u on u.set_id=g.video_set_id
     join private.catalog_variant_round_snapshots n on n.attempt_id=u.attempt_id where g.target_id=t.id and n.source_kind='updater' and n.regular_verified_at is null) then
   update private.catalog_video_publication_jobs set validation_epoch_started_at=null where id=j.id and dispatched_at is null;return jsonb_build_object('state','waiting');
  end if;
  if exists($repl$);
select private.patch_function_062r('public.service_catalog_publication_cells_context(uuid,uuid)'::regprocedure,
  $find$  select i.checkpoint->'initialVideoPlan'->'recipeRowIds' into row_ids from private.catalog_generation_intents i where i.team_id=j.team_id and i.checkpoint->>'materialId'=j.catalog_material_id::text order by i.created_at limit 1;$find$,
  $repl$  select rq.recipe_row_ids into row_ids from private.catalog_publication_target_segments g join private.catalog_updater_variant_segments u on u.set_id=g.video_set_id
    join private.catalog_updater_variant_requests rq on rq.request_id=u.request_id where g.target_id=t.id and rq.team_id=j.team_id and rq.catalog_material_id=j.catalog_material_id limit 1;
  if row_ids is null then select i.checkpoint->'initialVideoPlan'->'recipeRowIds' into row_ids from private.catalog_generation_intents i where i.team_id=j.team_id and i.checkpoint->>'materialId'=j.catalog_material_id::text order by i.created_at limit 1;end if;$repl$);

drop function private.patch_function_062r(regprocedure, text, text, integer);

commit;
