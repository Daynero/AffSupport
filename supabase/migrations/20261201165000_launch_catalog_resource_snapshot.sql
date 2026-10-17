-- Freeze the existing generator's inputs before a long local restitch operation.
alter table public.team_launch_generation_steps add column checkpoint jsonb not null default '{}'::jsonb;
create function private.freeze_launch_catalog_resources(p_team uuid,p_generation uuid,p_actor uuid) returns jsonb
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
 select coalesce(jsonb_agg(jsonb_build_object('driveFileId',drive_file_id,'resourceKey',resource_key,'name',name)),'[]') into images from public.service_draw_product_catalog_images(p_team,n);
 if private.launch_catalog_settings_version(p_team) is distinct from expected then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 frozen:=jsonb_build_object('settings',settings,'settingsVersion',expected,'texts',texts,'images',images,'poolResourcesReady',true);
 insert into public.team_launch_generation_steps(team_id,generation_id,stage,stable_step_key,state,input_signature,checkpoint,fence)
  values(p_team,g.id,'catalog_planning','catalog_resources','succeeded',expected,frozen,g.fence);
 return frozen;
end $$;
revoke all on function private.freeze_launch_catalog_resources(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function private.freeze_catalog_before_launch_restitch() returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform private.freeze_launch_catalog_resources(new.team_id,new.generation_id,new.actor_id);
 return new;
end $$;
revoke all on function private.freeze_catalog_before_launch_restitch() from public,anon,authenticated,service_role;
create trigger launch_restitch_catalog_resources before insert on private.launch_restitch_preparations
 for each row execute function private.freeze_catalog_before_launch_restitch();

create or replace function public.service_plan_catalog_resources(p_team uuid,p_intent uuid,p_actor uuid,p_owner uuid,p_fence text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.catalog_generation_intents%rowtype;parent public.team_launch_generations%rowtype;revision public.team_launch_revisions%rowtype;frozen jsonb;texts jsonb;images jsonb;n integer;
begin
 -- Launch locks precede the child lock, matching cancellation and recovery.
 select * into r from private.catalog_generation_intents where team_id=p_team and id=p_intent;
 if r.request_key ~ '^launch:[0-9a-f-]{36}:catalog$' then
  select * into parent from public.team_launch_generations where team_id=p_team and id=split_part(r.request_key,':',2)::uuid and actor_id=p_actor;
  select * into revision from public.team_launch_revisions where id=parent.revision_id and team_id=p_team;
  if parent.id is null or revision.config->>'materialId' is distinct from r.video_material_id::text
   or revision.generated_url is distinct from r.request_payload->>'sourceLink'
   or revision.config->'catalog'->'productCount' is distinct from r.request_payload->'productCount' then raise exception 'WRONG_STATE' using errcode='55000';end if;
  frozen:=private.freeze_launch_catalog_resources(p_team,parent.id,p_actor);
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
 select coalesce(jsonb_agg(jsonb_build_object('driveFileId',drive_file_id,'resourceKey',resource_key,'name',name)),'[]') into images from public.service_draw_product_catalog_images(p_team,n);
 update private.catalog_generation_intents set checkpoint=checkpoint||jsonb_build_object('texts',texts,'images',images,'poolResourcesReady',true),state='planning',lease_expires_at=clock_timestamp()+interval '180 seconds',updated_at=clock_timestamp() where id=r.id;
 return jsonb_build_object('texts',texts,'images',images);
end $$;
