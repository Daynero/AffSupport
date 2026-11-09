-- New catalog sets freeze their Drive-pool input at admission, not when a child
-- happens to run. Existing sets/processes without this proof are not adopted.
create table private.catalog_video_restitch_contexts (
 video_set_id uuid primary key references private.catalog_video_sets(id) on delete cascade,
 team_id uuid not null,actor_id uuid not null references auth.users(id),
 source_material_id uuid not null,source_version text not null,
 settings_digest text not null,defaults jsonb not null,
 recipe_owner_id uuid not null references auth.users(id),pool_namespace_id uuid not null references private.restitch_pool_namespaces(id),
 pool_user_id uuid,source_identity jsonb not null,pool_observations jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 foreign key(video_set_id,team_id) references private.catalog_video_sets(id,team_id) on delete cascade,
 foreign key(source_material_id,team_id) references public.team_materials(id,team_id),
 check(jsonb_typeof(defaults)='object' and octet_length(defaults::text)<=65536),
 check(jsonb_typeof(source_identity)='object' and octet_length(source_identity::text)<=8192),
 check(jsonb_typeof(pool_observations)='object' and octet_length(pool_observations::text)<=8192),
 unique(video_set_id,team_id)
);
create table private.catalog_video_restitch_candidates (
 video_set_id uuid not null,team_id uuid not null,slot text not null check(slot in('start','end')),
 version_id uuid not null references private.restitch_candidate_versions(id) on delete restrict,
 material_id uuid not null references public.team_materials(id) on delete restrict,
 ordinal integer not null check(ordinal between 1 and 500),
 size_bytes bigint not null check(size_bytes between 1 and 52428800),
 mime_type text not null check(mime_type in('image/jpeg','image/png','image/webp')),
 checksum text not null check(checksum~'^[a-f0-9]{32}$'),drive_version text not null,
 connection_id uuid not null,drive_file_id text not null,resource_key text,parent_folder_id text not null,root_folder_id text not null,
 primary key(video_set_id,slot,version_id),unique(video_set_id,slot,ordinal),
 foreign key(video_set_id,team_id) references private.catalog_video_restitch_contexts(video_set_id,team_id) on delete cascade
);
create table private.restitch_process_aliases (
 root_operation_id uuid primary key references public.team_operations(id) on delete restrict,
 video_set_id uuid not null,team_id uuid not null,actor_id uuid not null,
 video_variant_index integer not null,request_id uuid not null unique,
 source_material_id uuid not null,source_version text not null,settings_digest text not null,
 pool_namespace_id uuid not null references private.restitch_pool_namespaces(id),
 executor_id uuid not null,native_instance_id uuid not null,set_epoch bigint not null,workspace_epoch bigint not null,
 recovery_delegation_id uuid not null,recovery_delegation_version bigint not null,
 created_at timestamptz not null default clock_timestamp(),
 foreign key(video_set_id,team_id) references private.catalog_video_restitch_contexts(video_set_id,team_id),
 foreign key(video_set_id,video_variant_index) references private.catalog_video_variants(video_set_id,video_variant_index),
 foreign key(source_material_id,team_id) references public.team_materials(id,team_id),
 unique(video_set_id,video_variant_index)
);
alter table private.catalog_video_restitch_contexts enable row level security;
alter table private.catalog_video_restitch_contexts force row level security;
alter table private.catalog_video_restitch_candidates enable row level security;
alter table private.catalog_video_restitch_candidates force row level security;
alter table private.restitch_process_aliases enable row level security;
alter table private.restitch_process_aliases force row level security;
revoke all on private.catalog_video_restitch_contexts,private.catalog_video_restitch_candidates,private.restitch_process_aliases from public,anon,authenticated,service_role;
create trigger catalog_video_context_immutable before update on private.catalog_video_restitch_contexts for each row execute function private.restitch_candidate_version_immutable();
create trigger catalog_video_candidate_immutable before update on private.catalog_video_restitch_candidates for each row execute function private.restitch_candidate_version_immutable();
create trigger restitch_process_alias_immutable before update on private.restitch_process_aliases for each row execute function private.restitch_candidate_version_immutable();
create trigger task_cleanup_reference_fence before insert or update on private.catalog_video_restitch_contexts for each row execute function private.guard_task_cleanup_reference();
create trigger task_cleanup_reference_fence before insert or update on private.catalog_video_restitch_candidates for each row execute function private.guard_task_cleanup_reference();
create trigger task_cleanup_reference_fence before insert or update on private.restitch_process_aliases for each row execute function private.guard_task_cleanup_reference();

