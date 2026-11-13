-- 055. Automatic content admission is server owned. Existing checkpoints remain legacy.
create or replace function private.launch_catalog_settings_version_legacy(p_team uuid) returns text language sql stable security definer set search_path='' as $$
 select encode(extensions.digest(case when private.catalog_global_is_active() then jsonb_build_object(
  'settings',(select jsonb_build_object('title',s.title,'description',s.description,'priceMin',coalesce(s.price_min,s.price),'priceMax',coalesce(s.price_max,s.price)) from public.team_product_catalog_settings s where s.team_id=p_team),
  'texts',(select coalesce(jsonb_agg(jsonb_build_array(t.id,t.title,t.description,t.updated_at) order by t.position,t.id),'[]') from public.team_product_catalog_texts t where t.team_id=p_team),
  'globalEpoch',(select epoch from private.catalog_global_policy where singleton))::text
 else jsonb_build_object(
  'settings',(select to_jsonb(s)-'updated_by'-'created_at' from public.team_product_catalog_settings s where s.team_id=p_team),
  'texts',(select coalesce(jsonb_agg(jsonb_build_array(t.id,t.title,t.description,t.updated_at) order by t.position,t.id),'[]') from public.team_product_catalog_texts t where t.team_id=p_team),
  'images',(select coalesce(jsonb_agg(jsonb_build_array(i.material_id,i.drive_file_id,i.resource_key,coalesce(m.checksum,m.drive_version),i.name,m.lifecycle) order by i.material_id),'[]') from private.product_catalog_pool_images(p_team) i join public.team_materials m on m.id=i.material_id and m.team_id=p_team))::text end,'sha256'),'hex')
$$;
revoke all on function private.launch_catalog_settings_version_legacy(uuid) from public,anon,authenticated,service_role;

create or replace function private.launch_catalog_settings_version(p_team uuid) returns text language sql stable security definer set search_path='' as $$
 select 'automatic-v1:'||encode(extensions.digest(jsonb_build_object(
  'contentPolicyVersion',1,
  'imageSource',case when private.catalog_global_is_active() then jsonb_build_object(
   'mode','global','epoch',(select epoch from private.catalog_global_policy where singleton),
   'routingRevision',(select routing_revision from private.catalog_global_policy where singleton))
  when exists(select 1 from private.catalog_image_config where team_id=p_team and mode='v2') then jsonb_build_object(
   'mode','v2','revision',(select revision from private.catalog_image_config where team_id=p_team),
   'entries',(select coalesce(jsonb_agg(jsonb_build_array(id,publication_id,classification,active,revision) order by id),'[]') from public.team_catalog_image_pool_entries where team_id=p_team))
  else jsonb_build_object('mode','legacy',
   'imageLink',(select image_link from public.team_product_catalog_settings where team_id=p_team),
   'images',(select coalesce(jsonb_agg(jsonb_build_array(i.material_id,i.drive_file_id,i.resource_key,coalesce(m.checksum,m.drive_version),i.name,m.lifecycle) order by i.material_id),'[]') from private.product_catalog_pool_images(p_team) i join public.team_materials m on m.id=i.material_id and m.team_id=p_team)) end
 )::text,'sha256'),'hex')
$$;
revoke all on function private.launch_catalog_settings_version(uuid) from public,anon,authenticated,service_role;

create function private.catalog_content_intent_policy() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' then
  if (new.checkpoint->'contentPolicyVersion') is distinct from (old.checkpoint->'contentPolicyVersion') then raise exception 'WRONG_STATE' using errcode='55000';end if;
 else
  -- Never infer policy from an empty existing checkpoint. This runs only on INSERT.
  new.checkpoint:=coalesce(new.checkpoint,'{}')-'contentPolicyVersion';
  if new.request_key not like 'launch:%' or (
   new.request_key ~ '^launch:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:catalog$'
   and exists(select 1 from public.team_launch_generations g join public.team_launch_revisions r on r.id=g.revision_id and r.team_id=g.team_id
    where g.team_id=new.team_id and g.id::text=split_part(new.request_key,':',2) and g.actor_id=new.actor_id
     and r.config->>'materialId'=new.video_material_id::text and r.config->>'method'='catalog'
     and r.sources->>'catalogSettingsVersion' like 'automatic-v1:%')) then
   new.checkpoint:=new.checkpoint||'{"contentPolicyVersion":1}'::jsonb;
  end if;
 end if;
 return new;
