-- Optional Launch protocol freezes its complete N-set alongside the original
-- accepted generation. Legacy accepted generations retain their original path.
create table private.launch_catalog_video_contexts (
 generation_id uuid primary key references public.team_launch_generations(id) on delete restrict,
 team_id uuid not null references public.teams(id),actor_id uuid not null references auth.users(id),
 executor_id uuid,settings_snapshot jsonb,request_payload jsonb not null,initial_video_plan jsonb not null,
 catalog_intent_id uuid not null references private.catalog_generation_intents(id),
 video_set_id uuid references private.catalog_video_sets(id),created_at timestamptz not null default clock_timestamp(),
 check(jsonb_typeof(request_payload)='object' and octet_length(request_payload::text)<=32768),
 check(jsonb_typeof(initial_video_plan)='object' and octet_length(initial_video_plan::text)<=262144)
);
alter table private.launch_catalog_video_contexts enable row level security;
alter table private.launch_catalog_video_contexts force row level security;
revoke all on private.launch_catalog_video_contexts from public,anon,authenticated,service_role;
create trigger launch_catalog_video_context_immutable before update on private.launch_catalog_video_contexts for each row execute function private.restitch_candidate_version_immutable();
create trigger task_cleanup_reference_fence before insert or update on private.launch_catalog_video_contexts for each row execute function private.guard_task_cleanup_reference();

-- Match the closed, recursive canonical JSON used by the existing Edge settings
-- digest. These settings contain bounded scalar values, arrays and objects.
create function private.launch_video_settings_json(p_value jsonb) returns text language plpgsql immutable set search_path='' as $$
declare result text;
begin
 if jsonb_typeof(p_value)='object' then
  select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||private.launch_video_settings_json(value),',' order by key),'')||'}' into result from jsonb_each(p_value) where key not in('updatedAt','updatedBy');
 elsif jsonb_typeof(p_value)='array' then
  select '['||coalesce(string_agg(private.launch_video_settings_json(value),',' order by ordinal),'')||']' into result from jsonb_array_elements(p_value) with ordinality x(value,ordinal);
 else result:=p_value::text;end if;
 return result;
end;
$$;
revoke all on function private.launch_video_settings_json(jsonb) from public,anon,authenticated,service_role;

alter function public.service_accept_launch_generation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb) rename to service_accept_launch_generation_before_video;
revoke all on function public.service_accept_launch_generation_before_video(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb) from public,anon,authenticated,service_role;
create function public.service_accept_launch_generation(p_team uuid,p_launch uuid,p_actor uuid,p_expected_version text,p_key text,p_digest text,p_config jsonb,p_sources jsonb,p_preview jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if p_config->>'method'='catalog' and p_config->'catalog' ? 'catalogVideoProtocolVersion' then raise exception 'AGENT_UPDATE_REQUIRED' using errcode='55000';end if;
 return public.service_accept_launch_generation_before_video(p_team,p_launch,p_actor,p_expected_version,p_key,p_digest,p_config,p_sources,p_preview);
end;
$$;
revoke all on function public.service_accept_launch_generation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.service_accept_launch_generation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb) to service_role;

create function public.service_accept_launch_catalog_video_generation(p_team uuid,p_launch uuid,p_actor uuid,p_expected_version text,p_key text,p_digest text,p_config jsonb,p_sources jsonb,p_preview jsonb,p_video jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare accepted jsonb;g public.team_launch_generations%rowtype;existing private.launch_catalog_video_contexts%rowtype;
 plan jsonb;preferences jsonb;settings jsonb;base jsonb;duration jsonb;payload jsonb;intent jsonb;catalog jsonb;executor uuid;
 set_id uuid;child jsonb;children jsonb;source public.team_materials%rowtype;now_ms bigint;lease_owner uuid:=gen_random_uuid();
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
  catalog:=public.service_initial_catalog_video_context(p_team,p_actor,(p_config->>'materialId')::uuid,executor,true);
  if executor is null or catalog->>'executorId' is distinct from executor::text or preferences->>'expectedExecutorId' is distinct from executor::text then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
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
  perform public.service_accept_catalog_video_set(p_team,p_actor,executor,jsonb_build_object('setId',set_id,'catalogIntentId',intent->'id','sourceMaterialId',source.id,'sourceVersion',source.drive_version,'settings',settings,'settingsDigest',p_video->'settingsDigest','requestedCount',preferences->'videoVariationCount','productCount',p_config->'catalog'->'productCount','recipeRevision',1,'seed',plan->'assignmentSeed'),children,p_video->'assignments');
 end if;
 insert into private.launch_catalog_video_contexts(generation_id,team_id,actor_id,executor_id,settings_snapshot,request_payload,initial_video_plan,catalog_intent_id,video_set_id)
 values(g.id,p_team,p_actor,executor,nullif(settings,'null'::jsonb),payload,plan,(intent->>'id')::uuid,set_id);
 return accepted;
end;
$$;
revoke all on function public.service_accept_launch_catalog_video_generation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.service_accept_launch_catalog_video_generation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb) to service_role;

