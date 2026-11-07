-- Bounded observation used by the accepted-recipe factory. Internal only;
-- no provider I/O, browser RPC or public recovery capability is enabled.
begin;
create function private.restitch_selection_pool_snapshot(p_team uuid,p_user uuid,p_slot text)
returns jsonb language sql stable security definer set search_path='' as $fn$
 with recursive source as (
  select s.material_id,s.kind,m.connection_id,m.drive_file_id,
   (m.id is null or m.lifecycle<>'active' or m.kind is distinct from s.kind
    or (s.kind='file' and m.category is distinct from 'image')
    or d.id is null or d.state<>'connected') as unknown_source
  from public.team_restitch_sources s
  left join public.team_materials m on m.id=s.material_id and m.team_id=s.team_id
  left join public.team_drive_connections d on d.id=m.connection_id and d.team_id=s.team_id
  where s.team_id=p_team and s.user_id is not distinct from p_user and s.slot=p_slot
 ), folders as (
  select connection_id,drive_file_id from source where kind='folder' and not unknown_source
  union
  select m.connection_id,m.drive_file_id from public.team_materials m join folders f
   on m.connection_id=f.connection_id and m.parent_folder_id=f.drive_file_id
   where m.team_id=p_team and m.kind='folder' and m.lifecycle='active'
 ), bounded_folders as materialized (
  select connection_id,drive_file_id from folders limit 5001
 ), folder_counts as (
  select count(*) as observed from bounded_folders
 ), observed as (
  select m.id,m.connection_id,m.drive_file_id,m.resource_key,m.parent_folder_id,
   m.checksum,m.mime_type,m.size_bytes,m.drive_version,d.root_folder_id,
   case when m.checksum is null or m.checksum!~'^[0-9a-f]{32}$' or m.mime_type is null
      or m.size_bytes is null or m.drive_version is null or m.parent_folder_id is null
      or length(m.drive_file_id) not between 1 and 1024 or length(m.parent_folder_id) not between 1 and 1024
      or length(d.root_folder_id) not between 1 and 1024
      or (m.resource_key is not null and length(m.resource_key) not between 1 and 4096) then 'unknown'
    when private.restitch_image_ok(m.mime_type,m.size_bytes,m.name,m.checksum) then 'eligible'
    else 'ineligible' end as eligibility
  from public.team_materials m join public.team_drive_connections d on d.id=m.connection_id and d.team_id=m.team_id
  where m.team_id=p_team and m.kind='file' and m.category='image' and m.lifecycle='active' and d.state='connected'
   and (exists(select 1 from bounded_folders f where f.connection_id=m.connection_id and f.drive_file_id=m.parent_folder_id)
    or exists(select 1 from source s where not s.unknown_source and s.kind='file' and s.material_id=m.id))
  order by m.id limit 5001
 ), counts as (
  select count(*) as observed,count(*) filter(where eligibility='eligible') as eligible,
   count(*) filter(where eligibility='unknown') as unknown,
   count(*) filter(where eligibility='ineligible') as ineligible from observed
 ), admitted as (
  select * from observed where eligibility='eligible' order by id limit 501
 ), source_counts as (
  select count(*) as total,count(*) filter(where unknown_source) as unknown from source
 )
 select jsonb_build_object(
  'candidates',coalesce((select jsonb_agg(jsonb_build_object('materialId',id,'connectionId',connection_id,
   'fileId',drive_file_id,'resourceKey',resource_key,'parentFolderId',parent_folder_id,
   'rootFolderId',root_folder_id,'checksum',checksum,'mimeType',mime_type,'sizeBytes',size_bytes,
   'driveVersion',drive_version) order by id) from admitted),'[]'::jsonb),
  'complete',c.observed<=5000 and f.observed<=5000 and c.eligible<=500 and c.unknown=0 and s.unknown=0,
  'eligibleObserved',c.eligible,'ineligibleObserved',c.ineligible,'unknownObserved',c.unknown,
  'sourceCount',s.total,'unknownSourceCount',s.unknown,'truncated',c.observed>5000 or f.observed>5000 or c.eligible>500)
 from counts c cross join source_counts s cross join folder_counts f;
$fn$;
revoke all on function private.restitch_selection_pool_snapshot(uuid,uuid,text) from public,anon,authenticated,service_role;

