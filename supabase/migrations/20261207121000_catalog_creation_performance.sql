-- Draw from one frozen eligible dictionary, rather than re-scanning it per product.
-- Keep the team lock, publication locks, round exhaustion and retry receipts intact.
create or replace function public.service_draw_product_catalog_images_v2(p_team uuid,p_count integer,p_attempt uuid default null,p_scope text default 'create') returns jsonb language plpgsql security definer set search_path='' as $$
declare images jsonb; pool jsonb; selected jsonb; used uuid[]; last_cycle integer;
begin
 if p_count is null or p_scope is null or p_count not between 1 and 400 or p_scope not in ('create','growth','refresh') then raise exception 'INVALID_INPUT'; end if;
 perform pg_advisory_xact_lock(hashtextextended('catalog-images-draw:'||p_team::text,0));
 if public.service_catalog_image_mode_v2(p_team)<>'v2' then return null; end if;
 if p_attempt is not null then
  select s.images into images from private.catalog_image_selections s where s.team_id=p_team and s.attempt_id=p_attempt and s.scope=p_scope;
  if found then
   -- Match finalize/revoke's deterministic publication lock order.
   perform 1 from private.catalog_image_publications p where p.team_id=p_team and p.id in
    (select (x->>'publicationId')::uuid from jsonb_array_elements(images) x) order by p.id for update;
   if exists(select 1 from jsonb_array_elements(images) x left join private.catalog_image_publications p on p.id=(x->>'publicationId')::uuid and p.team_id=p_team where p.state is distinct from 'ready') then raise exception 'IMAGE_PUBLICATION_REVOKED'; end if;
   return images;
  end if;
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('kind','r2','publicationId',a.publication_id,'poolEntryId',a.id,'publicUrl',a.public_url,'classification',a.classification,'revision',a.revision)), '[]'::jsonb) into pool
 from (select e.* from public.team_catalog_image_pool_entries e join private.catalog_image_publications p on p.id=e.publication_id
  where e.team_id=p_team and e.active and p.state='ready' order by p.id,e.id) a;
 if jsonb_array_length(pool)=0 then return '[]'; end if;
 select coalesce(array_agg(d.pool_entry_id),'{}'::uuid[]) into used from private.catalog_image_draws d where d.team_id=p_team;
 -- Cycle zero consumes the unused tail; later cycles independently shuffle the full pool.
 -- At most count + two pool lengths are materialized, even for a one-image pool.
 with candidates as (
  select x.value image, cycle, row_number() over(order by cycle,random()) n
  from generate_series(0,ceil(p_count::numeric/jsonb_array_length(pool))::integer) cycle
  cross join jsonb_array_elements(pool) x
  where cycle>0 or not ((x.value->>'poolEntryId')::uuid=any(used))
 ), chosen as (select * from candidates where n<=p_count)
 select jsonb_agg(jsonb_build_object('image',image,'cycle',cycle) order by n),max(cycle) into selected,last_cycle from chosen;
 -- Lock only publications actually drawn, in the same order as revoke/finalize.
 -- Dictionary reads must not block unrelated publications during a held attempt.
 perform 1 from private.catalog_image_publications p where p.team_id=p_team and p.id in
  (select (x->'image'->>'publicationId')::uuid from jsonb_array_elements(selected) x) order by p.id for update;
 if exists(select 1 from jsonb_array_elements(selected) x left join private.catalog_image_publications p
  on p.id=(x->'image'->>'publicationId')::uuid and p.team_id=p_team where p.state is distinct from 'ready') then raise exception 'IMAGE_PUBLICATION_REVOKED'; end if;
 select jsonb_agg(x.value->'image' order by x.n) into images from jsonb_array_elements(selected) with ordinality x(value,n);
 if last_cycle>0 then delete from private.catalog_image_draws where team_id=p_team; end if;
 insert into private.catalog_image_draws(team_id,pool_entry_id)
 select distinct p_team,(x->'image'->>'poolEntryId')::uuid from jsonb_array_elements(selected) x where (x->>'cycle')::integer=last_cycle on conflict do nothing;
 if p_attempt is not null then
  insert into private.catalog_image_uses(team_id,publication_id,catalog_attempt_id,row_identity)
  select p_team,(x.value->>'publicationId')::uuid,p_attempt,p_scope||':'||x.n::text from jsonb_array_elements(images) with ordinality x(value,n) on conflict do nothing;
  insert into private.catalog_image_selections values(p_team,p_attempt,p_scope,images);
 end if;
 return images;