create function public.service_read_launch_catalog_video_context(p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text) returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;c private.launch_catalog_video_contexts%rowtype;
begin
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team;
 if g.actor_id is distinct from p_actor or private.can(p_team,'edit',p_actor) is not true or g.state<>'running' or g.lease_owner is distinct from p_owner or g.fence::text is distinct from p_fence or g.lease_expires_at<=clock_timestamp() then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 select * into c from private.launch_catalog_video_contexts where generation_id=g.id and team_id=p_team and actor_id=p_actor;
 if c.generation_id is null then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 return jsonb_build_object('executorId',c.executor_id,'settings',c.settings_snapshot,'requestPayload',c.request_payload);
end;
$$;
create function public.service_wait_launch_catalog_video(p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text) returns void language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;c private.launch_catalog_video_contexts%rowtype;s private.catalog_video_sets%rowtype;
begin
 perform public.service_read_launch_catalog_video_context(p_team,p_generation,p_actor,p_owner,p_fence);
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 select * into c from private.launch_catalog_video_contexts where generation_id=g.id;
 select * into s from private.catalog_video_sets where id=c.video_set_id;
 if s.id is null then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 update public.team_launch_generations set state=case when s.state='unknown' then 'interrupted' else 'accepted' end,stage='catalog_planning',
  safe_error_code=case when s.state='unknown' then 'PROCESS_RESULT_UNCERTAIN' else null end,retryable=false,
  lease_owner=null,lease_expires_at=clock_timestamp(),next_attempt_at=clock_timestamp()+interval '15 seconds',state_version=state_version+1,updated_at=clock_timestamp() where id=g.id;
 perform private.launch_signal(p_team,g.launch_id,(select aggregate_version from public.team_launches where id=g.launch_id));