end $$;
revoke all on function private.catalog_content_intent_policy() from public,anon,authenticated,service_role;
create trigger catalog_content_intent_policy before insert or update of checkpoint on private.catalog_generation_intents for each row execute function private.catalog_content_intent_policy();
create or replace function private.freeze_launch_catalog_resources(p_team uuid,p_generation uuid,p_actor uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare l public.team_launches%rowtype;g public.team_launch_generations%rowtype;r public.team_launch_revisions%rowtype;
 frozen jsonb;settings jsonb;texts jsonb;images jsonb;expected text;actual text;n integer;automatic boolean;
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
 automatic:=expected like 'automatic-v1:%';
 actual:=case when automatic then private.launch_catalog_settings_version(p_team) else private.launch_catalog_settings_version_legacy(p_team) end;
 if automatic then
  settings:=jsonb_build_object('title',null,'description',null,'imageLink',(select image_link from public.team_product_catalog_settings where team_id=p_team),'priceMin',20,'priceMax',40,'contentPolicyVersion',1);
 else
  select jsonb_build_object('title',s.title,'description',s.description,'imageLink',s.image_link,'priceMin',coalesce(s.price_min,s.price),'priceMax',coalesce(s.price_max,s.price)) into settings from public.team_product_catalog_settings s where s.team_id=p_team;
 end if;
 if settings is null or expected is null or actual is distinct from expected then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 n:=(r.config->'catalog'->>'productCount')::integer;
 if n not between 1 and 400 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if automatic then texts:='[]';else
 select coalesce(jsonb_agg(jsonb_build_object('title',title,'description',description)),'[]') into texts from public.service_draw_product_catalog_texts(p_team,n);
 end if;
 if private.catalog_global_is_active() or g.catalog_image_contract_version=2 then
  images:=public.service_draw_product_catalog_images_v3(p_team,n,g.catalog_image_attempt_id,'create',g.catalog_image_attempt_id);
  if images='[]'::jsonb then raise exception 'WRONG_STATE' using errcode='55000'; end if;
 end if;
 if images is null then
 select coalesce(jsonb_agg(jsonb_build_object('driveFileId',drive_file_id,'resourceKey',resource_key,'name',name)),'[]') into images from public.service_draw_product_catalog_images(p_team,n);
 end if;
 if (case when automatic then private.launch_catalog_settings_version(p_team) else private.launch_catalog_settings_version_legacy(p_team) end) is distinct from expected then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 frozen:=jsonb_build_object('settings',settings,'settingsVersion',expected,'texts',texts,'images',images,'poolResourcesReady',true)||case when automatic then '{"contentPolicyVersion":1}'::jsonb else '{}'::jsonb end;
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
  if frozen ? 'contentPolicyVersion' and frozen->'contentPolicyVersion' is distinct from r.checkpoint->'contentPolicyVersion' then raise exception 'WRONG_STATE' using errcode='55000';end if;
  update private.catalog_generation_intents set checkpoint=checkpoint||frozen,state='planning',lease_expires_at=clock_timestamp()+interval '180 seconds',updated_at=clock_timestamp() where id=r.id;
  return frozen;
 end if;
 if r.checkpoint->>'poolResourcesReady'='true' then return jsonb_build_object('texts',r.checkpoint->'texts','images',r.checkpoint->'images');end if;
 n:=(r.request_payload->>'productCount')::integer;if n not between 1 and 400 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if r.checkpoint->>'contentPolicyVersion'='1' then texts:='[]';else
 select coalesce(jsonb_agg(jsonb_build_object('title',title,'description',description)),'[]') into texts from public.service_draw_product_catalog_texts(p_team,n);
 end if;
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

-- One active/latest recipe per catalog; historical attempts keep bounded counts only.
alter table public.team_catalog_update_attempts
 add column content_policy_version integer,
 add column planned_row_count integer,
 add column automatic_row_count integer,
 add column retained_row_count integer,
 add constraint catalog_content_receipt_valid check (
  (content_policy_version is null and planned_row_count is null and automatic_row_count is null and retained_row_count is null)
  or (content_policy_version=1 and planned_row_count between 1 and 400 and automatic_row_count between 0 and 400 and retained_row_count between 0 and 400
   and automatic_row_count+retained_row_count=planned_row_count
   and content_policy_version is not null and planned_row_count is not null and automatic_row_count is not null and retained_row_count is not null));
create table private.catalog_update_content_recipes (
 catalog_material_id uuid primary key references public.team_product_catalogs(material_id) on delete cascade,
 attempt_id uuid not null references public.team_catalog_update_attempts(attempt_id) on delete cascade,
 base_signature text not null,
 recipe jsonb not null,
 created_at timestamptz not null default now(),
 check(jsonb_typeof(recipe)='object' and jsonb_typeof(recipe->'rows')='array' and jsonb_array_length(recipe->'rows') between 1 and 400)
);
alter table private.catalog_update_content_recipes enable row level security;
alter table private.catalog_update_content_recipes force row level security;
revoke all on private.catalog_update_content_recipes from public,anon,authenticated,service_role;
-- Recipes retain material/image identities and must participate in late-reference cleanup fencing.
create trigger task_cleanup_reference_fence before insert or update on private.catalog_update_content_recipes
 for each row execute function private.guard_task_cleanup_reference();

-- Read and freeze share the same current-lease and original-base authority. NULL recipe is read-only.
create function public.service_catalog_update_content_recipe(p_catalog uuid,p_worker text,p_expected_base text default null,p_recipe jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u public.team_catalog_updater_items%rowtype;a public.team_catalog_update_attempts%rowtype;
 c public.team_product_catalogs%rowtype;known private.catalog_update_content_recipes%rowtype;
 signature text;n integer;generated integer;retained integer;row_value jsonb;
begin
 select * into u from public.team_catalog_updater_items where catalog_material_id=p_catalog for update;
 if u.catalog_material_id is null or u.lease_owner is distinct from p_worker or u.lease_expires_at is null or u.lease_expires_at<=clock_timestamp() or u.round_due_at is null then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 if u.reconciliation_required or exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=p_catalog) then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 select * into a from public.team_catalog_update_attempts where catalog_material_id=p_catalog and round_due_at=u.round_due_at for update;
 if a.attempt_id is null or a.result<>'running' then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into c from public.team_product_catalogs where material_id=p_catalog and team_id=u.team_id for update;
 if c.material_id is null then raise exception 'WRONG_STATE' using errcode='55000';end if;
 signature:=encode(extensions.digest(jsonb_build_object('attempt',a.attempt_id,'round',a.round_due_at,'profile',a.profile_snapshot,'profileVersion',a.profile_version,'count',c.update_count,'products',c.product_count,'snapshot',c.settings_snapshot)::text,'sha256'),'hex');
 select * into known from private.catalog_update_content_recipes where catalog_material_id=p_catalog;
 if known.attempt_id=a.attempt_id then
  if known.base_signature is distinct from signature then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
  return jsonb_build_object('attemptId',a.attempt_id,'baseSignature',signature,'recipe',known.recipe);
 end if;
 if p_recipe is null then return jsonb_build_object('attemptId',a.attempt_id,'baseSignature',signature,'recipe',null);end if;
 if p_expected_base is distinct from signature then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 if jsonb_typeof(p_recipe) is distinct from 'object' or p_recipe->>'contentPolicyVersion' is distinct from '1' or jsonb_typeof(p_recipe->'rows') is distinct from 'array' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 n:=jsonb_array_length(p_recipe->'rows');generated:=(p_recipe->>'automaticRowCount')::integer;retained:=(p_recipe->>'retainedRowCount')::integer;
 if n not between 1 and 400 or (p_recipe->>'productCount')::integer is distinct from n or generated is null or retained is null or generated not between 0 and 400 or retained not between 0 and 400 or generated+retained<>n or n<c.product_count then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 for row_value in select value from jsonb_array_elements(p_recipe->'rows') loop
  if jsonb_typeof(row_value) is distinct from 'object' or jsonb_typeof(row_value->'title') is distinct from 'string' or jsonb_typeof(row_value->'description') is distinct from 'string' or jsonb_typeof(row_value->'imageLink') is distinct from 'string' or jsonb_typeof(row_value->'price') is distinct from 'number' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 end loop;
 insert into private.catalog_update_content_recipes(catalog_material_id,attempt_id,base_signature,recipe) values(p_catalog,a.attempt_id,signature,p_recipe)
 on conflict(catalog_material_id) do update set attempt_id=excluded.attempt_id,base_signature=excluded.base_signature,recipe=excluded.recipe,created_at=clock_timestamp();
 update public.team_catalog_update_attempts set content_policy_version=1,planned_row_count=n,automatic_row_count=generated,retained_row_count=retained where attempt_id=a.attempt_id;
 return jsonb_build_object('attemptId',a.attempt_id,'baseSignature',signature,'recipe',p_recipe);
end $$;
revoke all on function public.service_catalog_update_content_recipe(uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.service_catalog_update_content_recipe(uuid,text,text,jsonb) to service_role;