create function private.restitch_selection_source_matches(p_recipe jsonb,p_version text,p_kind text,p_material public.team_materials)
returns boolean language sql immutable set search_path='' as $fn$
 select coalesce(case when p_recipe ? 'selectionProtocol' then
  p_kind='download' and p_recipe->'selectionProtocol'='1'::jsonb
  and (p_material).kind='file' and (p_material).category='video'
  and (p_material).checksum is not null and (p_material).checksum~'^[0-9a-f]{32}$'
  and (p_material).size_bytes>0 and (p_material).mime_type is not null
  and p_recipe->'sourceIdentity'=jsonb_build_object('connectionId',(p_material).connection_id,
   'fileId',(p_material).drive_file_id,'checksum',(p_material).checksum,
   'mimeType',(p_material).mime_type,'sizeBytes',(p_material).size_bytes)
 else (p_material).drive_version is not distinct from p_version end,false);
$fn$;
revoke all on function private.restitch_selection_source_matches(jsonb,text,text,public.team_materials) from public,anon,authenticated,service_role;

create or replace function private.restitch_selection_root_binding() returns trigger
language plpgsql security definer set search_path='' as $fn$
declare o public.team_operations%rowtype;m public.team_materials%rowtype;
begin
 if tg_op='UPDATE' then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into o from public.team_operations where id=new.root_operation_id for update;
 if o.id is null or o.team_id is distinct from new.team_id or o.actor_id is distinct from new.actor_id
  or o.source_material_id is distinct from new.source_material_id or o.kind not in('download','process')
  or o.state not in('pending','running') then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if not private.can(new.team_id,'download',new.actor_id) or
  (o.kind='process' and not private.can(new.team_id,'process',new.actor_id)) then
  raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into m from public.team_materials where id=new.source_material_id and team_id=new.team_id for share;
 if m.id is null or m.lifecycle<>'active' or m.category is distinct from 'video' or not private.restitch_selection_source_matches(new.recipe,new.source_version,o.kind,m) then
  raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 if new.recipe_owner_id<>new.actor_id and not exists(select 1 from public.teams where id=new.team_id and owner_id=new.recipe_owner_id) then
  raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 -- This foundation admits manual roots only. Automated preparation/root aliases
 -- must be added with their own immutable acceptance proof, never guessed here.
 if exists(select 1 from private.catalog_restitch_operations where operation_id=new.root_operation_id)
  or exists(select 1 from private.launch_restitch_preparations where operation_id=new.root_operation_id) then
  raise exception 'WRONG_STATE' using errcode='55000';end if;
 if o.kind='process' and not exists(select 1 from private.team_operation_intents where operation_id=o.id and team_id=new.team_id and tool_id='restitch') then
  raise exception 'WRONG_STATE' using errcode='55000';end if;
 return new;
end $fn$;

create or replace function public.service_cas_restitch_selection_slot(
 p_root_operation uuid,p_team uuid,p_actor uuid,p_slot text,p_expected_budget jsonb,p_next_budget jsonb)
returns boolean language plpgsql security definer set search_path='' as $fn$
declare o public.team_operations%rowtype;r private.restitch_selection_roots%rowtype;
 s private.restitch_selection_slots%rowtype;m public.team_materials%rowtype;c private.restitch_selection_candidates%rowtype;
 step text;last_candidate jsonb;