-- Process protocol roots require the immutable alias acceptance proof and retain
-- strict raw source-version equality. Manual download identity policy is unchanged.
create or replace function private.restitch_selection_source_matches(p_recipe jsonb,p_version text,p_kind text,p_material public.team_materials)
returns boolean language sql stable security definer set search_path='' as $fn$
 select coalesce(case when p_recipe ? 'selectionProtocol' then
  p_recipe->'selectionProtocol'='1'::jsonb
  and (p_material).kind='file' and (p_material).category='video'
  and (p_material).checksum is not null and (p_material).checksum~'^[0-9a-f]{32}$'
  and (p_material).size_bytes>0 and (p_material).mime_type is not null
  and p_recipe->'sourceIdentity'=jsonb_build_object('connectionId',(p_material).connection_id,
   'fileId',(p_material).drive_file_id,'checksum',(p_material).checksum,
   'mimeType',(p_material).mime_type,'sizeBytes',(p_material).size_bytes)
  and (p_kind='download' or (p_kind='process' and p_recipe->>'logicalKind'='process'
   and (p_material).drive_version is not distinct from p_version
   and exists(select 1 from private.restitch_process_aliases a
    where a.video_set_id::text=p_recipe->>'catalogVideoSetId'
     and a.video_variant_index::text=p_recipe->>'videoVariantIndex'
     and a.request_id::text=p_recipe->>'clientOperationId' and a.settings_digest=p_recipe->>'settingsDigest'
     and a.source_material_id=(p_material).id and a.team_id=(p_material).team_id and a.source_version=p_version)))
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
 if new.recipe->>'logicalKind'='process' and not exists(select 1 from private.restitch_process_aliases a where a.root_operation_id=new.root_operation_id and a.video_set_id=(new.recipe->>'catalogVideoSetId')::uuid and a.video_variant_index=(new.recipe->>'videoVariantIndex')::integer and a.request_id=(new.recipe->>'clientOperationId')::uuid and a.source_material_id=new.source_material_id and a.team_id=new.team_id and a.actor_id=new.actor_id) then raise exception 'WRONG_STATE' using errcode='55000';end if;
 -- Existing automated legacy preparations remain separate; only the exact
 -- new accepted alias proof above admits a protected protocol process root.
 if exists(select 1 from private.catalog_restitch_operations where operation_id=new.root_operation_id)
  or exists(select 1 from private.launch_restitch_preparations where operation_id=new.root_operation_id) then
  raise exception 'WRONG_STATE' using errcode='55000';end if;
 if o.kind='process' and not exists(select 1 from private.team_operation_intents where operation_id=o.id and team_id=new.team_id and tool_id='restitch') then
  raise exception 'WRONG_STATE' using errcode='55000';end if;
 return new;
end $fn$;

create or replace function private.freeze_restitch_selection_defaults(p_defaults jsonb,p_draw double precision)
returns jsonb language plpgsql immutable set search_path='' as $fn$
declare mode text;center_value integer;lo integer;hi integer;seconds integer;range_value jsonb;
begin
 if jsonb_typeof(p_defaults) is distinct from 'object' or p_draw is null or p_draw<0 or p_draw>1 then
  raise exception 'RESTITCH_INVALID' using errcode='22023';end if;
 mode:=p_defaults->>'finalDurationMode';
 range_value:=p_defaults->'finalDurationRangeSeconds';
 if range_value is not null then
  if mode is distinct from 'random-centered' or jsonb_typeof(range_value) is distinct from 'array' then raise exception 'RESTITCH_INVALID' using errcode='22023';end if;
  if jsonb_array_length(range_value)<>2 or exists(select 1 from jsonb_array_elements(range_value) x where jsonb_typeof(x) is distinct from 'number' or x::text !~ '^[0-9]+$') then raise exception 'RESTITCH_INVALID' using errcode='22023';end if;
  if (range_value->>0)::numeric not between 60 and 3600 or (range_value->>1)::numeric not between 60 and 3600 or mod((range_value->>0)::numeric,60)<>0 or mod((range_value->>1)::numeric,60)<>0 or (range_value->>0)::numeric>(range_value->>1)::numeric then raise exception 'RESTITCH_INVALID' using errcode='22023';end if;
 end if;
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
  if range_value is null then lo:=greatest(60,center_value-300);hi:=least(3600,center_value+300);
  else lo:=(range_value->>0)::integer;hi:=(range_value->>1)::integer;end if;
 elsif mode='random-30-40' then lo:=1800;hi:=2400;
 elsif mode='random-40-50' then lo:=2400;hi:=3000;
 elsif mode='random-50-60' then lo:=3000;hi:=3600;
 else raise exception 'RESTITCH_INVALID' using errcode='22023';end if;
 if mode<>'custom' then seconds:=lo+floor(least(0.999999999,p_draw)*(hi-lo+1))::integer;end if;
 if seconds is null then raise exception 'RESTITCH_INVALID' using errcode='22023';end if;
 return p_defaults||jsonb_build_object('finalDurationMode','custom','customFinalDurationSeconds',seconds);
end $fn$;
revoke all on function private.freeze_restitch_selection_defaults(jsonb,double precision) from public,anon,authenticated,service_role;

create function private.capture_catalog_video_restitch_context() returns trigger
language plpgsql security definer set search_path='' as $$
declare m public.team_materials%rowtype;ctx jsonb;settings jsonb;frozen_configuration jsonb;digest bytea;namespace_id uuid;
 selected_slot text;pool jsonb;entry jsonb;candidate uuid;ordinal_value integer;
begin
 settings:=new.settings_snapshot;
 if settings->'configured' is distinct from 'true'::jsonb or settings->>'sourceMode' is null or settings->>'sourceMode' not in('drive','legacy')
  or settings->>'operation' is null or settings->>'operation' not in('stitch','restitch','unstitch') then raise exception 'RESTITCH_INVALID' using errcode='22023';end if;
 -- Non-Drive and body-only processing use their separate existing capability.
 if settings->>'sourceMode'='legacy' or settings->>'operation'='unstitch' then return new;end if;
 if jsonb_typeof(settings->'startEnabled') is distinct from 'boolean' or jsonb_typeof(settings->'endEnabled') is distinct from 'boolean'
  or (settings->>'startEnabled'='false' and settings->>'endEnabled'='false') then raise exception 'RESTITCH_NO_SCREENS' using errcode='22023';end if;
 perform private.freeze_restitch_selection_defaults(settings,0.5); -- validate, never persist this probe draw
 if not private.can(new.team_id,'process',new.actor_id) or not private.can(new.team_id,'download',new.actor_id) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into m from public.team_materials where id=new.source_material_id and team_id=new.team_id for share;
 if m.id is null or m.lifecycle<>'active' or m.kind<>'file' or m.category is distinct from 'video'
  or m.drive_version is distinct from new.source_version or m.checksum is null or m.checksum!~'^[a-f0-9]{32}$'
  or m.size_bytes is null or m.size_bytes<1 or m.mime_type is null
  or not exists(select 1 from public.team_drive_connections d where d.id=m.connection_id and d.team_id=new.team_id and d.state='connected') then
  raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 if new.source_snapshot is null then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 if jsonb_typeof(new.source_snapshot) is distinct from 'object' or new.source_snapshot->>'materialId' is distinct from new.source_material_id::text
  or new.source_snapshot->>'teamId' is distinct from new.team_id::text or new.source_snapshot->>'actorId' is distinct from new.actor_id::text
  or new.source_snapshot->>'connectionId' is distinct from m.connection_id::text or new.source_snapshot->>'fileId' is distinct from m.drive_file_id
  or new.source_snapshot->>'version' is distinct from new.source_version or new.source_snapshot->>'checksum' is distinct from m.checksum
  or new.source_snapshot->>'mimeType' is distinct from m.mime_type or new.source_snapshot->'sizeBytes' is distinct from to_jsonb(m.size_bytes) then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 -- One statement captures pool scope, declarations and both bounded observations.
 select jsonb_build_object('poolUserId',private.launch_restitch_pool_user(new.team_id,new.actor_id),
  'recipeOwnerId',coalesce(private.launch_restitch_pool_user(new.team_id,new.actor_id),t.owner_id),
  'sources',coalesce((select jsonb_agg(jsonb_build_object('slot',s.slot,'kind',s.kind,'materialId',s.material_id,'fileId',s.drive_file_id)
   order by s.slot,s.kind,s.material_id,s.drive_file_id) from public.team_restitch_sources s where s.team_id=new.team_id
   and s.user_id is not distinct from private.launch_restitch_pool_user(new.team_id,new.actor_id)),'[]'::jsonb),
  'start',private.restitch_selection_pool_snapshot(new.team_id,private.launch_restitch_pool_user(new.team_id,new.actor_id),'start'),
  'end',private.restitch_selection_pool_snapshot(new.team_id,private.launch_restitch_pool_user(new.team_id,new.actor_id),'end'))
 into ctx from public.teams t where t.id=new.team_id;
 if ctx is null or octet_length(ctx::text)>2097152 or jsonb_array_length(ctx->'sources')>1000 then raise exception 'RESTITCH_SOURCES_TOO_MANY' using errcode='22023';end if;
 frozen_configuration:=jsonb_build_object('defaults',settings-'updatedAt'-'updatedBy'-'startImageIds'-'endImageIds',
  'sources',ctx->'sources','recipeOwnerId',ctx->'recipeOwnerId','poolUserId',ctx->'poolUserId');
 digest:=pg_catalog.sha256(pg_catalog.convert_to(frozen_configuration::text,'UTF8'));
 insert into private.restitch_pool_namespaces(team_id,actor_id,configuration,configuration_hash)
 values(new.team_id,new.actor_id,frozen_configuration,digest) on conflict(team_id,actor_id,configuration_hash) do nothing returning id into namespace_id;
 if namespace_id is null then select n.id into namespace_id from private.restitch_pool_namespaces n where n.team_id=new.team_id and n.actor_id=new.actor_id and n.configuration_hash=digest and n.configuration=frozen_configuration;end if;
 if namespace_id is null then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 insert into private.catalog_video_restitch_contexts(video_set_id,team_id,actor_id,source_material_id,source_version,settings_digest,defaults,recipe_owner_id,pool_namespace_id,pool_user_id,source_identity,pool_observations)
 values(new.id,new.team_id,new.actor_id,new.source_material_id,new.source_version,new.settings_digest,settings,(ctx->>'recipeOwnerId')::uuid,namespace_id,(ctx->>'poolUserId')::uuid,
  jsonb_build_object('connectionId',new.source_snapshot->'connectionId','fileId',new.source_snapshot->'fileId','checksum',new.source_snapshot->'checksum','mimeType',new.source_snapshot->'mimeType','sizeBytes',new.source_snapshot->'sizeBytes'),
  jsonb_build_object('start',(ctx->'start')-'candidates','end',(ctx->'end')-'candidates'));
 foreach selected_slot in array array['start','end'] loop
  if settings->>(selected_slot||'Enabled')='false' or (selected_slot='end' and settings->'automaticEndFrame'='true'::jsonb) then continue;end if;
  pool:=ctx->selected_slot;ordinal_value:=0;
  if pool->'complete' is distinct from 'true'::jsonb then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
  if jsonb_array_length(pool->'candidates')=0 then raise exception 'RESTITCH_NO_SCREENS' using errcode='55000';end if;
  for entry in select value from jsonb_array_elements(pool->'candidates') order by value->>'materialId' limit 500 loop
   candidate:=private.register_restitch_candidate_version(new.team_id,(entry->>'materialId')::uuid);
   if not exists(select 1 from private.restitch_candidate_versions v where v.id=candidate and v.team_id=new.team_id
    and v.connection_id=(entry->>'connectionId')::uuid and v.drive_file_id=entry->>'fileId' and v.checksum=entry->>'checksum'
    and v.mime_type=entry->>'mimeType' and v.size_bytes=(entry->>'sizeBytes')::bigint) then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
   ordinal_value:=ordinal_value+1;
   insert into private.catalog_video_restitch_candidates(video_set_id,team_id,slot,version_id,material_id,ordinal,size_bytes,mime_type,checksum,drive_version,connection_id,drive_file_id,resource_key,parent_folder_id,root_folder_id)
   values(new.id,new.team_id,selected_slot,candidate,(entry->>'materialId')::uuid,ordinal_value,(entry->>'sizeBytes')::bigint,entry->>'mimeType',entry->>'checksum',entry->>'driveVersion',(entry->>'connectionId')::uuid,entry->>'fileId',entry->>'resourceKey',entry->>'parentFolderId',entry->>'rootFolderId');
  end loop;
 end loop;
 return new;
end;
$$;
revoke all on function private.capture_catalog_video_restitch_context() from public,anon,authenticated,service_role;
create trigger catalog_video_restitch_capture after insert on private.catalog_video_sets for each row execute function private.capture_catalog_video_restitch_context();

create function public.service_accept_catalog_video_restitch_alias(
 p_set uuid,p_hash bytea,p_native uuid,p_protocol integer,p_index integer,p_request uuid,p_operation uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare authority jsonb;s private.catalog_video_sets%rowtype;v private.catalog_video_variants%rowtype;
 o public.team_operations%rowtype;i private.team_operation_intents%rowtype;c private.catalog_video_restitch_contexts%rowtype;
 a private.restitch_process_aliases%rowtype;seed uuid;selected_slot text;
begin
 authority:=public.service_authorize_catalog_video_executor(p_set,p_hash,p_native,p_protocol);
 select * into s from private.catalog_video_sets where id=p_set for update;
 select * into v from private.catalog_video_variants where video_set_id=p_set and video_variant_index=p_index;
 select * into o from public.team_operations where id=p_operation for update;
 select * into i from private.team_operation_intents where operation_id=p_operation and team_id=s.team_id;
 select * into c from private.catalog_video_restitch_contexts where video_set_id=p_set;
 if not private.can(s.team_id,'upload',s.actor_id) or not private.can(s.team_id,'download',s.actor_id) or not private.can(s.team_id,'process',s.actor_id) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if c.video_set_id is null then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 if s.state not in('accepted','preparing') or v.state is distinct from 'working' or v.request_id is distinct from p_request
  or v.operation_id is distinct from p_operation or o.id is null or o.team_id is distinct from s.team_id or o.actor_id is distinct from s.actor_id
  or o.kind is distinct from 'process' or o.state not in('pending','running') or o.source_material_id is distinct from s.source_material_id
  or o.idempotency_key is distinct from 'catalog-variant:'||p_request::text or i.tool_id is distinct from 'restitch'
  or i.expected_source_version is distinct from c.source_version or i.expected_source_drive_file_id is distinct from c.source_identity->>'fileId'
  or i.expected_source_checksum is distinct from c.source_identity->>'checksum' or s.settings_snapshot is distinct from c.defaults
  or s.settings_digest is distinct from c.settings_digest or s.source_version is distinct from c.source_version
  or s.actor_id is distinct from c.actor_id or s.team_id is distinct from c.team_id then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
 select * into a from private.restitch_process_aliases where root_operation_id=p_operation;
 if a.root_operation_id is not null then
  if a.video_set_id is distinct from p_set or a.video_variant_index is distinct from p_index or a.request_id is distinct from p_request
   or a.native_instance_id is distinct from p_native or a.set_epoch is distinct from s.epoch then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
  if not exists(select 1 from private.restitch_selection_roots where root_operation_id=p_operation) then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
  return private.restitch_selection_root_descriptor(p_operation,true);
 end if;
 if exists(select 1 from private.restitch_selection_roots where root_operation_id=p_operation) then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 -- The existing strict process-source policy is not replaced with manual
 -- download metadata leniency, even for checksum-identical version changes.
 if not exists(select 1 from public.team_materials m where m.id=c.source_material_id and m.team_id=c.team_id
  and m.lifecycle='active' and m.drive_version=c.source_version and m.drive_file_id=c.source_identity->>'fileId'
  and m.connection_id=(c.source_identity->>'connectionId')::uuid and m.checksum=c.source_identity->>'checksum'
  and m.mime_type=c.source_identity->>'mimeType' and m.size_bytes=(c.source_identity->>'sizeBytes')::bigint) then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;

 insert into private.restitch_process_aliases(root_operation_id,video_set_id,team_id,actor_id,video_variant_index,request_id,source_material_id,source_version,settings_digest,pool_namespace_id,executor_id,native_instance_id,set_epoch,workspace_epoch,recovery_delegation_id,recovery_delegation_version)
 values(p_operation,p_set,s.team_id,s.actor_id,p_index,p_request,c.source_material_id,c.source_version,c.settings_digest,c.pool_namespace_id,s.executor_id,p_native,s.epoch,s.workspace_epoch,s.recovery_delegation_id,s.recovery_delegation_version);
 seed:=gen_random_uuid();
 insert into private.restitch_selection_roots(root_operation_id,team_id,actor_id,source_material_id,source_version,recipe_owner_id,pool_namespace_id,recipe)
 values(p_operation,c.team_id,c.actor_id,c.source_material_id,c.source_version,c.recipe_owner_id,c.pool_namespace_id,
  jsonb_build_object('schemaVersion',1,'selectionProtocol',1,'logicalKind','process','catalogVideoSetId',p_set,'videoVariantIndex',p_index,'settingsDigest',c.settings_digest,'recipeRevision',s.recipe_revision,
   'seed',seed,'clientOperationId',p_request,'defaults',private.freeze_restitch_selection_defaults(c.defaults,random()),
   'sourceIdentity',c.source_identity,'poolUserId',c.pool_user_id,'poolObservations',c.pool_observations));
 foreach selected_slot in array array['start','end'] loop
  insert into private.restitch_selection_candidates(root_operation_id,slot,version_id,material_id,ordinal,size_bytes,mime_type,checksum,drive_version,connection_id,drive_file_id,resource_key,parent_folder_id,root_folder_id)
  select p_operation,slot,version_id,material_id,row_number() over(order by md5(seed::text||selected_slot||material_id::text),material_id)::integer,size_bytes,mime_type,checksum,drive_version,connection_id,drive_file_id,resource_key,parent_folder_id,root_folder_id
   from private.catalog_video_restitch_candidates where video_set_id=p_set and slot=selected_slot;
  update private.restitch_selection_slots set snapshot_complete=(c.pool_observations->selected_slot->>'complete')::boolean where root_operation_id=p_operation and slot=selected_slot;
 end loop;
 return private.restitch_selection_root_descriptor(p_operation,false);
end;
$$;
revoke all on function public.service_accept_catalog_video_restitch_alias(uuid,bytea,uuid,integer,integer,uuid,uuid) from public,anon,authenticated;
grant execute on function public.service_accept_catalog_video_restitch_alias(uuid,bytea,uuid,integer,integer,uuid,uuid) to service_role;

-- Process controls derive authority from the existing delegated catalog claim,
-- never from an invented browser session. Exactly one authority mode is stored.
alter table private.restitch_native_controls add column auth_mode text not null default 'browser_session',
 add column process_alias_id uuid references private.restitch_process_aliases(root_operation_id);
alter table private.restitch_native_controls alter column session_id drop not null;
alter table private.restitch_native_controls add constraint restitch_control_auth_mode check (
 (auth_mode='browser_session' and session_id is not null and process_alias_id is null)
 or (auth_mode='catalog_process' and session_id is null and process_alias_id is not null and process_alias_id=root_operation_id)
);
create function private.require_catalog_restitch_alias(p_root uuid,p_team uuid,p_actor uuid,p_native uuid,p_live boolean)
returns private.restitch_process_aliases language plpgsql security definer set search_path='' as $$
declare a private.restitch_process_aliases%rowtype;s private.catalog_video_sets%rowtype;
begin
 select * into a from private.restitch_process_aliases where root_operation_id=p_root;
 if a.root_operation_id is null or a.team_id is distinct from p_team or a.actor_id is distinct from p_actor
  or (p_native is not null and a.native_instance_id is distinct from p_native) then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 if not p_live then return a;end if;
 -- Read current parent authority before every new I/O. Do not acquire a parent
 -- set lock after the operation lock: set acceptance/claim locks in the opposite
 -- direction. An already admitted request remains owned until exact settlement.
 select * into s from private.catalog_video_sets where id=a.video_set_id;
 if s.id is null or s.team_id is distinct from a.team_id or s.actor_id is distinct from a.actor_id
  or s.state not in('accepted','preparing') or s.executor_id is distinct from a.executor_id or s.epoch is distinct from a.set_epoch
  or s.native_instance_id is distinct from a.native_instance_id or s.workspace_epoch is distinct from a.workspace_epoch
  or s.recovery_delegation_id is distinct from a.recovery_delegation_id or s.recovery_delegation_version is distinct from a.recovery_delegation_version
  or s.workspace_epoch is distinct from (select coalesce(max(epoch),0) from private.workspace_pauses where team_id=a.team_id) then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if not private.can(a.team_id,'process',a.actor_id) or not private.can(a.team_id,'download',a.actor_id) or not private.can(a.team_id,'upload',a.actor_id) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if not exists(select 1 from private.team_recovery_delegations d where d.id=a.recovery_delegation_id
  and d.team_id=a.team_id and d.actor_id=a.actor_id and d.installation_id=a.executor_id and d.version=a.recovery_delegation_version
  and d.revoked_at is null and d.expires_at>clock_timestamp()) then raise exception 'AUTH_REQUIRED' using errcode='42501';end if;
 return a;
end;
$$;
revoke all on function private.require_catalog_restitch_alias(uuid,uuid,uuid,uuid,boolean) from public,anon,authenticated,service_role;
create function private.require_restitch_control_auth(g private.restitch_native_controls,p_live boolean)
returns void language plpgsql security definer set search_path='' as $$
begin
 if g.auth_mode='browser_session' then
  if g.session_id is null or g.process_alias_id is not null or not exists(select 1 from public.team_operations o where o.id=g.root_operation_id and o.team_id=g.team_id and o.actor_id=g.actor_id and o.kind='download') then raise exception 'WRONG_STATE' using errcode='55000';end if;
  if p_live then perform private.require_restitch_control_session(g.session_id,g.actor_id);end if;
 elsif g.auth_mode='catalog_process' then
  if g.session_id is not null or g.process_alias_id is distinct from g.root_operation_id or not exists(select 1 from public.team_operations o where o.id=g.root_operation_id and o.team_id=g.team_id and o.actor_id=g.actor_id and o.kind='process') then raise exception 'WRONG_STATE' using errcode='55000';end if;
  perform private.require_catalog_restitch_alias(g.root_operation_id,g.team_id,g.actor_id,g.native_instance_id,p_live);
 else raise exception 'AUTH_REQUIRED' using errcode='42501';end if;
end;
$$;
revoke all on function private.require_restitch_control_auth(private.restitch_native_controls,boolean) from public,anon,authenticated,service_role;
create function private.guard_restitch_control_auth_mode() returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform private.require_restitch_control_auth(new,true);
 return new;
end;
$$;
revoke all on function private.guard_restitch_control_auth_mode() from public,anon,authenticated,service_role;
create trigger restitch_control_auth_binding before insert on private.restitch_native_controls for each row execute function private.guard_restitch_control_auth_mode();

alter function private.require_restitch_executor(uuid,uuid,uuid,uuid,bigint,boolean) rename to require_restitch_executor_before_process_alias;
revoke all on function private.require_restitch_executor_before_process_alias(uuid,uuid,uuid,uuid,bigint,boolean) from public,anon,authenticated,service_role;
create function private.require_restitch_executor(p_root uuid,p_team uuid,p_actor uuid,p_executor uuid,p_epoch bigint,p_claim boolean default false)
returns void language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from private.restitch_process_aliases where root_operation_id=p_root) then
  perform private.require_catalog_restitch_alias(p_root,p_team,p_actor,null,true);
 end if;
 perform private.require_restitch_executor_before_process_alias(p_root,p_team,p_actor,p_executor,p_epoch,p_claim);
end;
$$;
revoke all on function private.require_restitch_executor(uuid,uuid,uuid,uuid,bigint,boolean) from public,anon,authenticated,service_role;
create function private.guard_restitch_process_claim() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from private.restitch_process_aliases a where a.root_operation_id=new.root_operation_id and a.native_instance_id is distinct from new.native_instance_id) then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
 return new;
