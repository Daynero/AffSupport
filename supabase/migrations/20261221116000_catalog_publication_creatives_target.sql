-- 062: the publication target of a catalog with several creatives or images.
--
-- A catalog publication policy names one target: one source video ('source')
-- or one restitch set ('video_set'). A catalog made of several videos, or of
-- images, gets the new kind 'creatives', whose rows in
-- private.catalog_publication_target_segments say which block of catalog
-- rows belongs to which creative: a source video, a restitch set, or an
-- image (H column). A single video keeps 'source' / 'video_set' as before.
--
-- Every reader of the target kind (research R31, task T085) either handles
-- 'creatives' or refuses it explicitly:
--   handled  - target JSON, observation, initial registration and its finish,
--              job actor rule, re-saving the same target (hold/reschedule),
--              the manager's waiting_for_videos;
--   refused  - growth recipe (MULTI_CREATIVE_UNSUPPORTED), baseline link
--              check finish (MULTI_CREATIVE_UNSUPPORTED), the publication
--              cells context until the segment lane lands (20261221140000);
--   inert    - readers that only act on 'video_set' (updater variant hold,
--              baseline sets, nonvideo context, R2 cell sources) do nothing
--              for 'creatives'; 20261221140000 extends the ones that must act.
begin;

create function private.patch_function_062(p_function regprocedure, p_find text, p_replace text)
returns void language plpgsql set search_path = '' as $$
declare d text;
begin
  d := pg_catalog.pg_get_functiondef(p_function);
  if pg_catalog.strpos(d, p_find) = 0 then raise exception 'PATCH_062_ANCHOR_MISSING: %', p_function; end if;
  if pg_catalog.strpos(pg_catalog.substr(d, pg_catalog.strpos(d, p_find) + pg_catalog.length(p_find)), p_find) > 0 then
    raise exception 'PATCH_062_ANCHOR_AMBIGUOUS: %', p_function;
  end if;
  execute pg_catalog.replace(d, p_find, p_replace);
end $$;
revoke all on function private.patch_function_062(regprocedure, text, text) from public, anon, authenticated, service_role;

alter table private.catalog_publication_targets drop constraint catalog_publication_targets_kind_check;
alter table private.catalog_publication_targets add constraint catalog_publication_targets_kind_check
  check (kind = any (array['source', 'video_set', 'creatives']));
alter table private.catalog_publication_targets drop constraint catalog_publication_targets_check;
alter table private.catalog_publication_targets add constraint catalog_publication_targets_check check (
  (kind = 'source' and source_material_id is not null and source_version is not null
    and length(source_version) between 1 and 128 and video_set_id is null and recipe_revision is null)
  or (kind = 'video_set' and source_material_id is null and source_version is null
    and video_set_id is not null and recipe_revision > 0)
  or (kind = 'creatives' and source_material_id is null and source_version is null
    and video_set_id is null and recipe_revision is null));

create table private.catalog_publication_target_segments (
  target_id uuid not null,
  ordinal integer not null check (ordinal between 0 and 399),
  team_id uuid not null,
  kind text not null check (kind in ('video', 'image')),
  source_material_id uuid not null,
  source_version text check (source_version is null or length(source_version) between 1 and 128),
  video_set_id uuid,
  recipe_revision bigint,
  -- The published creative image (20261221120000); null until the image is known.
  image_id uuid,
  row_start integer not null check (row_start between 0 and 399),
  row_count integer not null check (row_count between 1 and 400),
  primary key (target_id, ordinal),
  foreign key (target_id, team_id) references private.catalog_publication_targets(id, team_id),
  foreign key (source_material_id, team_id) references public.team_materials(id, team_id),
  foreign key (video_set_id, team_id, recipe_revision) references private.catalog_video_set_recipes(video_set_id, team_id, recipe_revision),
  check (row_start + row_count <= 400),
  check ((video_set_id is null) = (recipe_revision is null)),
  check (kind = 'video' or video_set_id is null),
  check (kind = 'image' or image_id is null),
  check (video_set_id is not null or source_version is not null)
);
alter table private.catalog_publication_target_segments enable row level security;
alter table private.catalog_publication_target_segments force row level security;
revoke all on table private.catalog_publication_target_segments from public, anon, authenticated, service_role;
create trigger catalog_publication_target_segment_immutable before update on private.catalog_publication_target_segments
  for each row execute function private.restitch_candidate_version_immutable();