end;
$$;
revoke all on function public.service_read_launch_catalog_video_context(uuid,uuid,uuid,text,text),public.service_wait_launch_catalog_video(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.service_read_launch_catalog_video_context(uuid,uuid,uuid,text,text),public.service_wait_launch_catalog_video(uuid,uuid,uuid,text,text) to service_role;

-- New protocol never starts a legacy browser-owned one-copy preparation.
alter function public.prepare_launch_restitch(uuid,uuid,uuid[]) rename to prepare_launch_restitch_before_video;
revoke all on function public.prepare_launch_restitch_before_video(uuid,uuid,uuid[]) from public,anon,authenticated,service_role;
create function public.prepare_launch_restitch(p_team uuid,p_generation uuid,p_exclude uuid[] default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform private.launch_access(p_team,'edit');
 if exists(select 1 from private.launch_catalog_video_contexts where generation_id=p_generation and team_id=p_team and actor_id=auth.uid()) then raise exception 'WRONG_STATE' using errcode='55000';end if;
 return public.prepare_launch_restitch_before_video(p_team,p_generation,p_exclude);
end;
$$;
revoke all on function public.prepare_launch_restitch(uuid,uuid,uuid[]) from public,anon;
grant execute on function public.prepare_launch_restitch(uuid,uuid,uuid[]) to authenticated;

-- Read-only projection avoids inverting the existing parent -> set lock order.
-- Registered child counts are authoritative receipts, not encoding percentages.
alter function public.get_launch(uuid,uuid,uuid) rename to get_launch_before_catalog_video;
revoke all on function public.get_launch_before_catalog_video(uuid,uuid,uuid) from public,anon,authenticated,service_role;
create function public.get_launch(p_team uuid,p_launch uuid,p_revision uuid default null) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;c private.launch_catalog_video_contexts%rowtype;s private.catalog_video_sets%rowtype;n integer;
begin
 result:=public.get_launch_before_catalog_video(p_team,p_launch,p_revision);
 if result#>>'{generation,id}' is not null and result#>>'{generation,stage}' in('accepted','preparing','catalog_planning') and result#>>'{generation,state}' not in('succeeded','canceled') then
  select * into c from private.launch_catalog_video_contexts where generation_id=(result#>>'{generation,id}')::uuid and team_id=p_team;
  if c.video_set_id is not null then
   select * into s from private.catalog_video_sets where id=c.video_set_id;
   select count(*)::integer into n from private.catalog_video_variants where video_set_id=s.id and state='registered';
   result:=jsonb_set(result,'{generation,progress}',jsonb_build_object('completed',n,'total',s.requested_count,'unit','videos','source','registered_video_variants'));
  end if;
 end if;
 return result;
end;
$$;
revoke all on function public.get_launch(uuid,uuid,uuid) from public,anon;
grant execute on function public.get_launch(uuid,uuid,uuid) to authenticated;

alter table private.launch_catalog_video_contexts add column cancel_command_id uuid not null default gen_random_uuid();
create function private.cancel_launch_catalog_video() returns trigger language plpgsql security definer set search_path='' as $$
declare c private.launch_catalog_video_contexts%rowtype;s private.catalog_video_sets%rowtype;i private.catalog_generation_intents%rowtype;
 policy private.catalog_video_publication_policies%rowtype;job private.catalog_video_publication_jobs%rowtype;held boolean:=true;
begin
 if new.state not in('cancel_requested','canceled_with_cleanup_pending','canceled') then return new;end if;
 select * into c from private.launch_catalog_video_contexts where generation_id=new.id and team_id=new.team_id;
 if c.generation_id is null then return new;end if;
 select * into i from private.catalog_generation_intents where id=c.catalog_intent_id;
 select * into s from private.catalog_video_sets where id=c.video_set_id for update;
 if s.state in('accepted','preparing','unknown') then
  update private.catalog_video_sets set state=case when exists(select 1 from private.catalog_video_variants where video_set_id=s.id and state in('working','unknown')) then 'cancel_requested' else 'canceled' end,revision=revision+1,updated_at=clock_timestamp() where id=s.id returning * into s;
 end if;
 if i.checkpoint->>'materialId' is not null then
  select * into policy from private.catalog_video_publication_policies where catalog_material_id=(i.checkpoint->>'materialId')::uuid and team_id=new.team_id;
  select * into job from private.catalog_video_publication_jobs where catalog_material_id=policy.catalog_material_id and revision=1 and command_id=i.id;
  -- A newer explicit schedule belongs to the user; only this generation's
  -- original, still-pending initial publication is eligible for the held CAS.
  if policy.revision=1 and policy.mode='scheduled' and job.id is not null and job.state not in('published','superseded','held') then
   begin
    perform public.service_save_catalog_publication(new.team_id,new.actor_id,c.cancel_command_id,policy.catalog_material_id,1,'held',null,null,private.catalog_publication_target_json(policy.target_id));
   exception when others then held:=false;end;
  end if;
 end if;
 if new.state='canceled' and (s.state='cancel_requested' or not held) then
  new.state:='canceled_with_cleanup_pending';new.stage:='cleanup';new.next_attempt_at:=clock_timestamp()+interval '15 seconds';new.lease_expires_at:=clock_timestamp();
 end if;
 return new;
end;
$$;
revoke all on function private.cancel_launch_catalog_video() from public,anon,authenticated,service_role;
create trigger launch_catalog_video_cancel before update of state on public.team_launch_generations for each row execute function private.cancel_launch_catalog_video();

-- Legacy cleanup may settle the catalog while native join is still pending.
-- Return the actual fenced parent state rather than claiming its requested state.
alter function public.service_finish_launch_cleanup(uuid,uuid,uuid,text,text,text) rename to service_finish_launch_cleanup_before_video;
revoke all on function public.service_finish_launch_cleanup_before_video(uuid,uuid,uuid,text,text,text) from public,anon,authenticated,service_role;
create function public.service_finish_launch_cleanup(p_team uuid,p_generation uuid,p_owner uuid,p_fence text,p_intent_fence text,p_cleaned_file text default null) returns text language plpgsql security definer set search_path='' as $$
declare result text;
begin
 result:=public.service_finish_launch_cleanup_before_video(p_team,p_generation,p_owner,p_fence,p_intent_fence,p_cleaned_file);
 if exists(select 1 from private.launch_catalog_video_contexts where generation_id=p_generation and team_id=p_team) then select state into result from public.team_launch_generations where id=p_generation and team_id=p_team;end if;
 return result;
end;
$$;
revoke all on function public.service_finish_launch_cleanup(uuid,uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.service_finish_launch_cleanup(uuid,uuid,uuid,text,text,text) to service_role;

create or replace function public.service_list_launch_catalog_recovery(p_limit integer default 3) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if p_limit is null or p_limit not between 1 and 10 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('teamId',x.team_id,'generationId',x.id,'actorId',x.actor_id)) from (
  select g.id,g.team_id,g.actor_id from public.team_launch_generations g
  join public.team_launch_revisions r on r.id=g.revision_id
  join public.team_launches l on l.id=g.launch_id and l.archived_at is null
  where r.config->>'method'='catalog' and (r.config->'catalog'->>'catalogVideoProtocolVersion'='1' or r.config->'catalog'->>'restitchEnabled'='false' or private.launch_reusable_restitch(g.team_id,g.id) is not null or exists(select 1 from private.launch_restitch_preparations p join public.team_operations o on o.id=p.operation_id where p.generation_id=g.id and o.state='succeeded' and o.result_material_id is not null))
   and private.can(g.team_id,'edit',g.actor_id)
   and g.state in('accepted','running','interrupted')
   and (g.next_attempt_at is null or g.next_attempt_at<=clock_timestamp())
   and (g.lease_expires_at is null or g.lease_expires_at<=clock_timestamp())
   and (g.safe_error_code is null or g.safe_error_code in('DRIVE_UNAVAILABLE','RATE_LIMITED','LAUNCH_INTERNAL_ERROR','LAUNCH_RESULT_UNCERTAIN','GROUP_RECONCILING','LEASE_MISMATCH','UNKNOWN') or (r.config->'catalog'->>'catalogVideoProtocolVersion'='1' and g.safe_error_code='PROCESS_RESULT_UNCERTAIN'))
   and not exists(select 1 from private.catalog_generation_intents i where i.team_id=g.team_id
    and i.request_key='launch:'||g.id::text||':catalog' and i.lease_expires_at>clock_timestamp())
  order by coalesce(g.next_attempt_at,g.created_at),g.id limit p_limit
 ) x),'[]');
end $$;

-- Keep catalog-name binding and original-video profile wrappers intact; only the
-- inner registered-output proof distinguishes the new multi-video protocol.
alter function public.service_attach_launch_catalog_before_catalog_sub(uuid,uuid,uuid,text,text) rename to service_attach_launch_catalog_legacy_inner;
revoke all on function public.service_attach_launch_catalog_legacy_inner(uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;
create function public.service_attach_launch_catalog_before_catalog_sub(p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text) returns void language plpgsql security definer set search_path='' as $$
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
 if x.video_set_id is not null and not exists(select 1 from private.catalog_video_sets s where s.id=x.video_set_id and s.catalog_intent_id=i.id and s.state='ready' and s.requested_count=(x.initial_video_plan#>>'{preferences,videoVariationCount}')::integer and not exists(select 1 from private.catalog_video_variants v where v.video_set_id=s.id and v.state<>'registered')) then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 insert into public.team_launch_revision_catalogs(team_id,revision_id,catalog_id,material_id,variant,name_snapshot,sheet_url,settings_snapshot)
 values(p_team,r.id,c.material_id,c.material_id,coalesce(c.variant,1),m.name,c.sheet_url,c.settings_snapshot||jsonb_build_object('_launchCatalogVideoProtocol',1,'_launchVideoSetId',x.video_set_id)) on conflict(revision_id) do nothing;
 update public.team_launch_generation_steps set state='succeeded',team_operation_id=i.operation_id,result_material_id=c.material_id,reserved_variant=i.variant,provider_intent_key=i.id::text,provider_file_id=m.drive_file_id,updated_at=clock_timestamp() where generation_id=g.id and stage='catalog_registering';
end;
$$;
revoke all on function public.service_attach_launch_catalog_before_catalog_sub(uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;

alter function public.service_reuse_launch_catalog(uuid,uuid,uuid,text,text) rename to service_reuse_launch_catalog_before_video;
revoke all on function public.service_reuse_launch_catalog_before_video(uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;
create function public.service_reuse_launch_catalog(p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text) returns boolean language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from private.launch_catalog_video_contexts where generation_id=p_generation and team_id=p_team) then return false;end if;
 return public.service_reuse_launch_catalog_before_video(p_team,p_generation,p_actor,p_owner,p_fence);
end;
$$;
revoke all on function public.service_reuse_launch_catalog(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.service_reuse_launch_catalog(uuid,uuid,uuid,text,text) to service_role;

alter function public.get_launch_restitch_reuse(uuid,uuid) rename to get_launch_restitch_reuse_before_video;
revoke all on function public.get_launch_restitch_reuse_before_video(uuid,uuid) from public,anon,authenticated,service_role;
create function public.get_launch_restitch_reuse(p_team uuid,p_generation uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform private.launch_access(p_team,'edit');
 if exists(select 1 from private.launch_catalog_video_contexts where generation_id=p_generation and team_id=p_team and actor_id=auth.uid()) then return null;end if;
 return public.get_launch_restitch_reuse_before_video(p_team,p_generation);
end;
$$;
revoke all on function public.get_launch_restitch_reuse(uuid,uuid) from public,anon;
grant execute on function public.get_launch_restitch_reuse(uuid,uuid) to authenticated;

alter function public.bind_launch_restitch(uuid,uuid,uuid) rename to bind_launch_restitch_before_video;
revoke all on function public.bind_launch_restitch_before_video(uuid,uuid,uuid) from public,anon,authenticated,service_role;
create function public.bind_launch_restitch(p_team uuid,p_generation uuid,p_operation uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 perform private.launch_access(p_team,'edit');
 if exists(select 1 from private.launch_catalog_video_contexts where generation_id=p_generation and team_id=p_team and actor_id=auth.uid()) then raise exception 'WRONG_STATE' using errcode='55000';end if;
 perform public.bind_launch_restitch_before_video(p_team,p_generation,p_operation);
end;
$$;
revoke all on function public.bind_launch_restitch(uuid,uuid,uuid) from public,anon;
grant execute on function public.bind_launch_restitch(uuid,uuid,uuid) to authenticated;

alter function public.retry_launch_restitch(uuid,uuid,text) rename to retry_launch_restitch_before_video;
revoke all on function public.retry_launch_restitch_before_video(uuid,uuid,text) from public,anon,authenticated,service_role;
create function public.retry_launch_restitch(p_team uuid,p_generation uuid,p_key text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform private.launch_access(p_team,'edit');
 if exists(select 1 from private.launch_catalog_video_contexts where generation_id=p_generation and team_id=p_team and actor_id=auth.uid()) then raise exception 'WRONG_STATE' using errcode='55000';end if;
 return public.retry_launch_restitch_before_video(p_team,p_generation,p_key);
end;
$$;
revoke all on function public.retry_launch_restitch(uuid,uuid,text) from public,anon;
grant execute on function public.retry_launch_restitch(uuid,uuid,text) to authenticated;

alter function public.service_launch_restitch_receipt(uuid,uuid,uuid,text,text) rename to service_launch_restitch_receipt_before_video;
revoke all on function public.service_launch_restitch_receipt_before_video(uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;
create function public.service_launch_restitch_receipt(p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from private.launch_catalog_video_contexts where generation_id=p_generation and team_id=p_team) then raise exception 'WRONG_STATE' using errcode='55000';end if;
 return public.service_launch_restitch_receipt_before_video(p_team,p_generation,p_actor,p_owner,p_fence);
end;
$$;
revoke all on function public.service_launch_restitch_receipt(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.service_launch_restitch_receipt(uuid,uuid,uuid,text,text) to service_role;