end;
$$;
revoke all on function private.guard_restitch_process_claim() from public,anon,authenticated,service_role;
create trigger restitch_process_claim_binding before insert on private.restitch_selection_executor_claims for each row execute function private.guard_restitch_process_claim();

create function public.service_issue_catalog_video_restitch_control(
 p_set uuid,p_hash bytea,p_native uuid,p_protocol integer,p_index integer,p_request uuid,p_operation uuid,
 p_grant uuid,p_enrollment uuid,p_proof_hash bytea,p_ticket_hash bytea
) returns jsonb language plpgsql security definer set search_path='' as $$
declare authority jsonb;a private.restitch_process_aliases%rowtype;g private.restitch_native_controls%rowtype;t timestamptz;expiry timestamptz;
begin
 if p_grant is null or p_enrollment is null or p_proof_hash is null or octet_length(p_proof_hash)<>32 or p_ticket_hash is null or octet_length(p_ticket_hash)<>32 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 authority:=public.service_authorize_catalog_video_executor(p_set,p_hash,p_native,p_protocol);
 a:=private.require_catalog_restitch_alias(p_operation,(authority->>'teamId')::uuid,(authority->>'actorId')::uuid,p_native,true);
 if a.video_set_id is distinct from p_set or a.video_variant_index is distinct from p_index or a.request_id is distinct from p_request then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
 perform 1 from public.team_operations where id=p_operation for update;
 perform private.require_restitch_executor(p_operation,a.team_id,a.actor_id,null,null,true);
 select * into g from private.restitch_native_controls where id=p_grant or enrollment_id=p_enrollment for update;
 if g.id is not null then
  if (g.id,g.root_operation_id,g.team_id,g.actor_id,g.native_instance_id,g.enrollment_id,g.proof_hash,g.token_hash,g.auth_mode,g.process_alias_id)
   is distinct from (p_grant,p_operation,a.team_id,a.actor_id,p_native,p_enrollment,p_proof_hash,p_ticket_hash,'catalog_process'::text,p_operation) then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
  return private.restitch_native_control_receipt(g);
 end if;
 if (select count(*) from private.restitch_native_controls where root_operation_id=p_operation)>=8 then raise exception 'RATE_LIMITED' using errcode='55000';end if;
 t:=clock_timestamp();
 select least(expires_at,t+interval '24 hours') into expiry from private.team_recovery_delegations where id=a.recovery_delegation_id;
 if expiry is null or expiry<=t+interval '2 minutes' then raise exception 'AUTH_REQUIRED' using errcode='42501';end if;
 insert into private.restitch_native_controls(id,root_operation_id,team_id,actor_id,session_id,enrollment_id,native_instance_id,proof_hash,token_hash,created_at,challenge_until,expires_at,auth_mode,process_alias_id)
 values(p_grant,p_operation,a.team_id,a.actor_id,null,p_enrollment,p_native,p_proof_hash,p_ticket_hash,t,t+interval '2 minutes',expiry,'catalog_process',p_operation) returning * into g;
 return private.restitch_native_control_receipt(g);