end $$;

-- Parent authorization/lease refresh and the child checkpoint commit together.
-- Never drop either fence or turn an uncertain provider write into a fresh create.
create function public.service_checkpoint_launch_catalog_intent_v1(
 p_team uuid,p_intent uuid,p_actor uuid,p_owner uuid,p_fence text,p_state text,p_checkpoint jsonb,
 p_operation uuid,p_result jsonb,p_generation uuid,p_launch_owner text,p_launch_fence text,p_stage text
) returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.service_touch_launch_generation(p_team,p_generation,p_actor,p_launch_owner,p_launch_fence,p_stage);
 if not exists(select 1 from private.catalog_generation_intents i where i.id=p_intent and i.team_id=p_team and i.request_key='launch:'||p_generation::text||':catalog') then raise exception 'PERMISSION_DENIED'; end if;
 perform public.service_checkpoint_catalog_intent(p_team,p_intent,p_actor,p_owner,p_fence,p_state,p_checkpoint,p_operation,p_result);
end $$;
revoke all on function public.service_checkpoint_launch_catalog_intent_v1(uuid,uuid,uuid,uuid,text,text,jsonb,uuid,jsonb,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.service_checkpoint_launch_catalog_intent_v1(uuid,uuid,uuid,uuid,text,text,jsonb,uuid,jsonb,uuid,text,text,text) to service_role;

-- Empty fence heartbeats must not concatenate/re-serialize the large frozen rows.
create or replace function public.service_checkpoint_catalog_intent(p_team uuid,p_intent uuid,p_actor uuid,p_owner uuid,p_fence text,p_state text,p_checkpoint jsonb,p_operation uuid default null,p_result jsonb default null) returns void language plpgsql security definer set search_path='' as $$
declare r private.catalog_generation_intents%rowtype;begin
 if p_actor is null or not private.can(p_team,'view',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into r from private.catalog_generation_intents where team_id=p_team and id=p_intent for update;
 if not found or r.actor_id<>p_actor or r.lease_owner<>p_owner or r.fence::text<>p_fence or r.lease_expires_at<=clock_timestamp() or r.state in('registered','canceled') then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 if p_operation is not null and not exists(select 1 from public.team_operations where id=p_operation and team_id=p_team and actor_id=p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if p_state='registered' and p_result is null then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if r.operation_id is not null and exists(select 1 from public.team_operations where id=r.operation_id and state='canceled') and p_state not in('cleanup_pending','interrupted','canceled') then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if jsonb_typeof(p_checkpoint)<>'object' or octet_length(p_checkpoint::text)>16777216 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 update private.catalog_generation_intents set state=p_state,checkpoint=case when p_checkpoint='{}'::jsonb then checkpoint else checkpoint||p_checkpoint end,operation_id=coalesce(p_operation,operation_id),result=coalesce(p_result,result),lease_expires_at=case when p_state in('interrupted','cleanup_pending') then clock_timestamp() else clock_timestamp()+interval '180 seconds' end,next_attempt_at=case when p_state in('interrupted','cleanup_pending','create_started','created','finalized') then clock_timestamp()+interval '30 seconds' else null end,updated_at=clock_timestamp() where id=r.id;
end $$;

-- Only closed stage names and bounded numbers cross the diagnostic boundary.
create function private.catalog_generation_timings_v1(value jsonb) returns jsonb language sql immutable set search_path='' as $$
 select case when jsonb_typeof(value->'attempt')='number' and value->>'attempt' ~ '^[0-9]{1,6}$'
  and jsonb_typeof(value->'steps')='object' then jsonb_build_object('attempt',(value->>'attempt')::integer,'steps',
   coalesce((select jsonb_object_agg(key,jsonb_build_object('calls',(metric->>'calls')::integer,'total_ms',(metric->>'total_ms')::bigint))
    from jsonb_each(case when jsonb_typeof(value->'steps')='object' then value->'steps' else '{}'::jsonb end) x(key,metric)
    where key=any(array['image_contract','video_context','settings','catalog_lookup','drive_client','video_proof','destination','resource_selection','row_recipe','name_conflicts','source_link','operation_start','operation_running','sheet_rows','image_validation','xlsx_build','sheet_upload','permission_read','permission_write','intent_binding','catalog_finalize','catalog_link','image_finalize','checkpoint'])
     and jsonb_typeof(metric->'calls')='number' and metric->>'calls' ~ '^[0-9]{1,5}$'
     and jsonb_typeof(metric->'total_ms')='number' and metric->>'total_ms' ~ '^[0-9]{1,8}$'), '{}'::jsonb)) else null end;
$$;
revoke all on function private.catalog_generation_timings_v1(jsonb) from public,anon,authenticated;
grant execute on function private.catalog_generation_timings_v1(jsonb) to service_role;

-- Existing fenced checkpoint RPC stores only a normalized closed failure code.
-- Do not expose the private JSON or infer historical transitions from it.
create or replace view public.analytics_catalog_generations as
select i.id intent_id,i.team_id,i.actor_id,i.operation_id,i.attempt,
 case when i.request_key like 'launch:%' then 'launch' else 'standalone' end origin,
 case when i.state in ('reserved','planning','planned','create_started','created','finalized','registered','interrupted','cleanup_pending','canceled') then i.state else 'unknown' end state,
 case when i.state in ('interrupted','cleanup_pending') then
   case
    when i.checkpoint ? 'safeErrorCode' and jsonb_typeof(i.checkpoint->'safeErrorCode') <> 'string' then 'UNKNOWN'
    when failure.code in ('NEEDS_REAUTH','PERMISSION_DENIED','SOURCE_CHANGED','NOT_FOUND','RATE_LIMITED','DRIVE_UNAVAILABLE','LEASE_MISMATCH','GROUP_RECONCILING','WRONG_STATE','INVALID_RESPONSE','LAUNCH_RESULT_UNCERTAIN','LAUNCH_INTERNAL_ERROR','IMAGE_PUBLICATION_REVOKED','CATALOG_IMAGE_UPGRADE_REQUIRED') then failure.code
    when failure.code is not null then 'UNKNOWN'
    else null
   end
 else null end safe_error_code,
 i.created_at,i.updated_at,
 coalesce(jsonb_typeof(i.checkpoint->'settings')='object',false) settings_observed,
 coalesce(jsonb_typeof(i.checkpoint->('source_'||i.video_material_id::text))='object',false) source_observed,
 coalesce(jsonb_typeof(i.checkpoint->'sheetRows')='array',false) rows_planned,
 coalesce(jsonb_typeof(i.checkpoint->'providerFileId')='string',false) provider_result_observed,
 i.state='registered' result_registered,
 private.catalog_generation_timings_v1(i.checkpoint->'performance') performance
from private.catalog_generation_intents i
cross join lateral (
 select case when i.checkpoint ? 'safeErrorCode' then i.checkpoint->>'safeErrorCode'
   else i.safe_error_code end code
) failure;

-- Reset inherited/default ACLs even when the view already exists.
revoke all on public.analytics_catalog_generations from public,anon,authenticated,service_role;
grant select on public.analytics_catalog_generations to service_role;
do $$ begin
 if exists(select 1 from pg_catalog.pg_roles where rolname='wishly_analytics_ro') then
  revoke all on public.analytics_catalog_generations from wishly_analytics_ro;
  grant select on public.analytics_catalog_generations to wishly_analytics_ro;
  grant execute on function private.catalog_generation_timings_v1(jsonb) to wishly_analytics_ro;
 end if;
end $$;