begin
 select * into o from public.team_operations where id=p_root_operation for update;
 select * into r from private.restitch_selection_roots
  where root_operation_id=p_root_operation and team_id=p_team and actor_id=p_actor;
 if r.root_operation_id is null or o.team_id is distinct from p_team or o.actor_id is distinct from p_actor then
  raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if not private.can(p_team,'download',p_actor) or (o.kind='process' and not private.can(p_team,'process',p_actor)) then
  raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if o.kind not in('download','process') or o.state not in('pending','running')
  or o.source_material_id is distinct from r.source_material_id then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into m from public.team_materials where id=r.source_material_id and team_id=p_team for share;
 if m.id is null or m.lifecycle<>'active' or not private.restitch_selection_source_matches(r.recipe,r.source_version,o.kind,m) then
  raise exception 'RESTITCH_SOURCES_INVALID' using errcode='55000';end if;
 if p_slot is null or p_slot not in('start','end') or r.recipe->'defaults'->>'sourceMode' is distinct from 'drive'
  or r.recipe->'defaults'->>'configured' is distinct from 'true'
  or coalesce(r.recipe->'defaults'->>'operation','') not in('stitch','restitch')
  or coalesce(r.recipe->'defaults'->>(p_slot||'Enabled'),'true')<>'true' then
  raise exception 'RESTITCH_SOURCES_INVALID' using errcode='55000';end if;
 select * into s from private.restitch_selection_slots where root_operation_id=p_root_operation and slot=p_slot for update;
 if s.root_operation_id is null then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 if s.snapshot_complete is null then raise exception 'RESTITCH_SOURCES_INVALID' using errcode='55000';end if;
 if s.budget is distinct from p_expected_budget then return false;end if;
 step:=private.restitch_selection_step_kind(s.budget,p_next_budget);
 if step is null then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 last_candidate:=p_next_budget->'candidates'->(jsonb_array_length(p_next_budget->'candidates')-1);
 if step in('select','reserve') then
  select * into c from private.restitch_selection_candidates where root_operation_id=p_root_operation
   and slot=p_slot and version_id=(last_candidate->>'versionId')::uuid;
  if c.version_id is null or c.size_bytes is distinct from (last_candidate->>'sizeBytes')::bigint then
   raise exception 'RESTITCH_SOURCES_INVALID' using errcode='55000';end if;
  if step='reserve' then
   select * into m from public.team_materials where id=c.material_id and team_id=p_team for share;
   if m.id is null or m.lifecycle<>'active' or m.kind<>'file' or m.category is distinct from 'image' or m.checksum is distinct from c.checksum
    or m.size_bytes is distinct from c.size_bytes or m.mime_type is distinct from c.mime_type
    or m.connection_id is distinct from c.connection_id or m.drive_file_id is distinct from c.drive_file_id
    or m.parent_folder_id is distinct from c.parent_folder_id then
    raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
   if not exists(select 1 from public.team_drive_connections where id=c.connection_id and team_id=p_team and state='connected' and root_folder_id=c.root_folder_id) then
    raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
  end if;
 end if;
 update private.restitch_selection_slots set budget=p_next_budget where root_operation_id=p_root_operation and slot=p_slot;
 return true;
end $fn$;



create function private.freeze_restitch_selection_defaults(p_defaults jsonb,p_draw double precision)
returns jsonb language plpgsql immutable set search_path='' as $fn$
declare mode text;center_value integer;lo integer;hi integer;seconds integer;
begin
 if jsonb_typeof(p_defaults) is distinct from 'object' or p_draw is null or p_draw<0 or p_draw>1 then
  raise exception 'RESTITCH_INVALID' using errcode='22023';end if;
 mode:=p_defaults->>'finalDurationMode';
 if mode in('custom','random-centered') then
  if jsonb_typeof(p_defaults->'customFinalDurationSeconds') is distinct from 'number'
   or p_defaults->>'customFinalDurationSeconds' !~ '^[0-9]+$' then
   raise exception 'RESTITCH_INVALID' using errcode='22023';end if;
  if (p_defaults->>'customFinalDurationSeconds')::numeric not between 1 and 359999 then
   raise exception 'RESTITCH_INVALID' using errcode='22023';end if;
 end if;
 if mode='custom' then
  seconds:=greatest(1,least(3600,(p_defaults->>'customFinalDurationSeconds')::integer));
 elsif mode='random-centered' then
  center_value:=greatest(60,least(3600,round((p_defaults->>'customFinalDurationSeconds')::numeric/60)::integer*60));
  lo:=greatest(60,center_value-300);hi:=least(3600,center_value+300);
 elsif mode='random-30-40' then lo:=1800;hi:=2400;
 elsif mode='random-40-50' then lo:=2400;hi:=3000;
 elsif mode='random-50-60' then lo:=3000;hi:=3600;
 else raise exception 'RESTITCH_INVALID' using errcode='22023';end if;
 if mode<>'custom' then seconds:=lo+floor(least(0.999999999,p_draw)*(hi-lo+1))::integer;end if;
 if seconds is null then raise exception 'RESTITCH_INVALID' using errcode='22023';end if;
 return p_defaults||jsonb_build_object('finalDurationMode','custom','customFinalDurationSeconds',seconds);
end $fn$;
revoke all on function private.freeze_restitch_selection_defaults(jsonb,double precision) from public,anon,authenticated,service_role;

create table private.restitch_pool_namespaces (
 id uuid primary key default gen_random_uuid(),
 team_id uuid not null references public.teams(id) on delete cascade,
 actor_id uuid not null references auth.users(id) on delete cascade,
 configuration jsonb not null check(jsonb_typeof(configuration)='object' and octet_length(configuration::text)<=1048576),
 configuration_hash bytea not null check(octet_length(configuration_hash)=32),
 created_at timestamptz not null default clock_timestamp(),
 unique(team_id,actor_id,configuration_hash)
);
alter table private.restitch_pool_namespaces enable row level security;
alter table private.restitch_pool_namespaces force row level security;
revoke all on private.restitch_pool_namespaces from public,anon,authenticated,service_role;
create trigger task_cleanup_reference_fence before insert or update on private.restitch_pool_namespaces
 for each row execute function private.guard_task_cleanup_reference();
