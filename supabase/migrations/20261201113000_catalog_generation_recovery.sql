-- Private catalog journal shared by the existing dialog and Launch adapter.
create table private.catalog_generation_intents (
 id uuid primary key default gen_random_uuid(), team_id uuid not null references public.teams(id) on delete cascade,
 video_material_id uuid not null, actor_id uuid not null references auth.users(id), request_key text not null,
 request_digest text not null, request_payload jsonb not null, variant integer not null check(variant>0), replaces_material_id uuid,
 state text not null default 'reserved' check(state in('reserved','planning','planned','create_started','created','finalized','registered','interrupted','cleanup_pending','canceled')),
 checkpoint jsonb not null default '{}', result jsonb, operation_id uuid references public.team_operations(id),
 lease_owner uuid, lease_expires_at timestamptz, fence bigint not null default 1, attempt integer not null default 1,
 next_attempt_at timestamptz, safe_error_code text, created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(team_id,request_key),unique(id,team_id)
);
create unique index catalog_generation_reserved_variant on private.catalog_generation_intents(team_id,video_material_id,variant) where replaces_material_id is null;
create index catalog_generation_due on private.catalog_generation_intents(next_attempt_at,lease_expires_at) where state in('interrupted','cleanup_pending','create_started','created','finalized');
create table private.catalog_generation_sharing (
 intent_id uuid not null references private.catalog_generation_intents(id) on delete cascade, file_id text not null,
 credential_id uuid not null, permission_id text, prior_anyone boolean not null, created_by_attempt boolean not null default false,
 state text not null check(state in('pending','created','preserved','cleanup_pending','cleaned')),
 updated_at timestamptz not null default now(),primary key(intent_id,file_id)
);
alter table private.catalog_generation_intents enable row level security;
alter table private.catalog_generation_intents force row level security;
alter table private.catalog_generation_sharing enable row level security;
alter table private.catalog_generation_sharing force row level security;
revoke all on private.catalog_generation_intents,private.catalog_generation_sharing from public,anon,authenticated;
grant select,insert,update on private.catalog_generation_intents,private.catalog_generation_sharing to service_role;
create function public.service_begin_catalog_intent(p_team uuid,p_video uuid,p_actor uuid,p_key text,p_payload jsonb,p_owner uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.catalog_generation_intents%rowtype;d text;v integer;replaces uuid;
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
  insert into private.catalog_generation_intents(team_id,video_material_id,actor_id,request_key,request_digest,request_payload,variant,replaces_material_id,lease_owner,lease_expires_at)
  values(p_team,p_video,p_actor,p_key,d,p_payload,v,replaces,p_owner,clock_timestamp()+interval '180 seconds') returning * into r;
 end if;
 return jsonb_build_object('id',r.id,'variant',r.variant,'state',r.state,'fence',r.fence::text,'attempt',r.attempt,'checkpoint',r.checkpoint,'result',r.result,'operationId',r.operation_id);
end $$;
create function public.service_checkpoint_catalog_intent(p_team uuid,p_intent uuid,p_actor uuid,p_owner uuid,p_fence text,p_state text,p_checkpoint jsonb,p_operation uuid default null,p_result jsonb default null) returns void language plpgsql security definer set search_path='' as $$
declare r private.catalog_generation_intents%rowtype;begin
 if p_actor is null or not private.can(p_team,'view',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into r from private.catalog_generation_intents where team_id=p_team and id=p_intent for update;
 if not found or r.actor_id<>p_actor or r.lease_owner<>p_owner or r.fence::text<>p_fence or r.lease_expires_at<=clock_timestamp() or r.state in('registered','canceled') then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 if p_operation is not null and not exists(select 1 from public.team_operations where id=p_operation and team_id=p_team and actor_id=p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if p_state='registered' and p_result is null then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if r.operation_id is not null and exists(select 1 from public.team_operations where id=r.operation_id and state='canceled') and p_state not in('cleanup_pending','interrupted','canceled') then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if jsonb_typeof(p_checkpoint)<>'object' or octet_length(p_checkpoint::text)>16777216 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 update private.catalog_generation_intents set state=p_state,checkpoint=checkpoint||p_checkpoint,operation_id=coalesce(p_operation,operation_id),result=coalesce(p_result,result),lease_expires_at=case when p_state in('interrupted','cleanup_pending') then clock_timestamp() else clock_timestamp()+interval '180 seconds' end,next_attempt_at=case when p_state in('interrupted','cleanup_pending','create_started','created','finalized') then clock_timestamp()+interval '30 seconds' else null end,updated_at=clock_timestamp() where id=r.id;
end $$;
create function public.service_record_catalog_permission(p_team uuid,p_intent uuid,p_actor uuid,p_owner uuid,p_fence text,p_file text,p_credential uuid,p_permission text,p_prior_anyone boolean,p_state text) returns void language plpgsql security definer set search_path='' as $$
declare r private.catalog_generation_intents%rowtype;begin
 select * into r from private.catalog_generation_intents where id=p_intent and team_id=p_team for update;
 if p_actor is null or not private.can(p_team,'view',p_actor) or r.actor_id<>p_actor or r.lease_owner<>p_owner or r.fence::text<>p_fence or r.lease_expires_at<=clock_timestamp() then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 if r.id is null or p_file is null or char_length(p_file) not between 1 and 200 or p_credential is null then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 insert into private.catalog_generation_sharing(intent_id,file_id,credential_id,permission_id,prior_anyone,created_by_attempt,state) values(p_intent,p_file,p_credential,p_permission,p_prior_anyone,p_permission is not null and not p_prior_anyone,p_state)
 on conflict(intent_id,file_id) do update set permission_id=coalesce(excluded.permission_id,catalog_generation_sharing.permission_id),created_by_attempt=catalog_generation_sharing.created_by_attempt or excluded.created_by_attempt,state=excluded.state,updated_at=clock_timestamp();
end $$;
revoke all on function public.service_begin_catalog_intent(uuid,uuid,uuid,text,jsonb,uuid),public.service_checkpoint_catalog_intent(uuid,uuid,uuid,uuid,text,text,jsonb,uuid,jsonb),public.service_record_catalog_permission(uuid,uuid,uuid,uuid,text,text,uuid,text,boolean,text) from public,anon,authenticated;
grant execute on function public.service_begin_catalog_intent(uuid,uuid,uuid,text,jsonb,uuid),public.service_checkpoint_catalog_intent(uuid,uuid,uuid,uuid,text,text,jsonb,uuid,jsonb),public.service_record_catalog_permission(uuid,uuid,uuid,uuid,text,text,uuid,text,boolean,text) to service_role;

-- Draw and save both pools in the same transaction: a lost reply cannot rotate the pools twice.
create function public.service_plan_catalog_resources(p_team uuid,p_intent uuid,p_actor uuid,p_owner uuid,p_fence text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.catalog_generation_intents%rowtype;texts jsonb;images jsonb;n integer;begin
 select * into r from private.catalog_generation_intents where team_id=p_team and id=p_intent for update;
 if r.id is null or p_actor is null or not private.can(p_team,'view',p_actor) or r.actor_id<>p_actor or r.lease_owner<>p_owner or r.fence::text<>p_fence or r.lease_expires_at<=clock_timestamp() or r.state in('registered','canceled') then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 if r.checkpoint->>'poolResourcesReady'='true' then return jsonb_build_object('texts',r.checkpoint->'texts','images',r.checkpoint->'images');end if;
 n:=(r.request_payload->>'productCount')::integer;if n not between 1 and 400 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select coalesce(jsonb_agg(jsonb_build_object('title',title,'description',description)),'[]') into texts from public.service_draw_product_catalog_texts(p_team,n);
 select coalesce(jsonb_agg(jsonb_build_object('driveFileId',drive_file_id,'resourceKey',resource_key,'name',name)),'[]') into images from public.service_draw_product_catalog_images(p_team,n);
 update private.catalog_generation_intents set checkpoint=checkpoint||jsonb_build_object('texts',texts,'images',images,'poolResourcesReady',true),state='planning',lease_expires_at=clock_timestamp()+interval '180 seconds',updated_at=clock_timestamp() where id=r.id;
 return jsonb_build_object('texts',texts,'images',images);
end $$;
create function public.service_reconcile_catalog_result(p_team uuid,p_intent uuid,p_actor uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r private.catalog_generation_intents%rowtype;material uuid;result jsonb;begin
 select * into r from private.catalog_generation_intents where team_id=p_team and id=p_intent;
 if r.id is null or p_actor is null or not private.can(p_team,'view',p_actor) or r.actor_id<>p_actor then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 material:=coalesce(nullif(r.checkpoint->>'materialId','')::uuid,(select result_material_id from public.team_operations where id=r.operation_id and team_id=p_team and actor_id=p_actor));
 select jsonb_build_object('outcome',case when r.replaces_material_id is null then 'created' else 'recreated' end,'videoShared',false,'catalog',jsonb_build_object('materialId',c.material_id,'name',m.name,'sheetUrl',c.sheet_url,'sourceLink',c.source_link,'productCount',c.product_count,'variant',c.variant,'createdAt',c.created_at)) into result
 from public.team_product_catalogs c join public.team_materials m on m.id=c.material_id and m.team_id=c.team_id
 where c.team_id=p_team and c.material_id=material and c.video_material_id=r.video_material_id and c.variant=r.variant and c.source_link=r.request_payload->>'sourceLink' and c.product_count=(r.request_payload->>'productCount')::integer and m.lifecycle='active';
 return result;
end $$;
create function public.service_retry_catalog_child(p_team uuid,p_intent uuid,p_actor uuid,p_owner uuid,p_fence text) returns integer language plpgsql security definer set search_path='' as $$
declare r private.catalog_generation_intents%rowtype;n integer;begin
 select * into r from private.catalog_generation_intents where team_id=p_team and id=p_intent for update;
 if r.id is null or p_actor is null or not private.can(p_team,'view',p_actor) or r.actor_id<>p_actor or r.lease_owner<>p_owner or r.fence::text<>p_fence or r.lease_expires_at<=clock_timestamp() then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 if not exists(select 1 from public.team_operations where id=r.operation_id and team_id=p_team and actor_id=p_actor and state='failed') then raise exception 'WRONG_STATE' using errcode='55000';end if;
 update private.catalog_generation_intents set operation_id=null,attempt=attempt+1,lease_expires_at=clock_timestamp()+interval '180 seconds',updated_at=clock_timestamp() where id=r.id returning attempt into n;return n;
end $$;
revoke all on function public.service_plan_catalog_resources(uuid,uuid,uuid,uuid,text),public.service_reconcile_catalog_result(uuid,uuid,uuid),public.service_retry_catalog_child(uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.service_plan_catalog_resources(uuid,uuid,uuid,uuid,text),public.service_reconcile_catalog_result(uuid,uuid,uuid),public.service_retry_catalog_child(uuid,uuid,uuid,uuid,text) to service_role;