create trigger task_cleanup_reference_fence before insert or update on private.catalog_publication_target_segments
  for each row execute function private.guard_task_cleanup_reference();

-- What a catalog is made of: 'videos' (several), 'image' (one or more), null otherwise.
create function private.catalog_multi_creative_kind(p_catalog uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when c.settings_snapshot->>'_catalogCreativeKind' = 'image' then 'image'
    when jsonb_typeof(c.settings_snapshot->'_catalogCreatives') = 'array' and jsonb_array_length(c.settings_snapshot->'_catalogCreatives') > 1 then 'videos'
    when exists (select 1 from private.catalog_video_publication_policies p join private.catalog_publication_targets t on t.id = p.target_id
                  where p.catalog_material_id = c.material_id and t.kind = 'creatives') then
      case when exists (select 1 from private.catalog_video_publication_policies p
                          join private.catalog_publication_target_segments g on g.target_id = p.target_id
                         where p.catalog_material_id = c.material_id and g.kind = 'image') then 'image' else 'videos' end
    else null end
  from public.team_product_catalogs c where c.material_id = p_catalog;
$$;
revoke all on function private.catalog_multi_creative_kind(uuid) from public, anon, authenticated;
grant execute on function private.catalog_multi_creative_kind(uuid) to service_role;

-- Target JSON: the segments of a 'creatives' target.
create or replace function private.catalog_publication_target_json(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
 select case t.kind when 'source' then jsonb_build_object('kind','source','materialId',t.source_material_id,'sourceVersion',t.source_version)
 when 'creatives' then jsonb_build_object('kind','creatives','segments',coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
   'ordinal',g.ordinal,'kind',g.kind,'materialId',g.source_material_id,'sourceVersion',g.source_version,'videoSetId',g.video_set_id,
   'recipeRevision',g.recipe_revision,'imageId',g.image_id,'rowStart',g.row_start,'rowCount',g.row_count)) order by g.ordinal)
   from private.catalog_publication_target_segments g where g.target_id=t.id),'[]'::jsonb))
 else jsonb_build_object('kind','video_set','videoSetId',t.video_set_id,'recipeRevision',t.recipe_revision) end from private.catalog_publication_targets t where t.id=p_id;
$$;

-- Observation of a 'creatives' target: the least available segment wins.
select private.patch_function_062('private.catalog_publication_target_observation(uuid)'::regprocedure,
  $find$ elsif t.kind='video_set' then
  select * into s from private.catalog_video_sets where id=t.video_set_id and team_id=t.team_id;$find$,
  $repl$ elsif t.kind='creatives' then
  select case
   when bool_or(m.id is null or (g.video_set_id is not null and (x.id is null or x.state in('canceled','cancel_requested')))) then 'unavailable'
   when bool_or(g.video_set_id is null and not private.catalog_publication_source_matches(g.source_material_id,t.team_id,g.source_version)) then 'changed'
   when bool_or(x.state in('accepted','preparing')) then 'preparing'
   when bool_or(x.state='unknown') then 'unknown'
   else 'available' end into status
  from private.catalog_publication_target_segments g
  left join public.team_materials m on m.id=g.source_material_id and m.team_id=t.team_id and m.lifecycle='active'
  left join private.catalog_video_sets x on x.id=g.video_set_id and x.team_id=t.team_id
  where g.target_id=t.id;
  status:=coalesce(status,'unknown');
 elsif t.kind='video_set' then
  select * into s from private.catalog_video_sets where id=t.video_set_id and team_id=t.team_id;$repl$);