create trigger restitch_pool_namespace_immutable before update on private.restitch_pool_namespaces
 for each row execute function private.restitch_candidate_version_immutable();

create function private.restitch_selection_root_descriptor(p_root uuid,p_reused boolean)
returns jsonb language sql stable security definer set search_path='' as $fn$
 select jsonb_build_object('operationId',r.root_operation_id,'teamId',r.team_id,'actorId',r.actor_id,
  'sourceMaterialId',r.source_material_id,'sourceVersion',r.source_version,'operationState',o.state,
  'poolNamespaceId',r.pool_namespace_id,'recipe',r.recipe,'reused',p_reused)
 from private.restitch_selection_roots r join public.team_operations o on o.id=r.root_operation_id where r.root_operation_id=p_root;
$fn$;
revoke all on function private.restitch_selection_root_descriptor(uuid,boolean) from public,anon,authenticated,service_role;

create function public.service_accept_manual_restitch_download(
 p_team uuid,p_actor uuid,p_material uuid,p_key text,p_client_operation uuid)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare o public.team_operations%rowtype;r private.restitch_selection_roots%rowtype;
 m public.team_materials%rowtype;ctx jsonb;settings jsonb;scope_configuration jsonb;scope_digest bytea;namespace_id uuid;
 seed uuid;source_identity jsonb;recipe jsonb;selected_slot text;pool jsonb;entry jsonb;candidate_ordinal integer;candidate_version_id uuid;
 nonce text:='restitch-download-v1:'||p_client_operation::text;