end;
$$;
revoke all on function public.service_issue_catalog_video_restitch_control(uuid,bytea,uuid,integer,integer,uuid,uuid,uuid,uuid,bytea,bytea) from public,anon,authenticated;
grant execute on function public.service_issue_catalog_video_restitch_control(uuid,bytea,uuid,integer,integer,uuid,uuid,uuid,uuid,bytea,bytea) to service_role;

create or replace function private.restitch_native_control_scope(p_grant uuid,p_hash bytea,p_active boolean)
returns private.restitch_native_controls language plpgsql security definer set search_path='' as $fn$
declare g private.restitch_native_controls%rowtype;
begin
 select * into g from private.restitch_native_controls where id=p_grant;
 if g.id is null then raise exception 'AUTH_REQUIRED' using errcode='42501';end if;
 -- Same parent-first lock order as claims, reservations, cancellation and closure.
 perform 1 from public.team_operations where id=g.root_operation_id for update;
 select * into g from private.restitch_native_controls where id=p_grant for update;
 if g.id is null or p_hash is null or g.token_hash is distinct from p_hash or g.redeemed_at is null then
  raise exception 'AUTH_REQUIRED' using errcode='42501';end if;
 perform private.require_restitch_control_auth(g,false);
 if p_active then
  if g.expires_at<=clock_timestamp() then raise exception 'EXPIRED' using errcode='55000';end if;
  perform private.require_restitch_control_auth(g,true);
  perform private.require_restitch_executor(g.root_operation_id,g.team_id,g.actor_id,null,null,true);
 end if;
 return g;
