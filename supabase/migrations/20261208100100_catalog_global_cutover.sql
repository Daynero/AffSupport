-- 052 global producers. Inactive policy preserves the existing private-image behavior.
create or replace function public.service_catalog_image_mode_v2(p_team uuid) returns text language sql stable security definer set search_path='' as $$
 select case when private.catalog_global_is_active() then 'global' else coalesce((select mode from private.catalog_image_config where team_id=p_team),'legacy') end
$$;

create function public.service_draw_product_catalog_images_v3(p_team uuid,p_count integer,p_attempt uuid,p_scope text default 'create',p_catalog uuid default null,p_pairs jsonb default '[]') returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid;catalog uuid:=coalesce(p_catalog,p_attempt);epoch bigint;response jsonb;
begin
 if not private.catalog_global_is_active() then return public.service_draw_product_catalog_images_v2(p_team,p_count,p_attempt,p_scope);end if;
 if p_attempt is null or catalog is null then raise exception 'GLOBAL_IMAGE_CLIENT_UPGRADE_REQUIRED';end if;
 if p_scope='create' then
  select actor_id into actor from private.catalog_generation_intents where id=p_attempt and team_id=p_team and state not in('canceled');
  if actor is null then select actor_id into actor from public.team_launch_generations where catalog_image_attempt_id=p_attempt and team_id=p_team and state in('accepted','running','waiting_dependency');end if;
 else
  -- Only a live canonical updater attempt may issue; the current owner is the background authority.
  select t.owner_id into actor from public.team_catalog_update_attempts a join public.team_catalog_updater_items u on u.catalog_material_id=a.catalog_material_id and u.round_due_at=a.round_due_at
   join public.teams t on t.id=u.team_id where a.attempt_id=p_attempt and a.catalog_material_id=p_catalog and u.team_id=p_team and a.result='running' and u.lease_expires_at>clock_timestamp();
 end if;
 if actor is null then raise exception 'PERMISSION_DENIED';end if;
 if p_scope<>'create' then select coalesce((select id from private.catalog_global_identities where material_id=p_catalog),p_catalog) into catalog;end if;
 perform public.service_catalog_global_identity(p_team,actor,catalog,catalog,case when p_scope<>'create' then p_catalog else null end);
 select p.epoch into epoch from private.catalog_global_policy p where singleton;
 response:=public.service_catalog_global_allocate(actor,p_team,catalog,p_attempt,p_count,epoch,p_scope,p_pairs);
 return response->'images';