begin
 if p_client_operation is null or p_key is null or p_key!~'^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
  raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if p_team is null or p_actor is null or private.can(p_team,'download',p_actor) is distinct from true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('restitch-download-v1:'||p_team::text||':'||p_actor::text||':'||p_key,0));
 select * into o from public.team_operations where team_id=p_team and actor_id=p_actor
  and kind='download' and idempotency_key=p_key for update;
 if o.id is not null then
  if o.source_material_id is distinct from p_material or o.request_nonce is distinct from nonce then
   raise exception 'REQUEST_REUSE_CONFLICT' using errcode='22023';end if;
  if o.state not in('pending','running') then raise exception 'WRONG_STATE' using errcode='55000';end if;
  select * into r from private.restitch_selection_roots where root_operation_id=o.id;
  if r.root_operation_id is not null then
   if r.team_id is distinct from p_team or r.actor_id is distinct from p_actor
    or r.recipe->'selectionProtocol' is distinct from '1'::jsonb then raise exception 'WRONG_STATE' using errcode='55000';end if;
   return private.restitch_selection_root_descriptor(o.id,true);
  end if;
  -- The current acceptance is atomic. An existing operation without its
  -- original root is missing accounting, never permission to initialize again.
  raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';
 end if;
 select * into m from public.team_materials where id=p_material and team_id=p_team for share;
 if m.id is null or m.kind<>'file' or m.category is distinct from 'video' or m.lifecycle<>'active'
  or m.checksum is null or m.checksum!~'^[0-9a-f]{32}$' or m.size_bytes is null or m.size_bytes<1
  or m.drive_version is null or m.mime_type is null or not exists(select 1 from public.team_drive_connections d
   where d.id=m.connection_id and d.team_id=p_team and d.state='connected') then
  raise exception 'RESTITCH_SOURCES_INVALID' using errcode='55000';end if;
 -- One statement snapshot: defaults, effective pool owner, source declarations and
 -- both pools cannot be mixed across a concurrent settings commit.
 select jsonb_build_object('defaults',private.effective_restitch_defaults_json(p_team,p_actor),
  'poolUserId',private.launch_restitch_pool_user(p_team,p_actor),
  'recipeOwnerId',coalesce(private.launch_restitch_pool_user(p_team,p_actor),t.owner_id),
  'sources',coalesce((select jsonb_agg(jsonb_build_object('slot',s.slot,'kind',s.kind,
   'materialId',s.material_id,'fileId',s.drive_file_id) order by s.slot,s.kind,s.material_id,s.drive_file_id)
   from public.team_restitch_sources s where s.team_id=p_team
    and s.user_id is not distinct from private.launch_restitch_pool_user(p_team,p_actor)),'[]'::jsonb),
  'start',private.restitch_selection_pool_snapshot(p_team,private.launch_restitch_pool_user(p_team,p_actor),'start'),
  'end',private.restitch_selection_pool_snapshot(p_team,private.launch_restitch_pool_user(p_team,p_actor),'end'))
 into ctx from public.teams t where t.id=p_team;
 settings:=ctx->'defaults';
 if settings is null or settings='null'::jsonb or settings->>'configured' is distinct from 'true'
  or settings->>'sourceMode' is distinct from 'drive' or settings->>'operation' not in('stitch','restitch') then
  raise exception 'RESTITCH_INVALID' using errcode='22023';end if;
 if settings->>'startEnabled'='false' and settings->>'endEnabled'='false' then
  raise exception 'RESTITCH_NO_SCREENS' using errcode='22023';end if;
 if octet_length(ctx::text)>2097152 or jsonb_array_length(ctx->'sources')>1000 then
  raise exception 'RESTITCH_SOURCES_TOO_MANY' using errcode='22023';end if;
 scope_configuration:=jsonb_build_object('defaults',settings-'updatedAt'-'updatedBy'-'startImageIds'-'endImageIds',
  'sources',ctx->'sources','recipeOwnerId',ctx->'recipeOwnerId','poolUserId',ctx->'poolUserId');
 scope_digest:=pg_catalog.sha256(pg_catalog.convert_to(scope_configuration::text,'UTF8'));
 insert into private.restitch_pool_namespaces(team_id,actor_id,configuration,configuration_hash)
 values(p_team,p_actor,scope_configuration,scope_digest) on conflict(team_id,actor_id,configuration_hash) do nothing returning id into namespace_id;
 if namespace_id is null then
  select n.id into namespace_id from private.restitch_pool_namespaces n where n.team_id=p_team and n.actor_id=p_actor
   and n.configuration_hash=scope_digest and n.configuration=scope_configuration;
 end if;
 if namespace_id is null then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 if o.id is null then
  select operation_id into o.id from public.service_start_team_operation(p_team,p_actor,'download',p_key,nonce,p_material,null,null,null,m.size_bytes);
 end if;
 seed:=gen_random_uuid();
 source_identity:=jsonb_build_object('connectionId',m.connection_id,'fileId',m.drive_file_id,
  'checksum',m.checksum,'mimeType',m.mime_type,'sizeBytes',m.size_bytes);
 recipe:=jsonb_build_object('schemaVersion',1,'selectionProtocol',1,'seed',seed,'clientOperationId',p_client_operation,
  'defaults',private.freeze_restitch_selection_defaults(settings,random()),'sourceIdentity',source_identity,
  'poolUserId',ctx->'poolUserId','poolObservations',jsonb_build_object('start',(ctx->'start')-'candidates','end',(ctx->'end')-'candidates'));
 insert into private.restitch_selection_roots(root_operation_id,team_id,actor_id,source_material_id,source_version,recipe_owner_id,pool_namespace_id,recipe)
 values(o.id,p_team,p_actor,p_material,m.drive_version,(ctx->>'recipeOwnerId')::uuid,namespace_id,recipe);
 foreach selected_slot in array array['start','end'] loop
  pool:=ctx->selected_slot;candidate_ordinal:=0;
  if settings->>(selected_slot||'Enabled') is distinct from 'false' then
   for entry in select value from jsonb_array_elements(pool->'candidates')
    order by md5(seed::text||selected_slot||(value->>'materialId')),value->>'materialId' limit 500 loop
    candidate_ordinal:=candidate_ordinal+1;
    candidate_version_id:=private.register_restitch_candidate_version(p_team,(entry->>'materialId')::uuid);
    insert into private.restitch_selection_candidates(root_operation_id,slot,version_id,material_id,ordinal,
     size_bytes,mime_type,checksum,drive_version,connection_id,drive_file_id,resource_key,parent_folder_id,root_folder_id)
    values(o.id,selected_slot,candidate_version_id,(entry->>'materialId')::uuid,candidate_ordinal,(entry->>'sizeBytes')::bigint,
     entry->>'mimeType',entry->>'checksum',entry->>'driveVersion',(entry->>'connectionId')::uuid,
     entry->>'fileId',entry->>'resourceKey',entry->>'parentFolderId',entry->>'rootFolderId');
   end loop;
  end if;
  update private.restitch_selection_slots set snapshot_complete=(pool->>'complete')::boolean
   where root_operation_id=o.id and private.restitch_selection_slots.slot=selected_slot;
 end loop;
 update public.team_operations set state='running',stage='restitch_selection_accepted',updated_at=clock_timestamp() where id=o.id;
 return private.restitch_selection_root_descriptor(o.id,false);