end $fn$;

create or replace function public.service_redeem_restitch_native_control(p_grant uuid,p_proof_hash bytea)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare g private.restitch_native_controls%rowtype;
begin
 select * into g from private.restitch_native_controls where id=p_grant;
 if g.id is null then raise exception 'AUTH_REQUIRED' using errcode='42501';end if;
 perform 1 from public.team_operations where id=g.root_operation_id for update;
 select * into g from private.restitch_native_controls where id=p_grant for update;
 if g.id is null or p_proof_hash is null or g.proof_hash is distinct from p_proof_hash then
  raise exception 'AUTH_REQUIRED' using errcode='42501';end if;
 if g.expires_at<=clock_timestamp() or (g.redeemed_at is null and g.challenge_until<=clock_timestamp()) then
  raise exception 'EXPIRED' using errcode='55000';end if;
 perform private.require_restitch_control_auth(g,true);
 perform private.require_restitch_executor(g.root_operation_id,g.team_id,g.actor_id,null,null,true);
 if g.redeemed_at is null then
  update private.restitch_native_controls set redeemed_at=clock_timestamp() where id=g.id returning * into g;
 end if;
 return private.restitch_native_control_receipt(g);
end $fn$;

create or replace function public.service_issue_restitch_native_control(p_root uuid,p_team uuid,p_actor uuid,
 p_session uuid,p_grant uuid,p_enrollment uuid,p_native uuid,p_proof_hash bytea,p_ticket_hash bytea)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare g private.restitch_native_controls%rowtype;t timestamptz;