end $$;
revoke all on function public.service_draw_product_catalog_images_v3(uuid,integer,uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.service_draw_product_catalog_images_v3(uuid,integer,uuid,text,uuid,jsonb) to service_role;

create function public.service_catalog_global_validate_rows(p_team uuid,p_images jsonb) returns void language plpgsql security definer set search_path='' as $$
declare image jsonb;cfg private.catalog_global_policy%rowtype;
begin
 select * into cfg from private.catalog_global_policy where singleton;
 if cfg.activated_at is null or jsonb_typeof(p_images) is distinct from 'array' or jsonb_array_length(p_images) not between 1 and 400 then raise exception 'GLOBAL_IMAGE_POLICY_CONFLICT';end if;
 if cfg.serving_revision is distinct from cfg.routing_revision or cfg.serving_verified_at is null or cfg.serving_verified_at<=clock_timestamp()-interval '120 seconds' then raise exception 'GLOBAL_IMAGE_READINESS_UNKNOWN';end if;
 for image in select value from jsonb_array_elements(p_images) loop
  if not exists(select 1 from private.catalog_global_assignments a join private.catalog_global_identities c on c.id=a.catalog_id
   join private.catalog_global_images i on i.id=a.image_id join private.catalog_global_aliases u on u.id=a.alias_id
   where a.id::text=image->>'assignmentId' and c.team_id=p_team and not c.closed and image=private.catalog_global_image_json(a.id,cfg.epoch)
   and i.state='ready' and i.active and i.content_expires_at>clock_timestamp() and i.content_proof_revision=cfg.routing_revision
   and u.state='ready' and u.key_version=any(cfg.accepted_key_versions)) then raise exception 'GLOBAL_IMAGE_READINESS_UNKNOWN';end if;
 end loop;
end $$;
revoke all on function public.service_catalog_global_validate_rows(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.service_catalog_global_validate_rows(uuid,jsonb) to service_role;

create function public.service_catalog_image_validate_uses_v3(p_team uuid,p_attempt uuid) returns void language plpgsql security definer set search_path='' as $$
declare r private.catalog_global_recipes%rowtype;
begin
 if exists(select 1 from private.catalog_global_recipes where intent_id=p_attempt) then
  for r in select * from private.catalog_global_recipes where intent_id=p_attempt loop
   perform public.service_catalog_global_validate_rows(p_team,r.images);
  end loop;
 else perform public.service_catalog_image_validate_uses_v2(p_team,p_attempt);end if;
end $$;
revoke all on function public.service_catalog_image_validate_uses_v3(uuid,uuid) from public,anon,authenticated;
grant execute on function public.service_catalog_image_validate_uses_v3(uuid,uuid) to service_role;

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
  if version not in(1,2,3) then raise exception 'CATALOG_IMAGE_UPGRADE_REQUIRED'; end if;
  return version;
end $$;

create or replace function public.service_begin_catalog_intent(
  p_team uuid,p_video uuid,p_actor uuid,p_key text,p_payload jsonb,p_owner uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from private.catalog_global_policy where state='draining') and not exists(select 1 from private.catalog_generation_intents where team_id=p_team and request_key=p_key and actor_id=p_actor) then raise exception 'GLOBAL_IMAGE_POLICY_CONFLICT';end if;
  if private.catalog_global_is_active() and coalesce(p_payload->>'catalogImageContractVersion','1')<>'3' and not exists(select 1 from private.catalog_generation_intents where team_id=p_team and video_material_id=p_video and actor_id=p_actor and request_key=p_key and state='registered') then raise exception 'GLOBAL_IMAGE_CLIENT_UPGRADE_REQUIRED';end if;
  -- Same lock as admission serializes mode transition and fresh-intent admission.
  perform pg_advisory_xact_lock(hashtextextended('catalog_image_mode:'||p_team::text,0));
  if exists(select 1 from private.catalog_image_config where team_id=p_team and mode='v2')
     and coalesce(p_payload->>'catalogImageContractVersion','1') not in('2','3')
     and private.catalog_image_accepted_launch_version(p_team,p_video,p_actor,p_key) is distinct from 1
     and not exists(select 1 from private.catalog_generation_intents
       where team_id=p_team and video_material_id=p_video and actor_id=p_actor and request_key=p_key) then
    raise exception 'CATALOG_IMAGE_UPGRADE_REQUIRED' using errcode='55000';
  end if;
  return private.catalog_image_begin_intent_legacy(p_team,p_video,p_actor,p_key,p_payload,p_owner);
end $$;

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
 if private.catalog_global_is_active() or g.catalog_image_contract_version=2 then
  images:=public.service_draw_product_catalog_images_v3(p_team,n,g.catalog_image_attempt_id,'create',g.catalog_image_attempt_id);
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
 if private.catalog_global_is_active() or r.request_payload->>'catalogImageContractVersion' in('2','3') then
  images:=public.service_draw_product_catalog_images_v3(p_team,n,r.id,'create',r.id);
  if images='[]'::jsonb then raise exception 'WRONG_STATE' using errcode='55000'; end if;
 end if;
 if images is null then
 select coalesce(jsonb_agg(jsonb_build_object('driveFileId',drive_file_id,'resourceKey',resource_key,'name',name)),'[]') into images from public.service_draw_product_catalog_images(p_team,n);
 end if;
 update private.catalog_generation_intents set checkpoint=checkpoint||jsonb_build_object('texts',texts,'images',images,'poolResourcesReady',true),state='planning',lease_expires_at=clock_timestamp()+interval '180 seconds',updated_at=clock_timestamp() where id=r.id;
 return jsonb_build_object('texts',texts,'images',images);
end $$;
create function public.service_catalog_global_bind_existing(p_team uuid,p_intent uuid,p_material uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from private.catalog_global_identities where id=p_intent and team_id=p_team and not closed) then
  perform public.service_catalog_global_bind(p_team,p_intent,p_material);
 end if;
end $$;
revoke all on function public.service_catalog_global_bind_existing(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.service_catalog_global_bind_existing(uuid,uuid,uuid) to service_role;

create function public.service_catalog_image_finalize_uses_v3(p_team uuid,p_attempt uuid,p_delivered boolean) returns void language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from private.catalog_global_recipes where intent_id=p_attempt) then
  if p_delivered then perform public.service_catalog_global_confirm(p_team,p_attempt,p_attempt);
  else update private.catalog_global_recipes r set state='unknown' where r.intent_id=p_attempt and r.state<>'confirmed' and exists(select 1 from private.catalog_global_identities c where c.id=r.catalog_id and c.team_id=p_team and not c.closed);end if;
 elsif private.catalog_global_is_active() and exists(select 1 from private.catalog_generation_intents where id=p_attempt and team_id=p_team and state='registered') then return;
 else perform public.service_catalog_image_finalize_uses_v2(p_team,p_attempt,p_delivered);
 end if;
end $$;
revoke all on function public.service_catalog_image_finalize_uses_v3(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.service_catalog_image_finalize_uses_v3(uuid,uuid,boolean) to service_role;

-- New clients omit retired fields; legacy mixed writes fail atomically before any field saves.

create or replace function public.set_team_product_catalog_settings(
  p_team uuid,
  p_settings jsonb
)
returns public.team_product_catalog_settings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_title text;
  v_description text;
  v_image_link text;
  v_min integer;
  v_max integer;
  saved public.team_product_catalog_settings;
  global_active boolean;
begin
  select activated_at is not null into global_active from private.catalog_global_policy where singleton for key share;
  if global_active and p_settings ? 'imageLink' then raise exception 'GLOBAL_IMAGE_SETTINGS_RETIRED';end if;
  if auth.uid() is null or not private.can(p_team, 'manage_metadata', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_settings is null
     or jsonb_typeof(p_settings) <> 'object'
     or (p_settings - array['title', 'description', 'price', 'imageLink', 'priceMin', 'priceMax'])
        <> '{}'::jsonb
     or jsonb_typeof(coalesce(p_settings -> 'title', '""'::jsonb)) not in ('string', 'null')
     or jsonb_typeof(coalesce(p_settings -> 'description', '""'::jsonb)) not in ('string', 'null')
     or jsonb_typeof(coalesce(p_settings -> 'imageLink', '""'::jsonb)) not in ('string', 'null') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  v_title := nullif(btrim(coalesce(p_settings ->> 'title', '')), '');
  v_description := nullif(btrim(coalesce(p_settings ->> 'description', '')), '');
  if global_active then select image_link into v_image_link from public.team_product_catalog_settings where team_id=p_team;
  else v_image_link := nullif(btrim(coalesce(p_settings ->> 'imageLink', '')), '');end if;
  -- An older client sends one price; it is a range of one. Numbers only: "10" as text is refused.
  if jsonb_typeof(p_settings -> 'priceMin') = 'number' and jsonb_typeof(p_settings -> 'priceMax') = 'number'
     and (p_settings ->> 'priceMin') ~ '^[0-9]{1,6}$' and (p_settings ->> 'priceMax') ~ '^[0-9]{1,6}$' then
    v_min := (p_settings ->> 'priceMin')::integer;
    v_max := (p_settings ->> 'priceMax')::integer;
  elsif jsonb_typeof(p_settings -> 'price') = 'number' and (p_settings ->> 'price') ~ '^[0-9]{1,6}$' then
    v_min := (p_settings ->> 'price')::integer;
    v_max := v_min;
  else
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  if (v_title is not null and char_length(v_title) > 200)
     or (v_description is not null and char_length(v_description) > 9999)
     or (v_image_link is not null
         and (v_image_link !~ '^https?://[^[:space:]]+$' or char_length(v_image_link) > 2048))
     or v_min not between 1 and 999999
     or v_max not between 1 and 999999
     or v_min > v_max then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  insert into public.team_product_catalog_settings as settings (
    team_id, title, description, price, price_min, price_max, image_link, updated_by, updated_at
  )
  values (
    p_team, v_title, v_description, v_min, v_min, v_max, v_image_link, auth.uid(),
    pg_catalog.clock_timestamp()
  )
  on conflict (team_id) do update
    set title = excluded.title,
        description = excluded.description,
        price = excluded.price,
        price_min = excluded.price_min,
        price_max = excluded.price_max,
        image_link = case when global_active then settings.image_link else excluded.image_link end,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
  returning * into saved;
  return saved;
end;
$$;
create function public.get_team_product_catalog_settings_v3(p_team uuid) returns setof public.team_product_catalog_settings
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.can(p_team,'view',auth.uid()) then raise exception 'PERMISSION_DENIED';end if;
 return query select (jsonb_populate_record(null::public.team_product_catalog_settings,to_jsonb(s)||case when private.catalog_global_is_active() then '{"image_link":null}'::jsonb else '{}'::jsonb end)).*
 from public.team_product_catalog_settings s where s.team_id=p_team;
end $$;
revoke all on function public.get_team_product_catalog_settings_v3(uuid) from public,anon;
grant execute on function public.get_team_product_catalog_settings_v3(uuid) to authenticated;

create function private.catalog_global_retired() returns boolean language sql stable security definer set search_path='' as $$
 select state<>'prepared' from private.catalog_global_policy where singleton
$$;
revoke all on function private.catalog_global_retired() from public,anon,authenticated,service_role;

create function private.catalog_global_assert_legacy_settings() returns void language plpgsql security definer set search_path='' as $$
declare policy_state text;
begin
 select state into policy_state from private.catalog_global_policy where singleton for key share;
 if policy_state<>'prepared' then raise exception 'GLOBAL_IMAGE_SETTINGS_RETIRED';end if;
end $$;
revoke all on function private.catalog_global_assert_legacy_settings() from public,anon,authenticated,service_role;

-- Guard existing entry points without renaming/dropping their signatures or broadening045 acceptance.
do $guard$
declare name text; definition text; marker text;
begin
 foreach name in array array[
  'public.get_team_product_catalog_settings(uuid)',
  'public.list_team_product_catalog_image_sources(uuid)',
  'public.set_team_product_catalog_image_sources(uuid,jsonb)',
  'public.list_team_product_catalog_pool_names(uuid)',
  'public.get_team_catalog_updater_refresh_images(uuid)',
  'public.set_team_catalog_updater_refresh_images(uuid,boolean)',
  'public.set_team_catalog_updater_refresh_images_as_actor(uuid,boolean,uuid)',
  'public.service_catalog_image_control_v2(text,uuid,jsonb)'
 ] loop
  if to_regprocedure(name) is null then continue;end if;
  definition:=pg_get_functiondef(to_regprocedure(name));
  if position('BEGIN' in definition)>0 then marker:='BEGIN';elsif position('begin' in definition)>0 then marker:='begin';else continue;end if;
  definition:=overlay(definition placing marker||E'\n perform private.catalog_global_assert_legacy_settings();\n' from position(marker in definition) for length(marker));
  execute definition;
 end loop;
end $guard$;
-- A durable, environment-wide preparation barrier. Applying this function never calls it.
create function public.service_catalog_global_cutover(p_actor uuid,p_action text,p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare c private.catalog_global_policy%rowtype;digest text;remaining bigint;epoch_no bigint;t0 timestamptz;
begin
 if not private.catalog_global_operator(p_actor) then raise exception 'PERMISSION_DENIED';end if;
 perform pg_advisory_xact_lock(hashtextextended('catalog-global-cutover',520));
 select * into c from private.catalog_global_policy where singleton for update;
 if p_action='status' then return jsonb_build_object('state',c.state,'epoch',c.epoch,'activatedAt',c.activated_at,'deleteAfter',c.delete_after,'manifestDigest',c.manifest_digest);end if;
 if c.activated_at is not null then
  if p_action='activate' and p_payload->>'manifestDigest'=c.manifest_digest then return jsonb_build_object('state',c.state,'epoch',c.epoch,'activatedAt',c.activated_at,'deleteAfter',c.delete_after);end if;
  raise exception 'GLOBAL_IMAGE_POLICY_CONFLICT';
 end if;
 if c.environment is null or c.media_origin is null then raise exception 'GLOBAL_IMAGE_READINESS_UNKNOWN';end if;
 if p_action='resume_legacy' then
  if p_payload->>'confirmation' is distinct from 'resume-legacy:'||c.environment then raise exception 'GLOBAL_IMAGE_POLICY_CONFLICT';end if;
  delete from private.catalog_image_retirements where epoch=c.epoch+1 and delete_after is null;
  update private.catalog_global_policy set state='prepared',manifest_digest=null where singleton;
  return jsonb_build_object('state','prepared','activation',false);
 end if;
 if p_action='prepare' then
  update private.catalog_global_policy set state='draining' where singleton;
  -- A bounded page; repeated prepare calls capture the full manifest behind the barrier.
  epoch_no:=c.epoch+1;
  insert into private.catalog_image_retirements(epoch,kind,publication_id,team_scope,object_key,bucket_kind,ledger_id,original_owner_scope)
   select epoch_no,'object_purge',p.id,p.team_id,p.object_key,'public',s.publication_id,s.owner_scope
   from private.catalog_image_publications p left join private.catalog_image_storage s on s.publication_id=p.id
   where p.object_key ~ '^v1/[a-f0-9-]{36}$' and p.state<>'revoked'
    and not exists(select 1 from private.catalog_image_retirements r where r.epoch=epoch_no and r.object_key=p.object_key)
   order by p.id limit 200 on conflict do nothing;
  -- Team deletion removes publication rows but deliberately keeps managed purge/ledger identity.
  insert into private.catalog_image_retirements(epoch,kind,publication_id,team_scope,object_key,bucket_kind,ledger_id,original_owner_scope)
   select epoch_no,'object_purge',q.publication_id,q.scope_id,q.object_key,'public',s.publication_id,s.owner_scope
   from private.catalog_image_purges q left join private.catalog_image_storage s on s.publication_id=q.publication_id and s.object_key=q.object_key
   where q.bucket_kind='public' and q.state<>'complete' and q.publication_id is not null and q.object_key ~ '^v1/[a-f0-9-]{36}$'
    and not exists(select 1 from private.catalog_image_retirements r where r.epoch=epoch_no and r.object_key=q.object_key)
   order by q.id limit 200 on conflict do nothing;
  insert into private.catalog_image_retirements(epoch,kind,team_scope,metadata_kind)
   select epoch_no,'metadata_unlink',t.id,'legacy_image_settings' from public.teams t
   where (exists(select 1 from public.team_product_catalog_settings where team_id=t.id and image_link is not null)
    or exists(select 1 from public.team_product_catalog_image_sources where team_id=t.id))
    and not exists(select 1 from private.catalog_image_retirements r where r.epoch=epoch_no and r.team_scope=t.id and r.metadata_kind='legacy_image_settings')
   order by t.id limit 200 on conflict do nothing;
  select count(*) into remaining from private.catalog_image_publications p where p.state<>'revoked' and not exists(select 1 from private.catalog_image_retirements r where r.epoch=epoch_no and r.publication_id=p.id);
  remaining:=remaining+(select count(*) from private.catalog_image_purges q where q.bucket_kind='public' and q.state<>'complete' and not exists(select 1 from private.catalog_image_retirements r where r.epoch=epoch_no and r.object_key=q.object_key));
  remaining:=remaining+(select count(*) from public.teams t where (exists(select 1 from public.team_product_catalog_settings where team_id=t.id and image_link is not null) or exists(select 1 from public.team_product_catalog_image_sources where team_id=t.id)) and not exists(select 1 from private.catalog_image_retirements r where r.epoch=epoch_no and r.team_scope=t.id and r.metadata_kind='legacy_image_settings'));
  select encode(extensions.digest(coalesce(string_agg((to_jsonb(r)-array['state','delete_after','verified_at','purge_id','code','next_attempt_at'])::text,',' order by id),''),'sha256'),'hex') into digest from private.catalog_image_retirements r where epoch=epoch_no;
  update private.catalog_global_policy set manifest_digest=digest where singleton;
  return jsonb_build_object('state','draining','remaining',remaining,'manifestDigest',digest);
 end if;
 if p_action<>'activate' or c.state<>'draining' or p_payload->>'manifestDigest' is distinct from c.manifest_digest then raise exception 'GLOBAL_IMAGE_POLICY_CONFLICT';end if;
 -- Only trusted release preparation can record this permit; the operator HTTP route cannot mint it.
 if not exists(select 1 from private.catalog_global_acceptance a where a.manifest_digest=c.manifest_digest and a.environment=c.environment and a.routing_revision=c.routing_revision and a.source_sha=p_payload->>'sourceSha' and a.expires_at>clock_timestamp()) then raise exception 'GLOBAL_IMAGE_POLICY_CONFLICT';end if;
 -- No implicit activation: exact target/source/config and both compatible release proofs are mandatory.
 if p_payload->>'confirmation' is distinct from 'activate:'||c.environment||':'||c.routing_revision||':'||c.manifest_digest
  or coalesce(p_payload->>'sourceSha','') !~ '^[a-f0-9]{40}$'
  or p_payload->'acceptance'->>'current' is distinct from 'verified'
  or p_payload->'acceptance'->>'rollback' is distinct from 'verified'
  or p_payload->'acceptance'->>'provider' is distinct from 'verified'
  or p_payload->'acceptance'->>'diagnostics' is distinct from 'verified'
  or p_payload->'acceptance'->>'performance' is distinct from 'verified' then raise exception 'GLOBAL_IMAGE_POLICY_CONFLICT';end if;
 if c.serving_revision is distinct from c.routing_revision or c.serving_verified_at is null or c.serving_verified_at<clock_timestamp()-interval '120 seconds'
  or not exists(select 1 from private.catalog_global_images where active and state='ready' and content_expires_at>clock_timestamp()) then raise exception 'GLOBAL_IMAGE_READINESS_UNKNOWN';end if;
 if exists(select 1 from private.catalog_image_import_entries where lease_until>clock_timestamp() or grant_expires_at>clock_timestamp() or state in('validating','deduplicating','publishing','verifying_origin','verifying_public','committing','awaiting_reconciliation'))
  or exists(select 1 from private.catalog_image_import_intents where lease_until>clock_timestamp())
  or exists(select 1 from private.catalog_image_purges where bucket_kind='public' and (lease_until>clock_timestamp() or state in('unknown','deleting','cache_purging')))
  or exists(select 1 from private.catalog_image_publications where uncertain_write or state not in('ready','revoked'))
  or exists(select 1 from private.catalog_generation_intents where state not in('registered','canceled'))
  or exists(select 1 from public.team_catalog_updater_items where lease_expires_at>clock_timestamp())
  or exists(select 1 from public.team_launch_generations g join public.team_launch_revisions r on r.id=g.revision_id where r.config->>'method'='catalog' and g.state in('accepted','running','waiting_dependency'))
  or exists(select 1 from private.catalog_image_publications p where p.state<>'revoked' and not exists(select 1 from private.catalog_image_retirements r where r.epoch=c.epoch+1 and r.publication_id=p.id))
  or exists(select 1 from private.catalog_image_purges q where q.bucket_kind='public' and q.state<>'complete' and not exists(select 1 from private.catalog_image_retirements r where r.epoch=c.epoch+1 and r.object_key=q.object_key))
 then raise exception 'GLOBAL_IMAGE_POLICY_CONFLICT';end if;
 t0:=clock_timestamp();
 update private.catalog_global_policy set epoch=epoch+1,state='active',activated_at=t0,delete_after=t0+interval '720 hours',source_sha=p_payload->>'sourceSha',release_evidence=p_payload->'acceptance' where singleton returning * into c;
 update private.catalog_image_retirements set delete_after=c.delete_after where epoch=c.epoch;
 update private.catalog_image_purges q set not_before=greatest(q.not_before,c.delete_after) from private.catalog_image_retirements r where r.epoch=c.epoch and r.kind='object_purge' and q.bucket_kind='public' and q.object_key=r.object_key;
 insert into private.catalog_global_journal(stage,counts) values('activated',jsonb_build_object('epoch',c.epoch));
 return jsonb_build_object('state',c.state,'epoch',c.epoch,'activatedAt',c.activated_at,'deleteAfter',c.delete_after);
end $$;
revoke all on function public.service_catalog_global_cutover(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.service_catalog_global_cutover(uuid,text,jsonb) to service_role;
-- Accepted Launch video payload and claim advertise the same active global contract.
do $launch$
declare definition text;old_source text;
begin
 definition:=pg_get_functiondef('public.service_claim_launch_generation(uuid,uuid,uuid,text)'::regprocedure);
 old_source:='return claimed||jsonb_build_object(''catalogImageContractVersion'',version);';
 if position(old_source in definition)=0 then raise exception '052 expected Launch image claim seam';end if;
 execute replace(definition,old_source,'return claimed||jsonb_build_object(''catalogImageContractVersion'',case when private.catalog_global_is_active() then 3 else version end);');
 definition:=pg_get_functiondef('public.service_accept_launch_catalog_video_generation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure);
 old_source:='if g.catalog_image_contract_version=2 then payload:=payload||jsonb_build_object(''catalogImageContractVersion'',2);end if;';
 if position(old_source in definition)=0 then raise exception '052 expected Launch video payload seam';end if;
 execute replace(definition,old_source,'if private.catalog_global_is_active() then payload:=payload||jsonb_build_object(''catalogImageContractVersion'',3);elsif g.catalog_image_contract_version=2 then payload:=payload||jsonb_build_object(''catalogImageContractVersion'',2);end if;');
 definition:=pg_get_functiondef('private.claim_catalog_updater_items(text,integer,integer)'::regprocedure);
 if position('begin' in definition)=0 then raise exception '052 expected updater claim seam';end if;
 execute overlay(definition placing E'begin\n if exists(select 1 from private.catalog_global_policy where state=''draining'') then return;end if;' from position('begin' in definition) for 5);
end $launch$;

-- Positive canonical completion/reconciliation is also an accounting recovery seam.
create function private.catalog_global_attempt_completed() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.result in('failed','cancelled','unknown') and new.result is distinct from old.result then update private.catalog_global_recipes set state=new.result where intent_id=new.attempt_id and state<>'confirmed';end if;
 if new.result='success' and old.result is distinct from 'success' and exists(select 1 from private.catalog_global_recipes where intent_id=new.attempt_id) then
  perform public.service_catalog_global_confirm(new.team_id,new.attempt_id,new.attempt_id);
 end if;
 return new;
end $$;
create function private.catalog_global_catalog_registered() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.state='canceled' and old.state is distinct from 'canceled' then update private.catalog_global_recipes set state='cancelled' where intent_id=new.id and state<>'confirmed';end if;
 if new.state='registered' and exists(select 1 from private.catalog_global_recipes where intent_id=new.id) then
  perform public.service_catalog_global_bind_existing(new.team_id,new.id,(new.result#>>'{catalog,materialId}')::uuid);
  perform public.service_catalog_global_confirm(new.team_id,new.id,new.id);
 end if;
 return new;
end $$;
revoke all on function private.catalog_global_attempt_completed(),private.catalog_global_catalog_registered() from public,anon,authenticated,service_role;
create trigger catalog_global_attempt_completed after update of result on public.team_catalog_update_attempts for each row execute function private.catalog_global_attempt_completed();
create trigger catalog_global_catalog_registered after update of state on private.catalog_generation_intents for each row execute function private.catalog_global_catalog_registered();

-- The profile patch remains atomic across bulk/undo and unrelated fields.
do $profile$
declare definition text;
begin
 definition:=pg_get_functiondef('public.patch_team_catalog_update_profile(uuid,uuid,bigint,jsonb)'::regprocedure);
 if position('begin' in definition)=0 then raise exception '052 expected profile patch seam';end if;
 execute overlay(definition placing E'begin\n if private.catalog_global_retired() and p_patch ? ''refreshImages'' then raise exception ''GLOBAL_IMAGE_SETTINGS_RETIRED'';end if;' from position('begin' in definition) for 5);
end $profile$;
create function private.catalog_global_invalidate_ui() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.state is distinct from old.state then
  insert into public.team_catalog_image_storage_signals(team_id) select id from public.teams order by id
   on conflict(team_id) do update set revision=team_catalog_image_storage_signals.revision+1,updated_at=clock_timestamp();
 end if;
 return new;
end $$;
revoke all on function private.catalog_global_invalidate_ui() from public,anon,authenticated,service_role;
create trigger catalog_global_invalidate_ui after update of state on private.catalog_global_policy for each row execute function private.catalog_global_invalidate_ui();
-- Direct table reads obey the same retirement boundary as RPCs. New settings reads usev3.
create function public.catalog_global_policy_active() returns boolean language sql stable security definer set search_path='' as $$
 select private.catalog_global_is_active()
$$;
revoke all on function public.catalog_global_policy_active() from public,anon,service_role;
grant execute on function public.catalog_global_policy_active() to authenticated;
create policy catalog_global_retired_pool_read on public.team_catalog_image_pool_entries as restrictive for select to authenticated using(not public.catalog_global_policy_active());
create policy catalog_global_retired_import_read on public.team_catalog_image_imports as restrictive for select to authenticated using(not public.catalog_global_policy_active());
create policy catalog_global_retired_source_read on public.team_product_catalog_image_sources as restrictive for select to authenticated using(not public.catalog_global_policy_active());
create policy catalog_global_retired_settings_read on public.team_product_catalog_settings as restrictive for select to authenticated using(not public.catalog_global_policy_active());

-- Global Launch identity depends on text/price/policy, never retired source rows or pool cursors.
create or replace function private.launch_catalog_settings_version(p_team uuid) returns text language sql stable security definer set search_path='' as $$
 select encode(extensions.digest(case when private.catalog_global_is_active() then jsonb_build_object(
  'settings',(select jsonb_build_object('title',s.title,'description',s.description,'priceMin',coalesce(s.price_min,s.price),'priceMax',coalesce(s.price_max,s.price)) from public.team_product_catalog_settings s where s.team_id=p_team),
  'texts',(select coalesce(jsonb_agg(jsonb_build_array(t.id,t.title,t.description,t.updated_at) order by t.position,t.id),'[]') from public.team_product_catalog_texts t where t.team_id=p_team),
  'globalEpoch',(select epoch from private.catalog_global_policy where singleton))::text
 else jsonb_build_object(
  'settings',(select to_jsonb(s)-'updated_by'-'created_at' from public.team_product_catalog_settings s where s.team_id=p_team),
  'texts',(select coalesce(jsonb_agg(jsonb_build_array(t.id,t.title,t.description,t.updated_at) order by t.position,t.id),'[]') from public.team_product_catalog_texts t where t.team_id=p_team),
  'images',(select coalesce(jsonb_agg(jsonb_build_array(i.material_id,i.drive_file_id,i.resource_key,coalesce(m.checksum,m.drive_version),i.name,m.lifecycle) order by i.material_id),'[]') from private.product_catalog_pool_images(p_team) i join public.team_materials m on m.id=i.material_id and m.team_id=p_team))::text end,'sha256'),'hex')
$$;
revoke all on function private.launch_catalog_settings_version(uuid) from public,anon,authenticated,service_role;