end $fn$;
revoke all on function public.service_accept_manual_restitch_download(uuid,uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.service_accept_manual_restitch_download(uuid,uuid,uuid,text,uuid) to service_role;

create function public.service_read_manual_restitch_download(p_team uuid,p_actor uuid,p_material uuid,p_key text,p_client_operation uuid)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare o public.team_operations%rowtype;r private.restitch_selection_roots%rowtype;
begin
 if p_team is null or p_actor is null or private.can(p_team,'download',p_actor) is distinct from true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into o from public.team_operations where team_id=p_team and actor_id=p_actor and kind='download' and idempotency_key=p_key;
 if o.id is null then return null;end if;
 if o.source_material_id is distinct from p_material or o.request_nonce is distinct from 'restitch-download-v1:'||p_client_operation::text then
  raise exception 'REQUEST_REUSE_CONFLICT' using errcode='22023';end if;
 select * into r from private.restitch_selection_roots where root_operation_id=o.id and team_id=p_team and actor_id=p_actor;
 if r.root_operation_id is null then return null;end if;
 if r.recipe->'selectionProtocol' is distinct from '1'::jsonb then raise exception 'WRONG_STATE' using errcode='55000';end if;
 return private.restitch_selection_root_descriptor(o.id,true);
end $fn$;
revoke all on function public.service_read_manual_restitch_download(uuid,uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.service_read_manual_restitch_download(uuid,uuid,uuid,text,uuid) to service_role;
create or replace view public.analytics_restitch_selection_slots with(security_barrier=true) as
select r.root_operation_id as operation_id,r.team_id,r.actor_id,s.slot,r.pool_namespace_id,
 r.created_at,s.updated_at,s.snapshot_complete,
 case when exists(select 1 from jsonb_array_elements(s.budget->'transfers')a where a->'settlement'='null'::jsonb) then 'range_unconfirmed'
  when s.budget->'acceptedVersionId'<>'null'::jsonb and exists(
   select 1 from jsonb_array_elements(s.budget->'candidates')a where a->>'versionId'=s.budget->>'acceptedVersionId'
    and a->'validatedAcquisition'=a->'acquisition' and a->>'rejected'='false') then 'screen_validated'
  when jsonb_array_length(s.budget->'candidates')=0 and r.recipe->'defaults'->(s.slot||'Enabled')='false'::jsonb then 'disabled'
  when jsonb_array_length(s.budget->'candidates')=0 then 'awaiting_selection'
  when s.budget->'candidates'->(jsonb_array_length(s.budget->'candidates')-1)->>'rejected'='true' then 'candidate_rejected'
  else 'candidate_selected' end as state,
 jsonb_array_length(s.budget->'candidates') as candidate_count,
 coalesce((select jsonb_agg(x.value->>'versionId' order by x.ordinality) from jsonb_array_elements(s.budget->'candidates')with ordinality x(value,ordinality)),'[]'::jsonb) as candidate_versions,
 jsonb_array_length(s.budget->'transfers') as range_count,
 (select count(*)::integer from jsonb_array_elements(s.budget->'transfers')a where a->'settlement'='null'::jsonb) as unconfirmed_range_count,
 coalesce((select sum((a->'settlement'->>'bytes')::bigint) from jsonb_array_elements(s.budget->'transfers')a where a->'settlement'<>'null'::jsonb),0)::bigint as confirmed_bytes,
 coalesce((select sum((a->'settlement'->>'ioMs')::bigint) from jsonb_array_elements(s.budget->'transfers')a where a->'settlement'<>'null'::jsonb),0)::bigint as confirmed_io_ms,
 coalesce((select sum((a->>'acquisition')::integer) from jsonb_array_elements(s.budget->'candidates')a),0)::integer+
 (select count(*)::integer from jsonb_array_elements(s.budget->'transfers')a where a->>'retry'='true') as retry_count,
 jsonb_array_length(s.budget->'refreshes') as refresh_count,
 (s.budget->>'revision')::integer as budget_revision
from private.restitch_selection_roots r join private.restitch_selection_slots s using(root_operation_id);
commit;
