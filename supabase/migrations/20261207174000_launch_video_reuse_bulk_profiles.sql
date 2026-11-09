-- T036: future profile N uses the existing atomic CAS; active attempt snapshots remain immutable.
create or replace function public.patch_team_catalog_update_profile(
  p_team uuid, p_catalog uuid, p_expected_version bigint, p_patch jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare changed public.team_catalog_update_profiles%rowtype; key text;
  previous_interval text; target_interval text; target_schedule jsonb; previous_version bigint;
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  for key in select jsonb_object_keys(p_patch) loop
    if key = 'updateInterval' then
      if jsonb_typeof(p_patch -> key) not in ('string','null') or
         (jsonb_typeof(p_patch -> key) = 'string' and private.catalog_updater_interval(p_patch ->> key) is null) then
        raise exception 'INVALID_INPUT' using errcode = '22023';
      end if;
    elsif key = 'videoVariantCount' then
      if jsonb_typeof(p_patch->key) is distinct from 'number' or p_patch->>key !~ '^[0-9]+$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
    elsif key = 'schedule' then
      if not private.valid_catalog_schedule(nullif(p_patch -> key, 'null'::jsonb)) then
        raise exception 'INVALID_INPUT' using errcode = '22023';
      end if;
    elsif key not in ('refreshImages','refreshTexts','growProducts','randomLinkVariation','restitch')
          or jsonb_typeof(p_patch -> key) <> 'boolean' then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
  end loop;
  insert into public.team_catalog_updaters (team_id) values (p_team) on conflict (team_id) do nothing;
  -- Same lock order as interval setters and scheduled workers: team, then profile/item.
  perform 1 from public.team_catalog_updaters where team_id = p_team for update;
  select * into changed from public.team_catalog_update_profiles
   where team_id = p_team and catalog_material_id = p_catalog for update;
  if not found then raise exception 'NOT_FOUND' using errcode = '22023'; end if;
  if changed.version is distinct from p_expected_version then raise exception 'STALE_RESULT' using errcode = '40001'; end if;
  if p_patch ? 'videoVariantCount' then perform 1 from public.team_product_catalogs where material_id=p_catalog and team_id=p_team for share;end if;
  if p_patch ? 'videoVariantCount' and not exists(select 1 from public.team_product_catalogs c where c.material_id=p_catalog and c.team_id=p_team and (p_patch->>'videoVariantCount')::numeric between 1 and least(400,c.product_count)) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  previous_version := changed.version;
  select item.update_interval into previous_interval from public.team_catalog_updater_items as item
   where item.catalog_material_id = p_catalog;
  target_interval := case when p_patch ? 'updateInterval' then p_patch ->> 'updateInterval' else previous_interval end;
  target_schedule := case when p_patch ? 'schedule' then nullif(p_patch -> 'schedule','null'::jsonb)
    when target_interval is distinct from previous_interval then null else changed.schedule end;
  if target_schedule is not null and target_interval is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_patch ? 'updateInterval' then
    perform public.set_team_catalog_update_interval(p_team,array[p_catalog],target_interval);
  end if;
  update public.team_catalog_update_profiles as profile
     set refresh_images = coalesce((p_patch ->> 'refreshImages')::boolean, profile.refresh_images),
         refresh_texts = coalesce((p_patch ->> 'refreshTexts')::boolean, profile.refresh_texts),
         grow_products = coalesce((p_patch ->> 'growProducts')::boolean, profile.grow_products),
         random_link_variation = coalesce((p_patch ->> 'randomLinkVariation')::boolean, profile.random_link_variation),
         video_variant_count=coalesce((p_patch->>'videoVariantCount')::integer,profile.video_variant_count),
         restitch = coalesce((p_patch ->> 'restitch')::boolean, profile.restitch),
         schedule = target_schedule, version = previous_version + 1,
         updated_at = clock_timestamp(), updated_by = auth.uid()
   where profile.team_id = p_team and profile.catalog_material_id = p_catalog;
  if target_interval is not null and
     (target_interval is distinct from previous_interval or target_schedule is distinct from changed.schedule) then
    update public.team_catalog_updater_items set next_run_at = private.next_catalog_schedule(
      target_interval,target_schedule,clock_timestamp()) where catalog_material_id = p_catalog;
  end if;
  perform private.sync_catalog_updater(p_team);
  select * into changed from public.team_catalog_update_profiles where catalog_material_id = p_catalog;
  return jsonb_build_object('catalogId',changed.catalog_material_id,
    'refreshImages',changed.refresh_images,'refreshTexts',changed.refresh_texts,
    'growProducts',changed.grow_products,'randomLinkVariation',changed.random_link_variation,
    'restitch',changed.restitch,'videoVariantCount',changed.video_variant_count,'schedule',changed.schedule,
    'version',changed.version,'updatedAt',changed.updated_at);
end;
$$;

-- A delay-only generation may consume the SAME immutable READY recipe. Candidate
-- reads are hints; acceptance rechecks the full predicate under the set lock.
create function private.launch_ready_video_reuse(p_team uuid,p_launch uuid,p_actor uuid,p_config jsonb,p_digest text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare x private.launch_catalog_video_contexts%rowtype;s private.catalog_video_sets%rowtype;old_config jsonb;
begin
 if private.can(p_team,'view',p_actor) is not true or private.can(p_team,'process',p_actor) is not true or private.can(p_team,'upload',p_actor) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select c.* into x from public.team_launches l join public.team_launch_revisions r on r.id=l.active_revision_id and r.team_id=l.team_id join public.team_launch_generations g on g.revision_id=r.id and g.team_id=r.team_id join private.launch_catalog_video_contexts c on c.generation_id=g.id where l.id=p_launch and l.team_id=p_team and l.archived_at is null and c.actor_id=p_actor and g.state='succeeded' and exists(select 1 from private.catalog_generation_intents i where i.id=c.catalog_intent_id and i.team_id=p_team and i.actor_id=p_actor and i.state='registered');
 select r.config into old_config from public.team_launch_generations g join public.team_launch_revisions r on r.id=g.revision_id and r.team_id=g.team_id where g.id=x.generation_id;
 if x.generation_id is null or (old_config#-'{catalog,videoPublication}') is distinct from (p_config#-'{catalog,videoPublication}') or old_config#>'{catalog,videoPublication}' is not distinct from p_config#>'{catalog,videoPublication}' then return null;end if;
 select * into s from private.catalog_video_sets where id=x.video_set_id and team_id=p_team;
 if s.id is null or s.actor_id<>p_actor or s.state<>'ready' or s.recipe_revision<>1 or s.settings_digest is distinct from p_digest or s.requested_count<>(p_config#>>'{catalog,videoVariationCount}')::integer or s.product_count<>(p_config#>>'{catalog,productCount}')::integer or s.source_material_id<>(p_config->>'materialId')::uuid then return null;end if;
 if not exists(select 1 from public.team_materials m join public.team_drive_connections d on d.id=m.connection_id and d.team_id=m.team_id where m.id=s.source_material_id and m.team_id=p_team and m.lifecycle='active' and d.state='connected' and m.drive_version=s.source_version and m.drive_file_id=s.source_snapshot->>'fileId' and m.connection_id=(s.source_snapshot->>'connectionId')::uuid and m.checksum=s.source_snapshot->>'checksum' and m.size_bytes=(s.source_snapshot->>'sizeBytes')::bigint and m.mime_type=s.source_snapshot->>'mimeType') then return null;end if;
 if (select count(*) from private.catalog_video_variants where video_set_id=s.id)<>s.requested_count or exists(select 1 from private.catalog_video_variants v left join public.team_materials m on m.id=v.output_material_id and m.team_id=p_team left join public.team_drive_connections d on d.id=m.connection_id and d.team_id=p_team left join public.team_operations o on o.id=v.operation_id and o.team_id=p_team where v.video_set_id=s.id and (v.state<>'registered' or m.lifecycle is distinct from 'active' or d.state is distinct from 'connected' or o.state is distinct from 'succeeded' or o.actor_id is distinct from p_actor or o.source_material_id is distinct from s.source_material_id or o.result_material_id is distinct from v.output_material_id or not exists(select 1 from private.team_operation_intents i where i.operation_id=o.id and i.team_id=p_team and i.tool_id='restitch' and i.expected_source_version=s.source_version))) then return null;end if;
 return jsonb_build_object('plan',x.initial_video_plan,'settings',s.settings_snapshot,'settingsDigest',s.settings_digest,'executorId',x.executor_id);
end;$$;
revoke all on function private.launch_ready_video_reuse(uuid,uuid,uuid,jsonb,text) from public,anon,authenticated,service_role;
create function public.service_find_launch_catalog_video_reuse(p_team uuid,p_launch uuid,p_actor uuid,p_config jsonb,p_digest text) returns jsonb language sql stable security definer set search_path='' as $$ select private.launch_ready_video_reuse(p_team,p_launch,p_actor,p_config,p_digest);$$;
revoke all on function public.service_find_launch_catalog_video_reuse(uuid,uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.service_find_launch_catalog_video_reuse(uuid,uuid,uuid,jsonb,text) to service_role;

create or replace function public.service_accept_launch_catalog_video_generation(p_team uuid,p_launch uuid,p_actor uuid,p_expected_version text,p_key text,p_digest text,p_config jsonb,p_sources jsonb,p_preview jsonb,p_video jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare accepted jsonb;g public.team_launch_generations%rowtype;existing private.launch_catalog_video_contexts%rowtype;
 plan jsonb;preferences jsonb;settings jsonb;base jsonb;duration jsonb;payload jsonb;intent jsonb;catalog jsonb;executor uuid;
 reuse jsonb;set_id uuid;child jsonb;children jsonb;source public.team_materials%rowtype;now_ms bigint;lease_owner uuid:=gen_random_uuid();
begin
 if p_config->>'method' is distinct from 'catalog' or p_config->'catalog'->'catalogVideoProtocolVersion' is distinct from '1'::jsonb or jsonb_typeof(p_video) is distinct from 'object' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 accepted:=public.service_accept_launch_generation_before_video(p_team,p_launch,p_actor,p_expected_version,p_key,p_digest,p_config,p_sources,p_preview);
 select * into g from public.team_launch_generations where id=(accepted->>'id')::uuid and team_id=p_team for update;
 select * into existing from private.launch_catalog_video_contexts where generation_id=g.id;
 if existing.generation_id is not null then return accepted;end if;
 if accepted->>'replayed'='true' then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 perform private.freeze_launch_catalog_resources(p_team,g.id,p_actor);
 plan:=p_video->'plan';preferences:=plan->'preferences';settings:=p_video->'settings';executor:=(p_video->>'executorId')::uuid;
 now_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if jsonb_typeof(plan) is distinct from 'object' or octet_length(plan::text)>262144 or jsonb_typeof(preferences) is distinct from 'object'
  or preferences->'catalogVideoProtocolVersion' is distinct from '1'::jsonb
  or preferences->'restitchEnabled' is distinct from p_config->'catalog'->'restitchEnabled'
  or preferences->'videoVariationCount' is distinct from p_config->'catalog'->'videoVariationCount'
  or (preferences->'videoPublication' is distinct from p_config->'catalog'->'videoPublication' and not (preferences->'videoPublication'->>'mode'='scheduled' and p_config->'catalog'->'videoPublication'->>'mode'='scheduled' and preferences->'videoPublication'->>'localDateTime'=p_config->'catalog'->'videoPublication'->>'localDateTime' and preferences->'videoPublication'->>'resolvedOffset'=p_config->'catalog'->'videoPublication'->>'resolvedOffset' and (preferences->'videoPublication'->>'dueAt')::timestamptz=(p_config->'catalog'->'videoPublication'->>'dueAt')::timestamptz))
  or jsonb_typeof(plan->'acceptedAt') is distinct from 'number' or (plan->>'acceptedAt')::bigint not between now_ms-120000 and now_ms+1000
  or jsonb_typeof(plan->'recipeRowIds') is distinct from 'array' or jsonb_array_length(plan->'recipeRowIds')<>(p_config->'catalog'->>'productCount')::integer
  or jsonb_typeof(plan->'childRequestIds') is distinct from 'array' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if preferences->'videoPublication'->>'mode'='scheduled' and (preferences->'videoPublication'->>'dueAt')::timestamptz<=clock_timestamp() then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if preferences->'videoPublication'->>'mode' is null or preferences->'videoPublication'->>'mode' not in('immediate','scheduled') then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if preferences->>'restitchEnabled'='true' then
  reuse:=private.launch_ready_video_reuse(p_team,p_launch,p_actor,p_config,p_video->>'settingsDigest');
  if reuse is not null then
   perform 1 from private.catalog_video_sets where id=(reuse#>>'{plan,setId}')::uuid for update;
   reuse:=private.launch_ready_video_reuse(p_team,p_launch,p_actor,p_config,p_video->>'settingsDigest');
  end if;
  if reuse is not null then
   if (plan-'acceptedAt'-'preferences') is distinct from ((reuse->'plan')-'acceptedAt'-'preferences') or settings is distinct from reuse->'settings' or executor is distinct from (reuse->>'executorId')::uuid or preferences->>'expectedExecutorId' is distinct from executor::text then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
  else
  catalog:=public.service_initial_catalog_video_context(p_team,p_actor,(p_config->>'materialId')::uuid,executor,true);
  if executor is null or catalog->>'executorId' is distinct from executor::text or preferences->>'expectedExecutorId' is distinct from executor::text then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
  end if;
  if private.launch_restitch_settings_version(p_team,p_actor) is distinct from p_sources->>'restitchSettingsVersion' then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
  duration:=jsonb_build_object('finalDurationMode',p_config->'catalog'->'finalDurationMode','customFinalDurationSeconds',coalesce(nullif(p_config->'catalog'->'customFinalDurationSeconds','null'::jsonb),'2700'::jsonb));
  if p_config->'catalog'->>'finalDurationMode'='random-centered' and p_config->'catalog' ? 'finalDurationRangeSeconds' then duration:=duration||jsonb_build_object('finalDurationRangeSeconds',p_config->'catalog'->'finalDurationRangeSeconds');end if;
  if preferences->'restitchDuration' is distinct from duration then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  base:=private.effective_restitch_defaults_json(p_team,p_actor);
  if base is null then base:=jsonb_build_object('operation','restitch','sourceMode','drive','startImageIds','[]'::jsonb,'endImageIds','[]'::jsonb,'fitMode','cover','configured',true,'startEnabled',false,'endEnabled',true,'automaticEndFrame',true,'startDurationMode','one-frame','customStartDurationMs',100);end if;
  base:=base||duration;
  if (settings-'updatedAt'-'updatedBy') is distinct from (base-'updatedAt'-'updatedBy') or p_video->>'settingsDigest' is distinct from encode(pg_catalog.sha256(convert_to(private.launch_video_settings_json(settings),'UTF8')),'hex') then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
  set_id:=(plan->>'setId')::uuid;
  if set_id is null or jsonb_array_length(plan->'childRequestIds')<>(preferences->>'videoVariationCount')::integer then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 else
  if preferences->'restitchEnabled' is distinct from 'false'::jsonb or preferences->'videoVariationCount' is distinct from '1'::jsonb or plan->'setId' is distinct from 'null'::jsonb or jsonb_array_length(plan->'childRequestIds')<>0 or settings is distinct from 'null'::jsonb then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  executor:=null;
 end if;
 payload:=jsonb_build_object('teamId',p_team,'videoMaterialId',p_config->'materialId','sourceLink',p_preview->'advertisingUrl','productCount',p_config->'catalog'->'productCount','randomLinkVariation',true,'replacesMaterialId','null'::jsonb,'restitchOperationId','null'::jsonb,'idempotencyKey','launch:'||g.id::text||':catalog')||preferences;
 if g.catalog_image_contract_version=2 then payload:=payload||jsonb_build_object('catalogImageContractVersion',2);end if;
 intent:=public.service_begin_catalog_intent(p_team,(p_config->>'materialId')::uuid,p_actor,'launch:'||g.id::text||':catalog',payload,lease_owner);
 update private.catalog_generation_intents set checkpoint=checkpoint||jsonb_build_object('initialVideoPlan',plan),lease_owner=null,lease_expires_at=clock_timestamp(),updated_at=clock_timestamp() where id=(intent->>'id')::uuid;
 if set_id is not null then
  select * into source from public.team_materials where id=(p_config->>'materialId')::uuid and team_id=p_team for update;
  select jsonb_agg(jsonb_build_object('index',ordinal-1,'requestId',value) order by ordinal) into children from jsonb_array_elements(plan->'childRequestIds') with ordinality x(value,ordinal);
  if reuse is not null then
   perform public.service_reference_ready_catalog_video_set(p_team,p_actor,set_id,jsonb_build_object('catalogIntentId',intent->'id','settingsDigest',p_video->'settingsDigest','sourceVersion',source.drive_version,'productCount',p_config->'catalog'->'productCount','recipeRevision',1,'seed',plan->'assignmentSeed'),p_video->'assignments');
  else
  perform public.service_accept_catalog_video_set(p_team,p_actor,executor,jsonb_build_object('setId',set_id,'catalogIntentId',intent->'id','sourceMaterialId',source.id,'sourceVersion',source.drive_version,'settings',settings,'settingsDigest',p_video->'settingsDigest','requestedCount',preferences->'videoVariationCount','productCount',p_config->'catalog'->'productCount','recipeRevision',1,'seed',plan->'assignmentSeed'),children,p_video->'assignments');
  end if;
 end if;
 insert into private.launch_catalog_video_contexts(generation_id,team_id,actor_id,executor_id,settings_snapshot,request_payload,initial_video_plan,catalog_intent_id,video_set_id)
 values(g.id,p_team,p_actor,executor,nullif(settings,'null'::jsonb),payload,plan,(intent->>'id')::uuid,set_id);
 return accepted;
end;
$$;
revoke all on function public.service_accept_launch_catalog_video_generation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.service_accept_launch_catalog_video_generation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb) to service_role;

create function public.service_read_catalog_video_consumer_acceptance(p_set uuid,p_team uuid,p_actor uuid,p_intent uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare receipt jsonb;
begin
 if private.can(p_team,'process',p_actor) is not true or private.can(p_team,'upload',p_actor) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 receipt:=public.service_read_catalog_video_acceptance(p_set,p_team,p_actor);
 if receipt is null or receipt->>'parentState'<>'ready' or not exists(select 1 from private.catalog_video_recipe_references r join private.catalog_generation_intents i on i.id=r.catalog_intent_id and i.team_id=r.team_id where r.video_set_id=p_set and r.team_id=p_team and r.actor_id=p_actor and r.catalog_intent_id=p_intent and r.recipe_revision=1 and i.actor_id=p_actor and i.state not in('failed','canceled') and i.video_material_id=(receipt#>>'{source,materialId}')::uuid) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 return receipt||jsonb_build_object('catalogIntentId',p_intent);
end;$$;
revoke all on function public.service_read_catalog_video_consumer_acceptance(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.service_read_catalog_video_consumer_acceptance(uuid,uuid,uuid,uuid) to service_role;

create or replace function public.service_attach_launch_catalog_before_catalog_sub(p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text) returns void language plpgsql security definer set search_path='' as $$
declare x private.launch_catalog_video_contexts%rowtype;g public.team_launch_generations%rowtype;r public.team_launch_revisions%rowtype;i private.catalog_generation_intents%rowtype;c public.team_product_catalogs%rowtype;m public.team_materials%rowtype;
begin
 select * into x from private.launch_catalog_video_contexts where generation_id=p_generation and team_id=p_team and actor_id=p_actor;
 if x.generation_id is null then perform public.service_attach_launch_catalog_legacy_inner(p_team,p_generation,p_actor,p_owner,p_fence);return;end if;
 perform public.service_touch_launch_generation(p_team,p_generation,p_actor,p_owner,p_fence,'catalog_registering');
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team;
 select * into r from public.team_launch_revisions where id=g.revision_id and team_id=p_team;
 select * into i from private.catalog_generation_intents where id=x.catalog_intent_id and team_id=p_team and actor_id=p_actor and state='registered' and request_key='launch:'||g.id::text||':catalog';
 if i.id is null or i.request_payload is distinct from x.request_payload or i.checkpoint->'initialVideoPlan' is distinct from x.initial_video_plan then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into c from public.team_product_catalogs where team_id=p_team and material_id=(i.result->'catalog'->>'materialId')::uuid and video_material_id=i.video_material_id and variant=i.variant and source_link=r.generated_url and product_count=(r.config->'catalog'->>'productCount')::integer;
 select * into m from public.team_materials where team_id=p_team and id=c.material_id and lifecycle='active';
 if c.material_id is null or m.id is null or not exists(select 1 from private.catalog_initial_publication_checks b where b.intent_id=i.id and b.team_id=p_team and b.actor_id=p_actor and b.catalog_material_id=c.material_id and b.state='verified') then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 if x.video_set_id is not null and not exists(select 1 from private.catalog_video_sets s where s.id=x.video_set_id and exists(select 1 from private.catalog_video_recipe_references ref where ref.video_set_id=s.id and ref.team_id=p_team and ref.catalog_intent_id=i.id and ref.actor_id=p_actor and ref.recipe_revision=1) and s.state='ready' and s.requested_count=(x.initial_video_plan#>>'{preferences,videoVariationCount}')::integer and not exists(select 1 from private.catalog_video_variants v where v.video_set_id=s.id and v.state<>'registered')) then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 insert into public.team_launch_revision_catalogs(team_id,revision_id,catalog_id,material_id,variant,name_snapshot,sheet_url,settings_snapshot)
 values(p_team,r.id,c.material_id,c.material_id,coalesce(c.variant,1),m.name,c.sheet_url,c.settings_snapshot||jsonb_build_object('_launchCatalogVideoProtocol',1,'_launchVideoSetId',x.video_set_id)) on conflict(revision_id) do nothing;
 update public.team_launch_generation_steps set state='succeeded',team_operation_id=i.operation_id,result_material_id=c.material_id,reserved_variant=i.variant,provider_intent_key=i.id::text,provider_file_id=m.drive_file_id,updated_at=clock_timestamp() where generation_id=g.id and stage='catalog_registering';
end;
$$;
revoke all on function public.service_attach_launch_catalog_before_catalog_sub(uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;

create or replace function public.service_read_launch_catalog_video_context(p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text) returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;c private.launch_catalog_video_contexts%rowtype;
begin
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team;
 if g.actor_id is distinct from p_actor or private.can(p_team,'edit',p_actor) is not true or g.state<>'running' or g.lease_owner is distinct from p_owner or g.fence::text is distinct from p_fence or g.lease_expires_at<=clock_timestamp() then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 select * into c from private.launch_catalog_video_contexts where generation_id=g.id and team_id=p_team and actor_id=p_actor;
 if c.generation_id is null then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 return jsonb_build_object('executorId',c.executor_id,'settings',c.settings_snapshot,'requestPayload',c.request_payload,'readyVideoSetId',case when exists(select 1 from private.catalog_video_sets s join private.catalog_video_recipe_references ref on ref.video_set_id=s.id and ref.team_id=s.team_id where s.id=c.video_set_id and s.state='ready' and s.catalog_intent_id<>c.catalog_intent_id and ref.catalog_intent_id=c.catalog_intent_id and ref.actor_id=p_actor and ref.recipe_revision=1) then c.video_set_id else null end);
end;
$$;
revoke all on function public.service_read_launch_catalog_video_context(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.service_read_launch_catalog_video_context(uuid,uuid,uuid,text,text) to service_role;
