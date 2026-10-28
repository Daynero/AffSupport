-- 045: freeze image inputs before Launch restitch using the future catalog intent identity.
-- Existing accepted generations remain v1; only later acceptance uses the v2 contract.
alter table public.team_launch_generations
 add column catalog_image_contract_version integer not null default 1 check(catalog_image_contract_version in (1,2)),
 add column catalog_image_attempt_id uuid not null default gen_random_uuid();
alter table public.team_launch_generations alter column catalog_image_contract_version set default 2;
create unique index team_launch_catalog_image_attempt_identity on public.team_launch_generations(catalog_image_attempt_id);
revoke select(catalog_image_contract_version,catalog_image_attempt_id),insert(catalog_image_contract_version,catalog_image_attempt_id),update(catalog_image_contract_version,catalog_image_attempt_id)
 on public.team_launch_generations from public,anon,authenticated;

create function private.catalog_image_launch_contract_immutable() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.catalog_image_contract_version is distinct from old.catalog_image_contract_version or new.catalog_image_attempt_id is distinct from old.catalog_image_attempt_id then raise exception 'WRONG_STATE'; end if;
 return new;
end $$;
create trigger catalog_image_launch_contract_immutable before update of catalog_image_contract_version,catalog_image_attempt_id on public.team_launch_generations
 for each row execute function private.catalog_image_launch_contract_immutable();
revoke all on function private.catalog_image_launch_contract_immutable() from public,anon,authenticated,service_role;