begin
 if not exists(select 1 from public.team_operations o where o.id=p_root and o.team_id=p_team and o.actor_id=p_actor and o.kind='download') then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if p_session is null or p_grant is null or p_enrollment is null or p_native is null
  or p_proof_hash is null or octet_length(p_proof_hash)<>32
  or p_ticket_hash is null or octet_length(p_ticket_hash)<>32 then
  raise exception 'INVALID_INPUT' using errcode='22023';end if;
 perform 1 from public.team_operations where id=p_root for update;
 perform private.require_restitch_executor(p_root,p_team,p_actor,null,null,true);
 perform private.require_restitch_control_session(p_session,p_actor);
 select * into g from private.restitch_native_controls where id=p_grant or enrollment_id=p_enrollment for update;
 if g.id is not null then
  if (g.id,g.root_operation_id,g.team_id,g.actor_id,g.session_id,g.enrollment_id,g.native_instance_id,g.proof_hash,g.token_hash)
   is distinct from (p_grant,p_root,p_team,p_actor,p_session,p_enrollment,p_native,p_proof_hash,p_ticket_hash) then
   raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
  return private.restitch_native_control_receipt(g);
 end if;
 if (select count(*) from private.restitch_native_controls where root_operation_id=p_root)>=8 then
  raise exception 'RATE_LIMITED' using errcode='55000';end if;
 t:=clock_timestamp();
 insert into private.restitch_native_controls(id,root_operation_id,team_id,actor_id,session_id,
  enrollment_id,native_instance_id,proof_hash,token_hash,created_at,challenge_until,expires_at)
 values(p_grant,p_root,p_team,p_actor,p_session,p_enrollment,p_native,p_proof_hash,p_ticket_hash,t,t+interval '2 minutes',t+interval '24 hours') returning * into g;
 return private.restitch_native_control_receipt(g);