-- Registration of the 'creatives' target of a new catalog from its frozen plan.
create function private.register_catalog_creatives_target(p_team uuid, p_actor uuid, p_intent uuid, p_primary uuid,
  p_plan jsonb, p_product_count integer, p_mode text, p_kind text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare target_id uuid; segs jsonb := p_plan->'segments'; seg jsonb; total integer := 0; m public.team_materials%rowtype;
begin
  if jsonb_typeof(segs) is distinct from 'array' or jsonb_array_length(segs) = 0 then
    -- A single image without a V2 plan: one block of every row.
    segs := jsonb_build_array(jsonb_build_object('ordinal', 0, 'materialId', p_primary, 'kind', p_kind,
      'rowStart', 0, 'rowCount', p_product_count, 'variantCount', 0, 'setId', null));
  end if;
  insert into private.catalog_publication_targets(team_id, kind) values (p_team, 'creatives') returning id into target_id;
  for seg in select value from jsonb_array_elements(segs) order by (value->>'ordinal')::integer loop
    if seg->>'kind' is distinct from p_kind or (seg->>'rowStart')::integer <> total then
      raise exception 'WRONG_STATE' using errcode = '55000';
    end if;
    select * into m from public.team_materials where id = (seg->>'materialId')::uuid and team_id = p_team and lifecycle = 'active' and category = p_kind;
    if m.id is null then raise exception 'SOURCE_CHANGED' using errcode = '55000'; end if;
    if p_kind = 'video' and jsonb_typeof(seg->'setId') = 'string' then
      if not exists (select 1 from private.catalog_video_sets s where s.id = (seg->>'setId')::uuid and s.team_id = p_team
          and s.actor_id = p_actor and s.catalog_intent_id = p_intent and s.source_material_id = m.id
          and s.product_count = (seg->>'rowCount')::integer and s.requested_count = (seg->>'variantCount')::integer
          and s.state not in ('canceled', 'cancel_requested')
          and (select count(*) from private.catalog_video_variants where video_set_id = s.id) = s.requested_count
          and (p_mode = 'scheduled' or (s.state = 'ready' and not exists (select 1 from private.catalog_video_variants v
                left join public.team_materials o on o.id = v.output_material_id and o.team_id = p_team
               where v.video_set_id = s.id and (v.state <> 'registered' or o.id is null or o.lifecycle <> 'active'))))) then
        raise exception 'WRONG_STATE' using errcode = '55000';
      end if;
      insert into private.catalog_publication_target_segments(target_id, ordinal, team_id, kind, source_material_id, video_set_id, recipe_revision, row_start, row_count)
      values (target_id, (seg->>'ordinal')::integer, p_team, 'video', m.id, (seg->>'setId')::uuid, 1, (seg->>'rowStart')::integer, (seg->>'rowCount')::integer);
    else
      insert into private.catalog_publication_target_segments(target_id, ordinal, team_id, kind, source_material_id, source_version, row_start, row_count)
      values (target_id, (seg->>'ordinal')::integer, p_team, p_kind, m.id, private.catalog_publication_source_version(m.id, p_team),
              (seg->>'rowStart')::integer, (seg->>'rowCount')::integer);
    end if;
    total := total + (seg->>'rowCount')::integer;
  end loop;
  if total <> p_product_count then raise exception 'WRONG_STATE' using errcode = '55000'; end if;
  return target_id;
end $$;
revoke all on function private.register_catalog_creatives_target(uuid, uuid, uuid, uuid, jsonb, integer, text, text) from public, anon, authenticated, service_role;

select private.patch_function_062('public.service_begin_initial_catalog_publication(uuid,uuid,uuid,uuid)'::regprocedure,
  $find$  if plan#>>'{preferences,restitchEnabled}'='true' then
   set_id:=(plan->>'setId')::uuid;$find$,
  $repl$  if jsonb_array_length(case when jsonb_typeof(plan->'segments')='array' then plan->'segments' else '[]'::jsonb end)>1 or i.request_payload->>'creativeKind'='image' then
   target_id:=private.register_catalog_creatives_target(p_team,p_actor,p_intent,i.video_material_id,plan,c.product_count,mode,coalesce(i.request_payload->>'creativeKind','video'));
  elsif plan#>>'{preferences,restitchEnabled}'='true' then
   set_id:=(plan->>'setId')::uuid;$repl$);

-- Finish of the initial publication: every segment still matches.
select private.patch_function_062('public.service_finish_initial_catalog_publication(uuid,uuid,uuid,uuid,uuid,text,text)'::regprocedure,
  $find$ if exists(select 1 from private.catalog_publication_targets t where t.id=p.target_id and ((t.kind='source' and $find$,
  $repl$ if exists(select 1 from private.catalog_publication_targets t join private.catalog_publication_target_segments g on g.target_id=t.id where t.id=p.target_id and t.kind='creatives'
   and ((g.video_set_id is null and not private.catalog_publication_source_matches(g.source_material_id,p_team,g.source_version))
    or (g.video_set_id is not null and (not exists(select 1 from private.catalog_video_sets s where s.id=g.video_set_id and s.team_id=p_team and s.state not in('canceled','cancel_requested') and (p.mode='scheduled' or s.state='ready'))
     or (p.mode<>'scheduled' and exists(select 1 from private.catalog_video_variants v left join public.team_materials m on m.id=v.output_material_id and m.team_id=p_team where v.video_set_id=g.video_set_id and (v.state<>'registered' or m.lifecycle is distinct from 'active'))))))) then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 if exists(select 1 from private.catalog_publication_targets t where t.id=p.target_id and ((t.kind='source' and $repl$);

-- Who may run a 'creatives' job: process rights, or upload rights when no segment is restitched.
select private.patch_function_062('private.catalog_publication_job_actor_allowed(uuid)'::regprocedure,
  $find$(private.can(j.team_id,'process',j.actor_id) or (t.kind='source' and $find$,
  $repl$(private.can(j.team_id,'process',j.actor_id) or (t.kind='creatives' and private.can(j.team_id,'upload',j.actor_id)
   and not exists(select 1 from private.catalog_publication_target_segments g where g.target_id=t.id and g.video_set_id is not null)
   and exists(select 1 from private.catalog_generation_intents i where i.team_id=j.team_id and i.actor_id=j.actor_id and i.checkpoint->>'materialId'=j.catalog_material_id::text and i.request_payload->>'restitchEnabled'='false' and i.request_payload->>'catalogVideoProtocolVersion'='1'))
  or (t.kind='source' and $repl$);

-- Re-saving a policy (hold, reschedule) keeps its own 'creatives' target; a new one cannot be invented.
select private.patch_function_062('public.service_save_catalog_publication(uuid,uuid,uuid,uuid,bigint,text,timestamp with time zone,text,jsonb)'::regprocedure,
  $find$ else raise exception 'INVALID_INPUT' using errcode='22023';end if;
 update private.catalog_video_publication_jobs set state='superseded'$find$,
  $repl$ elsif p_target->>'kind'='creatives' and p.target_id is not null and private.catalog_publication_target_json(p.target_id)=p_target then
  target_id:=p.target_id;
 else raise exception 'INVALID_INPUT' using errcode='22023';end if;
 update private.catalog_video_publication_jobs set state='superseded'$repl$);

-- The manager waits for every restitched segment.
select private.patch_function_062('private.catalog_registry_video_publication(uuid,uuid)'::regprocedure,
  $find$'waiting_for_videos', coalesce(t.kind = 'video_set' and s.state is distinct from 'ready', false))$find$,
  $repl$'waiting_for_videos', coalesce((t.kind = 'video_set' and s.state is distinct from 'ready')
      or (t.kind = 'creatives' and exists(select 1 from private.catalog_publication_target_segments g join private.catalog_video_sets x on x.id = g.video_set_id
                                           where g.target_id = t.id and x.state is distinct from 'ready')), false))$repl$);

-- Growth of a catalog with several creatives is not offered (research R27).
select private.patch_function_062('private.prepare_catalog_growth_video_recipe(uuid,text)'::regprocedure,
  $find$ if t.kind='source'then$find$,
  $repl$ if t.kind='creatives' then raise exception 'MULTI_CREATIVE_UNSUPPORTED' using errcode='22023';end if;
 if t.kind='source'then$repl$);

-- The link check of a catalog with several creatives is not offered (research R27).
select private.patch_function_062('public.service_finish_catalog_baseline_check(uuid,uuid,uuid,uuid,text,text,text,uuid,bigint)'::regprocedure,
  $find$ select * into b from private.catalog_publication_baseline_checks where id=p_check for update;$find$,
  $repl$ select * into b from private.catalog_publication_baseline_checks where id=p_check for update;
 if private.catalog_multi_creative_kind(b.catalog_material_id) is not null then raise exception 'MULTI_CREATIVE_UNSUPPORTED' using errcode='22023';end if;$repl$);

-- The cells context of the publication lane: segments arrive with 20261221140000.
select private.patch_function_062('public.service_catalog_publication_cells_context(uuid,uuid)'::regprocedure,
  $find$ if private.catalog_publication_job_actor_allowed(j.id) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;$find$,
  $repl$ if private.catalog_publication_job_actor_allowed(j.id) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if exists(select 1 from private.catalog_publication_targets x where x.id=j.target_id and x.kind='creatives') then raise exception 'MULTI_CREATIVE_UNSUPPORTED' using errcode='22023';end if;$repl$);

drop function private.patch_function_062(regprocedure, text, text);

commit;