alter function public.service_claim_launch_generation(uuid,uuid,uuid,text) set schema private;
alter function private.service_claim_launch_generation(uuid,uuid,uuid,text) rename to catalog_image_claim_launch_v1;
revoke all on function private.catalog_image_claim_launch_v1(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
create function public.service_claim_launch_generation(p_team uuid,p_generation uuid,p_actor uuid,p_owner text) returns jsonb language plpgsql security definer set search_path='' as $$
declare claimed jsonb; version integer;
begin
 claimed:=private.catalog_image_claim_launch_v1(p_team,p_generation,p_actor,p_owner);
 select catalog_image_contract_version into version from public.team_launch_generations where id=p_generation and team_id=p_team and actor_id=p_actor;
 if version is null then raise exception 'INVALID_RESPONSE'; end if;
 return claimed||jsonb_build_object('catalogImageContractVersion',version);
end $$;
revoke all on function public.service_claim_launch_generation(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.service_claim_launch_generation(uuid,uuid,uuid,text) to service_role;


create function private.catalog_image_accepted_launch_version(p_team uuid,p_video uuid,p_actor uuid,p_key text) returns integer language plpgsql stable security definer set search_path='' as $$
declare version integer;
begin
 if p_key !~ '^launch:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:catalog$' then return null; end if;
 select g.catalog_image_contract_version into version from public.team_launch_generations g
  join public.team_launch_revisions r on r.id=g.revision_id and r.team_id=g.team_id
  where g.id=split_part(p_key,':',2)::uuid and g.team_id=p_team and g.actor_id=p_actor
   and r.config->>'materialId'=p_video::text;
 return version;
end $$;
revoke all on function private.catalog_image_accepted_launch_version(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
create or replace function public.service_catalog_image_request_version_v2(
  p_team uuid, p_video uuid, p_actor uuid, p_key text
) returns integer language plpgsql security definer set search_path='' as $$
declare existing private.catalog_generation_intents%rowtype; version integer;
begin
  if p_actor is null or not private.can(p_team,'view',p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode='42501';
  end if;
  select * into existing from private.catalog_generation_intents
    where team_id=p_team and video_material_id=p_video and actor_id=p_actor and request_key=p_key;
  if not found then return private.catalog_image_accepted_launch_version(p_team,p_video,p_actor,p_key); end if;
  version:=coalesce((existing.request_payload->>'catalogImageContractVersion')::integer,1);
  if version not in(1,2) then raise exception 'CATALOG_IMAGE_UPGRADE_REQUIRED'; end if;
  return version;
end $$;
revoke all on function public.service_catalog_image_request_version_v2(uuid,uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function public.service_catalog_image_request_version_v2(uuid,uuid,uuid,text)
  to service_role;

create or replace function private.catalog_image_begin_intent_legacy(p_team uuid,p_video uuid,p_actor uuid,p_key text,p_payload jsonb,p_owner uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.catalog_generation_intents%rowtype;d text;v integer;replaces uuid;reserved uuid;
begin
 if p_actor is null or not private.can(p_team,'view',p_actor) or not private.can(p_team,'upload',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if p_key is null or p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' or p_owner is null or p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>32768 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_team::text||'catalog-key'||p_key,0));
 d:=encode(extensions.digest(p_payload::text,'sha256'),'hex');
 select * into r from private.catalog_generation_intents where team_id=p_team and request_key=p_key for update;
 if found then
  if r.actor_id<>p_actor or r.video_material_id<>p_video or r.request_digest<>d then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='40001';end if;
  if r.state='registered' then return jsonb_build_object('id',r.id,'variant',r.variant,'state',r.state,'fence',r.fence::text,'attempt',r.attempt,'checkpoint',r.checkpoint,'result',r.result,'operationId',r.operation_id);end if;
  if r.state='canceled' then raise exception 'WRONG_STATE' using errcode='55000';end if;
  if r.lease_expires_at>clock_timestamp() and r.lease_owner<>p_owner then raise exception 'GROUP_RECONCILING' using errcode='55000';end if;
  update private.catalog_generation_intents set lease_owner=p_owner,lease_expires_at=clock_timestamp()+interval '180 seconds',fence=fence+1,updated_at=clock_timestamp() where id=r.id returning * into r;
 else
  if not exists(select 1 from public.team_materials where team_id=p_team and id=p_video and category='video' and lifecycle='active') then raise exception 'NOT_FOUND' using errcode='P0002';end if;
  replaces:=nullif(p_payload->>'replacesMaterialId','')::uuid;
  if replaces is not null and exists(select 1 from public.team_launch_revision_catalogs where team_id=p_team and material_id=replaces) then raise exception 'WRONG_STATE' using errcode='55000';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_team::text||'catalog-variant'||p_video::text,0));
  if replaces is not null then select variant into v from public.team_product_catalogs where team_id=p_team and video_material_id=p_video and material_id=replaces;
  else select coalesce(max(variant),0)+1 into v from (select coalesce(variant,1) variant from public.team_product_catalogs where team_id=p_team and video_material_id=p_video union all select variant from private.catalog_generation_intents where team_id=p_team and video_material_id=p_video and replaces_material_id is null) variants;end if;
  if v is null then raise exception 'NOT_FOUND' using errcode='P0002';end if;
  if p_key ~ '^launch:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:catalog$' then
   select g.catalog_image_attempt_id into reserved from public.team_launch_generations g
    join public.team_launch_revisions lr on lr.id=g.revision_id and lr.team_id=g.team_id
    where g.id=split_part(p_key,':',2)::uuid and g.team_id=p_team and g.actor_id=p_actor
     and lr.config->>'materialId'=p_video::text;
  end if;
  insert into private.catalog_generation_intents(id,team_id,video_material_id,actor_id,request_key,request_digest,request_payload,variant,replaces_material_id,lease_owner,lease_expires_at)
  values(coalesce(reserved,gen_random_uuid()),p_team,p_video,p_actor,p_key,d,p_payload,v,replaces,p_owner,clock_timestamp()+interval '180 seconds') returning * into r;
 end if;
 return jsonb_build_object('id',r.id,'variant',r.variant,'state',r.state,'fence',r.fence::text,'attempt',r.attempt,'checkpoint',r.checkpoint,'result',r.result,'operationId',r.operation_id);
end $$;
create or replace function public.service_begin_catalog_intent(
  p_team uuid,p_video uuid,p_actor uuid,p_key text,p_payload jsonb,p_owner uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  -- Same lock as admission serializes mode transition and fresh-intent admission.
  perform pg_advisory_xact_lock(hashtextextended('catalog_image_mode:'||p_team::text,0));
  if exists(select 1 from private.catalog_image_config where team_id=p_team and mode='v2')
     and coalesce(p_payload->>'catalogImageContractVersion','1')<>'2'
     and private.catalog_image_accepted_launch_version(p_team,p_video,p_actor,p_key) is distinct from 1
     and not exists(select 1 from private.catalog_generation_intents
       where team_id=p_team and video_material_id=p_video and actor_id=p_actor and request_key=p_key) then
    raise exception 'CATALOG_IMAGE_UPGRADE_REQUIRED' using errcode='55000';
  end if;
  return private.catalog_image_begin_intent_legacy(p_team,p_video,p_actor,p_key,p_payload,p_owner);
end $$;
revoke all on function public.service_begin_catalog_intent(uuid,uuid,uuid,text,jsonb,uuid)
  from public,anon,authenticated;
grant execute on function public.service_begin_catalog_intent(uuid,uuid,uuid,text,jsonb,uuid) to service_role;

create or replace function private.freeze_launch_catalog_resources(p_team uuid,p_generation uuid,p_actor uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare l public.team_launches%rowtype;g public.team_launch_generations%rowtype;r public.team_launch_revisions%rowtype;
 frozen jsonb;settings jsonb;texts jsonb;images jsonb;expected text;actual text;n integer;
begin
 select * into l from public.team_launches where team_id=p_team and id=(select launch_id from public.team_launch_generations where id=p_generation and team_id=p_team) for update;
 select * into g from public.team_launch_generations where team_id=p_team and id=p_generation for update;
 if l.id is null or g.id is null or l.archived_at is not null or g.actor_id is distinct from p_actor or not private.can(p_team,'edit',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if g.state not in('accepted','running','waiting_dependency') then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into r from public.team_launch_revisions where id=g.revision_id and team_id=p_team;
 if r.config->>'method'<>'catalog' then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select checkpoint into frozen from public.team_launch_generation_steps where generation_id=g.id and stable_step_key='catalog_resources' and state='succeeded';
 if found then return frozen;end if;
 expected:=r.sources->>'catalogSettingsVersion';
 select jsonb_build_object('title',s.title,'description',s.description,'imageLink',s.image_link,'priceMin',coalesce(s.price_min,s.price),'priceMax',coalesce(s.price_max,s.price)),private.launch_catalog_settings_version(p_team)
  into settings,actual from public.team_product_catalog_settings s where s.team_id=p_team;
 if settings is null or expected is null or actual is distinct from expected then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 n:=(r.config->'catalog'->>'productCount')::integer;
 if n not between 1 and 400 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select coalesce(jsonb_agg(jsonb_build_object('title',title,'description',description)),'[]') into texts from public.service_draw_product_catalog_texts(p_team,n);
 if g.catalog_image_contract_version=2 then
  images:=public.service_draw_product_catalog_images_v2(p_team,n,g.catalog_image_attempt_id,'create');
  if images='[]'::jsonb then raise exception 'WRONG_STATE' using errcode='55000'; end if;
 end if;
 if images is null then
 select coalesce(jsonb_agg(jsonb_build_object('driveFileId',drive_file_id,'resourceKey',resource_key,'name',name)),'[]') into images from public.service_draw_product_catalog_images(p_team,n);
 end if;
 if private.launch_catalog_settings_version(p_team) is distinct from expected then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 frozen:=jsonb_build_object('settings',settings,'settingsVersion',expected,'texts',texts,'images',images,'poolResourcesReady',true);
 insert into public.team_launch_generation_steps(team_id,generation_id,stage,stable_step_key,state,input_signature,checkpoint,fence)
  values(p_team,g.id,'catalog_planning','catalog_resources','succeeded',expected,frozen,g.fence);
 return frozen;
end $$;
create or replace function public.service_plan_catalog_resources(p_team uuid,p_intent uuid,p_actor uuid,p_owner uuid,p_fence text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.catalog_generation_intents%rowtype;parent public.team_launch_generations%rowtype;launch public.team_launches%rowtype;revision public.team_launch_revisions%rowtype;frozen jsonb;texts jsonb;images jsonb;n integer;
begin
 -- Launch locks precede the child lock, matching cancellation and recovery.
 select * into r from private.catalog_generation_intents where team_id=p_team and id=p_intent;
 if r.request_key ~ '^launch:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:catalog$' then
  select * into launch from public.team_launches where team_id=p_team and id=(select launch_id from public.team_launch_generations where team_id=p_team and id=split_part(r.request_key,':',2)::uuid) for update;
  select * into parent from public.team_launch_generations where team_id=p_team and id=split_part(r.request_key,':',2)::uuid for update;
  if launch.id is null or launch.archived_at is not null or parent.id is null or parent.actor_id is distinct from p_actor or not private.can(p_team,'edit',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
  if parent.state not in ('accepted','running','waiting_dependency') then raise exception 'WRONG_STATE' using errcode='55000'; end if;
  select * into revision from public.team_launch_revisions where id=parent.revision_id and team_id=p_team;
  if parent.id is null or revision.config->>'materialId' is distinct from r.video_material_id::text
   or revision.generated_url is distinct from r.request_payload->>'sourceLink'
   or revision.config->'catalog'->'productCount' is distinct from r.request_payload->'productCount' then raise exception 'WRONG_STATE' using errcode='55000';end if;
  if r.checkpoint->>'poolResourcesReady'='true' then
   frozen:=jsonb_build_object('texts',r.checkpoint->'texts','images',r.checkpoint->'images');
  else
   frozen:=private.freeze_launch_catalog_resources(p_team,parent.id,p_actor);
  end if;
 end if;
 select * into r from private.catalog_generation_intents where team_id=p_team and id=p_intent for update;
 if r.id is null or p_actor is null or not private.can(p_team,'view',p_actor) or r.actor_id<>p_actor or r.lease_owner<>p_owner or r.fence::text<>p_fence or r.lease_expires_at<=clock_timestamp() or r.state in('registered','canceled') then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 if frozen is not null then
  update private.catalog_generation_intents set checkpoint=checkpoint||frozen,state='planning',lease_expires_at=clock_timestamp()+interval '180 seconds',updated_at=clock_timestamp() where id=r.id;
  return frozen;
 end if;
 if r.checkpoint->>'poolResourcesReady'='true' then return jsonb_build_object('texts',r.checkpoint->'texts','images',r.checkpoint->'images');end if;
 n:=(r.request_payload->>'productCount')::integer;if n not between 1 and 400 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select coalesce(jsonb_agg(jsonb_build_object('title',title,'description',description)),'[]') into texts from public.service_draw_product_catalog_texts(p_team,n);
 if r.request_payload->>'catalogImageContractVersion'='2' then
  images:=public.service_draw_product_catalog_images_v2(p_team,n,r.id,'create');
  if images='[]'::jsonb then raise exception 'WRONG_STATE' using errcode='55000'; end if;
 end if;
 if images is null then
 select coalesce(jsonb_agg(jsonb_build_object('driveFileId',drive_file_id,'resourceKey',resource_key,'name',name)),'[]') into images from public.service_draw_product_catalog_images(p_team,n);
 end if;
 update private.catalog_generation_intents set checkpoint=checkpoint||jsonb_build_object('texts',texts,'images',images,'poolResourcesReady',true),state='planning',lease_expires_at=clock_timestamp()+interval '180 seconds',updated_at=clock_timestamp() where id=r.id;
 return jsonb_build_object('texts',texts,'images',images);
end $$;

revoke all on function public.service_plan_catalog_resources(uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.service_plan_catalog_resources(uuid,uuid,uuid,uuid,text) to service_role;
revoke all on function private.freeze_launch_catalog_resources(uuid,uuid,uuid),private.catalog_image_begin_intent_legacy(uuid,uuid,uuid,text,jsonb,uuid) from public,anon,authenticated,service_role;