exception when unique_violation then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';
end $fn$;

-- Manual local-save completion keeps its old terminal behavior. A process alias
-- can only close selection accounting AFTER canonical upload/finalization; it
-- never writes the process operation's state or substitutes a local saved path.
alter function public.service_finish_restitch_native_control(uuid,bytea,uuid,uuid,text) rename to service_finish_restitch_native_control_before_process_alias;
revoke all on function public.service_finish_restitch_native_control_before_process_alias(uuid,bytea,uuid,uuid,text) from public,anon,authenticated,service_role;
create function public.service_finish_restitch_native_control(p_grant uuid,p_ticket_hash bytea,p_claim uuid,p_quiescence uuid,p_outcome text)
returns boolean language plpgsql security definer set search_path='' as $$
declare g private.restitch_native_controls%rowtype;c private.restitch_selection_executor_claims%rowtype;
 e private.restitch_selection_executors%rowtype;o public.team_operations%rowtype;
 a private.restitch_process_aliases%rowtype;
begin
 g:=private.restitch_native_control_scope(p_grant,p_ticket_hash,false);
 if g.auth_mode='browser_session' then return public.service_finish_restitch_native_control_before_process_alias(p_grant,p_ticket_hash,p_claim,p_quiescence,p_outcome);end if;
 if p_claim is null or p_quiescence is null or p_outcome is null or p_outcome not in('delivered','failed','canceled') then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 a:=private.require_catalog_restitch_alias(g.root_operation_id,g.team_id,g.actor_id,g.native_instance_id,false);
 if g.claim_id is distinct from p_claim then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
 select * into o from public.team_operations where id=g.root_operation_id;
 select * into c from private.restitch_selection_executor_claims where root_operation_id=g.root_operation_id and claim_id=p_claim;
 select * into e from private.restitch_selection_executors where root_operation_id=g.root_operation_id for update;
 if o.kind is distinct from 'process' or o.state not in('succeeded','failed','canceled') or c.claim_id is null
  or c.native_instance_id is distinct from g.native_instance_id or e.epoch is distinct from c.epoch
  or (e.state='owned' and e.executor_id is distinct from c.executor_id) or e.state not in('owned','quiescent') then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 if c.terminal_outcome is not null and c.terminal_outcome<>p_outcome then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
 if p_outcome='delivered' and (o.state<>'succeeded' or o.result_material_id is null or not exists(
  select 1 from public.team_materials m join private.team_operation_intents i on i.operation_id=o.id and i.team_id=o.team_id
   where m.id=o.result_material_id and m.team_id=o.team_id and i.tool_id='restitch' and i.provider_result_id=m.drive_file_id)) then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 if (select count(*) from private.restitch_selection_slots where root_operation_id=g.root_operation_id)<>2 then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 if p_outcome='delivered' and exists(
  select 1 from private.restitch_selection_slots slot join private.restitch_selection_roots root on root.root_operation_id=slot.root_operation_id
  where slot.root_operation_id=g.root_operation_id and coalesce(root.recipe->'defaults'->>(slot.slot||'Enabled'),'true')='true'
   and not(slot.slot='end' and coalesce(root.recipe->'defaults'->'automaticEndFrame','false'::jsonb)='true'::jsonb)
   and (slot.budget->>'acceptedVersionId' is null or not exists(select 1 from jsonb_array_elements(slot.budget->'candidates') candidate
    where candidate->>'versionId'=slot.budget->>'acceptedVersionId' and candidate->>'rejected'='false' and candidate->'validatedAcquisition'=candidate->'acquisition'))
 ) then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 if public.service_quiesce_restitch_native_control(p_grant,p_ticket_hash,p_claim,p_quiescence) is distinct from true then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 update private.restitch_selection_executor_claims set terminal_outcome=p_outcome where root_operation_id=g.root_operation_id and claim_id=p_claim and terminal_outcome is null;
 return true;
end;
$$;
revoke all on function public.service_finish_restitch_native_control(uuid,bytea,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.service_finish_restitch_native_control(uuid,bytea,uuid,uuid,text) to service_role;
