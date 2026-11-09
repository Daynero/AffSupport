-- Private, inactive US4 authority. No browser grant or provider writer activation.
begin;
alter table public.team_catalog_update_attempts add constraint catalog_video_attempt_team_key unique(attempt_id,team_id);
create table private.catalog_video_sets (
 id uuid primary key, team_id uuid not null references public.teams(id), actor_id uuid not null references auth.users(id),
 catalog_material_id uuid, catalog_intent_id uuid, update_attempt_id uuid,
 source_material_id uuid not null, source_version text not null check(length(source_version) between 1 and 1024),
 source_snapshot jsonb, settings_snapshot jsonb not null check(jsonb_typeof(settings_snapshot)='object'), settings_digest text not null check(settings_digest ~ '^[a-f0-9]{64}$'),
 requested_count integer not null, product_count integer not null check(product_count between 1 and 400),
 recipe_revision bigint not null check(recipe_revision>0), assignment_seed text not null check(assignment_seed ~ '^[a-f0-9]{64}$'), assignment_version integer not null check(assignment_version=1),
 state text not null default 'accepted' check(state in('accepted','preparing','ready','cancel_requested','canceled','unknown')),
 revision bigint not null default 0 check(revision>=0), executor_id uuid, epoch bigint not null default 0 check(epoch>=0),
 recovery_delegation_id uuid, recovery_delegation_version bigint, native_instance_id uuid, workspace_epoch bigint not null default 0,
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 check(requested_count between 1 and product_count), check(num_nonnulls(catalog_intent_id,update_attempt_id)=1),
 unique(id,team_id), unique(id,team_id,recipe_revision), unique(catalog_intent_id),unique(update_attempt_id),
 foreign key(source_material_id,team_id) references public.team_materials(id,team_id),
 foreign key(catalog_material_id,team_id) references public.team_materials(id,team_id),
 foreign key(catalog_intent_id,team_id) references private.catalog_generation_intents(id,team_id),
 foreign key(update_attempt_id,team_id) references public.team_catalog_update_attempts(attempt_id,team_id)
);
create table private.catalog_video_variants (
 video_set_id uuid not null,team_id uuid not null, video_variant_index integer not null check(video_variant_index between 0 and 399),
 request_id uuid not null unique,dispatch_credential_hash bytea check(dispatch_credential_hash is null or octet_length(dispatch_credential_hash)=32), operation_id uuid unique references public.team_operations(id), grant_refreshes integer not null default 0 check(grant_refreshes between 0 and 2), state text not null default 'queued' check(state in('queued','working','unknown','registered')),
 output_material_id uuid, primary key(video_set_id,video_variant_index), unique(video_set_id,output_material_id),
 foreign key(video_set_id,team_id) references private.catalog_video_sets(id,team_id),
 foreign key(output_material_id,team_id) references public.team_materials(id,team_id),
 check((state='registered')=(output_material_id is not null))
);
create table private.catalog_video_set_recipes (
 video_set_id uuid not null,team_id uuid not null,recipe_revision bigint not null check(recipe_revision>0),
 product_count integer not null check(product_count between 1 and 400),assignment_seed text not null check(assignment_seed ~ '^[a-f0-9]{64}$'),assignment_version integer not null check(assignment_version=1),created_at timestamptz not null default clock_timestamp(),
 primary key(video_set_id,team_id,recipe_revision),foreign key(video_set_id,team_id) references private.catalog_video_sets(id,team_id)
);
create table private.catalog_video_recipe_references (
 video_set_id uuid not null,team_id uuid not null,recipe_revision bigint not null,catalog_material_id uuid,catalog_intent_id uuid,update_attempt_id uuid,actor_id uuid not null references auth.users(id),created_at timestamptz not null default clock_timestamp(),
 id uuid primary key default gen_random_uuid(),unique(catalog_intent_id),unique(update_attempt_id),check(num_nonnulls(catalog_intent_id,update_attempt_id)=1),
 foreign key(video_set_id,team_id,recipe_revision) references private.catalog_video_set_recipes(video_set_id,team_id,recipe_revision),
 foreign key(catalog_material_id,team_id) references public.team_materials(id,team_id),foreign key(catalog_intent_id,team_id) references private.catalog_generation_intents(id,team_id),foreign key(update_attempt_id,team_id) references public.team_catalog_update_attempts(attempt_id,team_id)
);
create function private.initialize_catalog_video_recipe() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into private.catalog_video_set_recipes(video_set_id,team_id,recipe_revision,product_count,assignment_seed,assignment_version) values(new.id,new.team_id,new.recipe_revision,new.product_count,new.assignment_seed,new.assignment_version);
 insert into private.catalog_video_recipe_references(video_set_id,team_id,recipe_revision,catalog_material_id,catalog_intent_id,update_attempt_id,actor_id) values(new.id,new.team_id,new.recipe_revision,new.catalog_material_id,new.catalog_intent_id,new.update_attempt_id,new.actor_id);
 return new;
end;$$;
create trigger catalog_video_initial_recipe after insert on private.catalog_video_sets for each row execute function private.initialize_catalog_video_recipe();
alter table private.catalog_video_set_recipes enable row level security;alter table private.catalog_video_set_recipes force row level security;
alter table private.catalog_video_recipe_references enable row level security;alter table private.catalog_video_recipe_references force row level security;
revoke all on private.catalog_video_set_recipes,private.catalog_video_recipe_references from public,anon,authenticated,service_role;
revoke all on function private.initialize_catalog_video_recipe() from public,anon,authenticated,service_role;
create table private.catalog_video_assignments (
 video_set_id uuid not null,team_id uuid not null,recipe_revision bigint not null,recipe_row_id uuid not null, video_variant_index integer not null,
 primary key(video_set_id,recipe_revision,recipe_row_id),
 foreign key(video_set_id,team_id,recipe_revision) references private.catalog_video_set_recipes(video_set_id,team_id,recipe_revision),
 foreign key(video_set_id,video_variant_index) references private.catalog_video_variants(video_set_id,video_variant_index)
);
alter table private.catalog_video_sets enable row level security;
alter table private.catalog_video_sets force row level security;
alter table private.catalog_video_variants enable row level security;
alter table private.catalog_video_variants force row level security;
alter table private.catalog_video_assignments enable row level security;
alter table private.catalog_video_assignments force row level security;
revoke all on private.catalog_video_sets,private.catalog_video_variants,private.catalog_video_assignments from public,anon,authenticated,service_role;

create function private.catalog_video_snapshot(s private.catalog_video_sets) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('setId',s.id,'revision',s.revision,'children',coalesce((select jsonb_agg(jsonb_build_object('index',v.video_variant_index,'requestId',v.request_id,'operationId',v.operation_id,'state',v.state,'outputId',v.output_material_id) order by v.video_variant_index) from private.catalog_video_variants v where v.video_set_id=s.id),'[]'::jsonb));
$$;
create function private.catalog_video_recipe_consumer_allowed(p_set uuid,p_team uuid,p_recipe bigint,p_catalog uuid,p_actor uuid) returns boolean language sql stable security definer set search_path='' as $$
 select coalesce(private.can(p_team,'view',p_actor),false) and coalesce(private.can(p_team,'process',p_actor),false) and exists(
 select 1 from private.catalog_video_recipe_references r where r.video_set_id=p_set and r.team_id=p_team and r.recipe_revision=p_recipe and r.actor_id=p_actor and (
 r.catalog_material_id=p_catalog or exists(select 1 from public.team_catalog_update_attempts a where a.attempt_id=r.update_attempt_id and a.team_id=p_team and a.catalog_material_id=p_catalog) or exists(select 1 from private.catalog_generation_intents i where i.id=r.catalog_intent_id and i.team_id=p_team and i.state='registered' and (i.checkpoint->>'materialId'=p_catalog::text or i.result#>>'{catalog,materialId}'=p_catalog::text))));
$$;
revoke all on function private.catalog_video_recipe_consumer_allowed(uuid,uuid,bigint,uuid,uuid) from public,anon,authenticated,service_role;
create function public.service_read_catalog_video_acceptance(p_set uuid,p_team uuid,p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare s private.catalog_video_sets%rowtype;
begin
 if private.can(p_team,'view',p_actor) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into s from private.catalog_video_sets where id=p_set and team_id=p_team;
 if s.id is null then return null;end if;
 if s.actor_id is distinct from p_actor then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 return jsonb_build_object('snapshot',private.catalog_video_snapshot(s),'parentState',s.state,'source',s.source_snapshot,'settingsDigest',s.settings_digest,'catalogIntentId',s.catalog_intent_id,'updateAttemptId',s.update_attempt_id,'assignment',jsonb_build_object('algorithmVersion',s.assignment_version,'recipeRevision',s.recipe_revision,'variantCount',s.requested_count,'productCount',s.product_count,'seed',s.assignment_seed,'assignments',(select jsonb_agg(jsonb_build_object('recipeRowId',a.recipe_row_id,'videoVariantIndex',a.video_variant_index) order by a.recipe_row_id) from private.catalog_video_assignments a where a.video_set_id=s.id and a.recipe_revision=s.recipe_revision)));
end;$$;
revoke all on function public.service_read_catalog_video_acceptance(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.service_read_catalog_video_acceptance(uuid,uuid,uuid) to service_role;
create function public.service_read_catalog_video_set(p_set uuid,p_team uuid,p_actor uuid,p_executor uuid,p_epoch bigint) returns jsonb language plpgsql security definer set search_path='' as $$
declare s private.catalog_video_sets%rowtype;
begin
 select * into s from private.catalog_video_sets where id=p_set and team_id=p_team;
 if s.id is null or s.actor_id is distinct from p_actor or private.can(p_team,'view',p_actor) is not true or s.executor_id is distinct from p_executor or s.epoch is distinct from p_epoch then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 return private.catalog_video_snapshot(s);
end;$$;
-- Only a trusted provider-proof factory calls this CAS. No browser-observed
-- metadata can refresh a source or overwrite a newer synchronized version.
create function public.service_capture_catalog_video_source(p_material uuid,p_team uuid,p_actor uuid,p_expected_connection uuid,p_expected_file text,p_expected_version text,p_observed jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.team_materials%rowtype;version text;checksum text;bytes bigint;mime text;
begin
 if p_actor is null or private.can(p_team,'view',p_actor) is not true or private.can(p_team,'process',p_actor) is not true or private.can(p_team,'upload',p_actor) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if p_observed is null or jsonb_typeof(p_observed)<>'object' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 version:=p_observed->>'version';checksum:=p_observed->>'checksum';bytes:=(p_observed->>'sizeBytes')::bigint;mime:=p_observed->>'mimeType';
 if p_expected_connection is null or p_expected_file is null or p_observed->>'fileId' is distinct from p_expected_file or version is null or length(version) not between 1 and 1024 or checksum is null or checksum !~ '^[a-fA-F0-9]{32}$|^[a-fA-F0-9]{64}$' or bytes is null or bytes<=0 or mime is null or length(mime)>255 or (mime !~ '^video/[A-Za-z0-9.+_-]+$' and mime<>'application/octet-stream') then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select * into m from public.team_materials where id=p_material and team_id=p_team for update;
 if m.id is null or m.lifecycle<>'active' or m.kind<>'file' or m.connection_id is distinct from p_expected_connection or m.drive_file_id is distinct from p_expected_file then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 if m.drive_version is distinct from p_expected_version and (m.drive_version,m.checksum,m.size_bytes,m.mime_type) is distinct from (version,lower(checksum),bytes,mime) then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 if (m.drive_version,m.checksum,m.size_bytes,m.mime_type) is distinct from (version,lower(checksum),bytes,mime) then update public.team_materials set drive_version=version,checksum=lower(checksum),size_bytes=bytes,mime_type=mime,updated_at=clock_timestamp() where id=m.id;end if;
 return jsonb_build_object('materialId',m.id,'teamId',m.team_id,'actorId',p_actor,'connectionId',m.connection_id,'fileId',p_expected_file,'version',version,'checksum',lower(checksum),'sizeBytes',bytes,'mimeType',mime);
end;$$;
revoke all on function public.service_capture_catalog_video_source(uuid,uuid,uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.service_capture_catalog_video_source(uuid,uuid,uuid,uuid,text,text,jsonb) to service_role;
create function public.service_accept_catalog_video_set(p_team uuid,p_actor uuid,p_executor uuid,p_payload jsonb,p_children jsonb,p_assignments jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare s private.catalog_video_sets%rowtype;source public.team_materials%rowtype;set_id uuid;intent uuid;attempt uuid;cnt integer;products integer;recipe bigint;c jsonb;a jsonb;i integer;counts integer[];
begin
 if p_actor is null or p_executor is null or private.can(p_team,'upload',p_actor) is not true or private.can(p_team,'view',p_actor) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if p_payload is null or jsonb_typeof(p_payload)<>'object' or jsonb_typeof(p_children)<>'array' or jsonb_typeof(p_assignments)<>'array' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 set_id:=(p_payload->>'setId')::uuid; intent:=(p_payload->>'catalogIntentId')::uuid;attempt:=(p_payload->>'updateAttemptId')::uuid;cnt:=(p_payload->>'requestedCount')::integer;products:=(p_payload->>'productCount')::integer;recipe:=(p_payload->>'recipeRevision')::bigint;
 if set_id is null or cnt is null or products is null or recipe is null or cnt<1 or cnt>products or products>400 or products<1 or recipe<1 or jsonb_array_length(p_children)<>cnt or jsonb_array_length(p_assignments)<>products or num_nonnulls(intent,attempt)<>1 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if exists(select 1 from jsonb_array_elements(p_children) with ordinality as x(child,ord) where child->>'index' is null or child->>'requestId' is null or (child->>'index')::integer<>ord-1) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if private.can(p_team,'process',p_actor) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if intent is not null then
  perform 1 from private.catalog_generation_intents where id=intent and team_id=p_team and actor_id=p_actor and state<>'canceled' for update;
  if not found then raise exception 'WRONG_STATE' using errcode='55000';end if;
 else
  perform 1 from public.team_catalog_update_attempts where attempt_id=attempt and team_id=p_team and result='running' for update;
  if not found then raise exception 'WRONG_STATE' using errcode='55000';end if;
 end if;
 if intent is not null and not exists(select 1 from private.catalog_generation_intents x where x.id=intent and x.team_id=p_team and x.actor_id=p_actor and x.video_material_id=(p_payload->>'sourceMaterialId')::uuid and (p_payload->>'catalogMaterialId' is null or x.replaces_material_id=(p_payload->>'catalogMaterialId')::uuid or (x.state='registered' and (x.checkpoint->>'materialId'=p_payload->>'catalogMaterialId' or x.result#>>'{catalog,materialId}'=p_payload->>'catalogMaterialId')))) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if attempt is not null and not exists(select 1 from public.team_catalog_update_attempts x where x.attempt_id=attempt and x.team_id=p_team and x.catalog_material_id=(p_payload->>'catalogMaterialId')::uuid and x.result='running' and exists(select 1 from public.team_product_catalogs pc where pc.material_id=x.catalog_material_id and pc.team_id=p_team and pc.video_material_id=(p_payload->>'sourceMaterialId')::uuid)) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('catalog-video-set:'||coalesce(intent,attempt)::text,0));
 select * into s from private.catalog_video_sets where catalog_video_sets.id=set_id or catalog_intent_id=intent or update_attempt_id=attempt for update;
 if s.id is not null then
  if s.id is distinct from set_id or s.team_id<>p_team or s.actor_id is distinct from p_actor or s.source_material_id is distinct from (p_payload->>'sourceMaterialId')::uuid or s.source_version is distinct from p_payload->>'sourceVersion' or s.settings_snapshot is distinct from p_payload->'settings' or s.requested_count<>cnt or s.product_count<>products or s.recipe_revision<>recipe or s.assignment_seed is distinct from p_payload->>'seed' or s.settings_digest is distinct from p_payload->>'settingsDigest' then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
  if exists(select 1 from jsonb_array_elements(p_children) child_row left join private.catalog_video_variants v on v.video_set_id=s.id and v.video_variant_index=(child_row->>'index')::integer where v.request_id is distinct from (child_row->>'requestId')::uuid)
   or (select jsonb_agg(jsonb_build_object('recipeRowId',stored_assignment.recipe_row_id,'videoVariantIndex',stored_assignment.video_variant_index) order by stored_assignment.recipe_row_id) from private.catalog_video_assignments stored_assignment where stored_assignment.video_set_id=s.id) is distinct from (select jsonb_agg(input_assignment order by input_assignment->>'recipeRowId') from jsonb_array_elements(p_assignments) input_assignment) then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
  return private.catalog_video_snapshot(s);
 end if;
 select * into source from public.team_materials where id=(p_payload->>'sourceMaterialId')::uuid and team_id=p_team for update;
 if source.id is null or source.lifecycle<>'active' or source.kind<>'file' or source.drive_version is distinct from p_payload->>'sourceVersion' or source.drive_file_id is null or source.checksum is null or source.size_bytes is null or source.mime_type is null then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 insert into private.catalog_video_sets(id,team_id,actor_id,catalog_material_id,catalog_intent_id,update_attempt_id,source_material_id,source_version,source_snapshot,settings_snapshot,settings_digest,requested_count,product_count,recipe_revision,assignment_seed,assignment_version,executor_id,epoch,workspace_epoch)
 values(set_id,p_team,p_actor,(p_payload->>'catalogMaterialId')::uuid,intent,attempt,(p_payload->>'sourceMaterialId')::uuid,p_payload->>'sourceVersion',jsonb_build_object('materialId',source.id,'teamId',p_team,'actorId',p_actor,'connectionId',source.connection_id,'fileId',source.drive_file_id,'version',source.drive_version,'checksum',source.checksum,'sizeBytes',source.size_bytes,'mimeType',source.mime_type),p_payload->'settings',p_payload->>'settingsDigest',cnt,products,recipe,p_payload->>'seed',1,p_executor,1,(select coalesce(max(epoch),0) from private.workspace_pauses where team_id=p_team)) returning * into s;
 i:=0;
 for c in select value from jsonb_array_elements(p_children) loop
  if c->>'index' is null or (c->>'index')::integer<>i or c->>'requestId' is null then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  insert into private.catalog_video_variants(video_set_id,team_id,video_variant_index,request_id) values(s.id,p_team,i,(c->>'requestId')::uuid);i:=i+1;
 end loop;
 counts:=array_fill(0,array[cnt]);
 for a in select value from jsonb_array_elements(p_assignments) loop
  i:=(a->>'videoVariantIndex')::integer;
  if i is null or i<0 or i>=cnt or a->>'recipeRowId' is null then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  insert into private.catalog_video_assignments values(s.id,p_team,recipe,(a->>'recipeRowId')::uuid,i);counts[i+1]:=counts[i+1]+1;
 end loop;
 if (select min(v) from unnest(counts) v)<1 or (select max(v)-min(v) from unnest(counts) v)>1 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 return private.catalog_video_snapshot(s);
end;$$;
revoke all on function public.service_accept_catalog_video_set(uuid,uuid,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.service_accept_catalog_video_set(uuid,uuid,uuid,jsonb,jsonb,jsonb) to service_role;
-- Whole-snapshot CAS keeps original bindings; registered output IDs are derived
-- from original succeeded restitch operations, never trusted from a caller.
create function public.service_checkpoint_catalog_video_set(p_set uuid,p_team uuid,p_actor uuid,p_executor uuid,p_epoch bigint,p_revision bigint,p_children jsonb) returns boolean language plpgsql security definer set search_path='' as $$
declare s private.catalog_video_sets%rowtype;v private.catalog_video_variants%rowtype;c jsonb; o public.team_operations%rowtype; n integer;
begin
 select * into s from private.catalog_video_sets where id=p_set and team_id=p_team for update;
 if s.id is null or s.actor_id is distinct from p_actor or private.can(p_team,'upload',p_actor) is not true or s.executor_id is distinct from p_executor or s.epoch is distinct from p_epoch then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if s.revision is distinct from p_revision then return false;end if;
 if p_children is null or s.state not in('accepted','preparing','ready','unknown','cancel_requested') or jsonb_typeof(p_children)<>'array' or jsonb_array_length(p_children)<>s.requested_count then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if (select count(*) from jsonb_array_elements(p_children) x where x->>'state'='working')>1 or (exists(select 1 from jsonb_array_elements(p_children) x where x->>'state'='unknown') and exists(select 1 from jsonb_array_elements(p_children) x where x->>'state'='working')) then raise exception 'WRONG_STATE' using errcode='55000';end if;
 n:=0;
 for c in select value from jsonb_array_elements(p_children) loop
  select * into v from private.catalog_video_variants where video_set_id=p_set and video_variant_index=n for update;
  if jsonb_typeof(c)<>'object' or c->>'index' is null or c->>'requestId' is null or c->>'state' is null or v.request_id is null or (c->>'index')::integer<>n or (c->>'requestId')::uuid<>v.request_id then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
  if c->>'state' not in('queued','working','unknown','registered') or (v.state='registered' and (c->>'state'<>'registered' or (c->>'outputId')::uuid is distinct from v.output_material_id)) or (v.state<>'queued' and c->>'state'='queued') then raise exception 'WRONG_STATE' using errcode='55000';end if;
  if v.state='unknown' and c->>'state'='working' and exists(select 1 from private.team_recovery_execution_fences f join public.team_operations op on op.id=f.operation_id where op.team_id=p_team and op.actor_id=p_actor and op.kind='process' and op.idempotency_key='catalog-variant:'||v.request_id::text) then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
  if v.operation_id is not null and v.operation_id is distinct from (c->>'operationId')::uuid then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
  if s.state='cancel_requested' and c->>'state'='working' and (v.state is distinct from 'working' or v.operation_id is distinct from (c->>'operationId')::uuid) then raise exception 'WRONG_STATE' using errcode='55000';end if;
  o:=null;
  if c->>'operationId' is not null then
   select * into o from public.team_operations where id=(c->>'operationId')::uuid and team_id=p_team;
   if o.id is null or o.actor_id is distinct from p_actor or o.kind<>'process' or o.idempotency_key is distinct from 'catalog-variant:'||v.request_id::text or o.source_material_id is distinct from s.source_material_id or not exists(select 1 from private.team_operation_intents i where i.operation_id=o.id and i.team_id=p_team and i.tool_id='restitch' and i.expected_source_version=s.source_version) then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
  end if;
  if c->>'state'='registered' then
   if o.id is null or o.actor_id<>p_actor or o.state<>'succeeded' or o.source_material_id<>s.source_material_id or o.result_material_id is null or o.result_material_id is distinct from (c->>'outputId')::uuid or not exists(select 1 from private.team_operation_intents i where i.operation_id=o.id and i.team_id=p_team and i.tool_id='restitch' and i.expected_source_version=s.source_version) then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
  elsif c->>'outputId' is not null then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  update private.catalog_video_variants set state=c->>'state',operation_id=(c->>'operationId')::uuid,output_material_id=case when c->>'state'='registered' then o.result_material_id else null end where video_set_id=p_set and video_variant_index=n;
  n:=n+1;
 end loop;
 update private.catalog_video_sets set revision=revision+1,state=case when s.state='cancel_requested' then 'cancel_requested' when not exists(select 1 from private.catalog_video_variants where video_set_id=p_set and state<>'registered') then 'ready' when exists(select 1 from private.catalog_video_variants where video_set_id=p_set and state='unknown') then 'unknown' else 'preparing' end,updated_at=clock_timestamp() where id=p_set;
 return true;
end;$$;
create function public.service_reconcile_catalog_video_variant(p_set uuid,p_team uuid,p_actor uuid,p_executor uuid,p_epoch bigint,p_index integer,p_request uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare s private.catalog_video_sets%rowtype;v private.catalog_video_variants%rowtype;o public.team_operations%rowtype;
begin
 perform public.service_read_catalog_video_set(p_set,p_team,p_actor,p_executor,p_epoch);
 select * into s from private.catalog_video_sets where id=p_set;
 select * into v from private.catalog_video_variants where video_set_id=p_set and video_variant_index=p_index;
 if v.request_id is distinct from p_request then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
 select * into o from public.team_operations where team_id=p_team and actor_id=p_actor and kind='process' and idempotency_key='catalog-variant:'||p_request::text;
 if o.id is null then
  if v.operation_id is null then return jsonb_build_object('kind','absent');end if;
  return jsonb_build_object('kind','unknown');
 end if;
 if o.state='succeeded' and o.result_material_id is not null and o.source_material_id=s.source_material_id and exists(select 1 from private.team_operation_intents i where i.operation_id=o.id and i.team_id=p_team and i.tool_id='restitch' and i.expected_source_version=s.source_version) then return jsonb_build_object('kind','registered','operationId',o.id,'outputId',o.result_material_id);end if;
 if o.state in('pending','running') and o.source_material_id=s.source_material_id and not exists(select 1 from private.team_recovery_execution_fences f where f.operation_id=o.id) and exists(select 1 from private.team_operation_intents i where i.operation_id=o.id and i.team_id=p_team and i.tool_id='restitch' and i.expected_source_version=s.source_version) then return jsonb_build_object('kind','admitted','operationId',o.id);end if;
 -- A consumed execution fence is unknown until original output registration,
 -- never another permission to run after an interrupted upload.
 return jsonb_build_object('kind','unknown');
end;$$;
revoke all on function public.service_reconcile_catalog_video_variant(uuid,uuid,uuid,uuid,bigint,integer,uuid) from public,anon,authenticated;
grant execute on function public.service_reconcile_catalog_video_variant(uuid,uuid,uuid,uuid,bigint,integer,uuid) to service_role;
-- Authenticate native ownership through the existing delegation/credential audience,
-- epoch, entitlement and current-rights boundary; execution CAS epoch is separate
-- from the captured delegation version. Never take over another native boot.
create function public.service_authorize_catalog_video_executor(p_set uuid,p_hash bytea,p_native uuid,p_protocol integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare authority jsonb;s private.catalog_video_sets%rowtype;version bigint;
begin
 if p_protocol is distinct from 1 or p_native is null then raise exception 'AGENT_UPDATE_REQUIRED' using errcode='55000';end if;
 authority:=public.service_team_recovery('authorize_claim',p_hash,'{}'::jsonb);
 select d.version into version from private.team_recovery_delegations d where d.id=(authority->>'delegationId')::uuid;
 select * into s from private.catalog_video_sets where id=p_set for update;
 if s.id is null or s.team_id is distinct from (authority->>'teamId')::uuid or s.actor_id is distinct from (authority->>'actorId')::uuid or s.executor_id is distinct from (authority->>'installationId')::uuid or (s.recovery_delegation_id is not null and (s.recovery_delegation_id is distinct from (authority->>'delegationId')::uuid or s.recovery_delegation_version is distinct from version or s.native_instance_id is distinct from p_native)) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if s.workspace_epoch is distinct from (select coalesce(max(epoch),0) from private.workspace_pauses where team_id=s.team_id) then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if s.recovery_delegation_id is null then
  update private.catalog_video_sets set recovery_delegation_id=(authority->>'delegationId')::uuid,recovery_delegation_version=version,native_instance_id=p_native where id=s.id returning * into s;
 end if;
 return jsonb_build_object('setId',s.id,'teamId',s.team_id,'actorId',s.actor_id,'executorId',s.executor_id,'epoch',s.epoch,'nativeInstanceId',s.native_instance_id,'delegationVersion',s.recovery_delegation_version);
end;$$;
create function public.service_claim_catalog_video_set(p_hash bytea,p_native uuid,p_protocol integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare authority jsonb;s private.catalog_video_sets%rowtype;
begin
 if p_protocol is distinct from 1 or p_native is null then raise exception 'AGENT_UPDATE_REQUIRED' using errcode='55000';end if;
 authority:=public.service_team_recovery('authorize_claim',p_hash,'{}'::jsonb);
 select * into s from private.catalog_video_sets where team_id=(authority->>'teamId')::uuid and actor_id=(authority->>'actorId')::uuid and executor_id=(authority->>'installationId')::uuid and state in('accepted','preparing','unknown') and (native_instance_id is null or native_instance_id=p_native) order by created_at,id for update skip locked limit 1;
 if s.id is null then return jsonb_build_object('setId',null);end if;
 perform public.service_authorize_catalog_video_executor(s.id,p_hash,p_native,p_protocol);
 return jsonb_build_object('setId',s.id);
end;$$;
create function public.service_read_catalog_video_admission(p_set uuid,p_hash bytea,p_native uuid,p_protocol integer,p_index integer,p_request uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare authority jsonb;s private.catalog_video_sets%rowtype;v private.catalog_video_variants%rowtype;o public.team_operations%rowtype;
begin
 authority:=public.service_authorize_catalog_video_executor(p_set,p_hash,p_native,p_protocol);
 select * into s from private.catalog_video_sets where id=p_set for update;
 select * into v from private.catalog_video_variants where video_set_id=p_set and video_variant_index=p_index for update;
 if s.state not in('accepted','preparing','unknown') or v.request_id is distinct from p_request or v.state not in('queued','working','unknown') then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into o from public.team_operations where team_id=s.team_id and actor_id=s.actor_id and kind='process' and idempotency_key='catalog-variant:'||p_request::text;
 if o.id is not null then
  if o.source_material_id is distinct from s.source_material_id or not exists(select 1 from private.team_operation_intents i where i.operation_id=o.id and i.team_id=s.team_id and i.tool_id='restitch' and i.expected_source_version=s.source_version) then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
  return jsonb_build_object('kind','admitted','operationId',o.id,'teamId',s.team_id,'actorId',s.actor_id);
 end if;
 if v.operation_id is not null then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 return jsonb_build_object('kind','new','teamId',s.team_id,'actorId',s.actor_id,'materialId',s.source_material_id,'sourceVersion',s.source_version,'settings',s.settings_snapshot,'idempotencyKey','catalog-variant:'||p_request::text,'outputName','catalog_variant_'||s.id::text||'_'||p_index::text||'.mp4');
end;$$;
revoke all on function public.service_claim_catalog_video_set(bytea,uuid,integer),public.service_read_catalog_video_admission(uuid,bytea,uuid,integer,integer,uuid) from public,anon,authenticated;
grant execute on function public.service_claim_catalog_video_set(bytea,uuid,integer),public.service_read_catalog_video_admission(uuid,bytea,uuid,integer,integer,uuid) to service_role;
create function public.service_dispatch_catalog_video_variant(p_set uuid,p_hash bytea,p_native uuid,p_protocol integer,p_index integer,p_request uuid,p_operation uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare authority jsonb;s private.catalog_video_sets%rowtype;v private.catalog_video_variants%rowtype;inserted integer;
begin
 authority:=public.service_authorize_catalog_video_executor(p_set,p_hash,p_native,p_protocol);
 select * into s from private.catalog_video_sets where id=p_set for update;
 select * into v from private.catalog_video_variants where video_set_id=p_set and video_variant_index=p_index for update;
 if s.state not in('accepted','preparing') or v.request_id is distinct from p_request or v.operation_id is distinct from p_operation or v.state<>'working' or not exists(select 1 from public.team_operations o join private.team_operation_intents i on i.operation_id=o.id and i.team_id=o.team_id where o.id=p_operation and o.team_id=s.team_id and o.actor_id=s.actor_id and o.kind='process' and o.state in('pending','running') and o.idempotency_key='catalog-variant:'||p_request::text and o.source_material_id=s.source_material_id and i.tool_id='restitch' and i.expected_source_version=s.source_version) then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 insert into private.team_recovery_execution_fences(operation_id,team_id,actor_id,job_id) values(p_operation,s.team_id,s.actor_id,p_request) on conflict(operation_id) do nothing;
 get diagnostics inserted=row_count;
 if inserted=1 then update private.catalog_video_variants set dispatch_credential_hash=p_hash where video_set_id=p_set and video_variant_index=p_index;end if;
 return jsonb_build_object('executionAllowed',inserted=1,'operationId',p_operation,'requestId',p_request);
end;$$;
create function public.service_read_catalog_video_process_context(p_set uuid,p_hash bytea,p_native uuid,p_protocol integer,p_index integer,p_request uuid,p_operation uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare authority jsonb;s private.catalog_video_sets%rowtype;v private.catalog_video_variants%rowtype;o public.team_operations%rowtype;intent private.team_operation_intents%rowtype;bytes bigint;
begin
 authority:=public.service_authorize_catalog_video_executor(p_set,p_hash,p_native,p_protocol);
 select * into s from private.catalog_video_sets where id=p_set for update;
 select * into v from private.catalog_video_variants where video_set_id=p_set and video_variant_index=p_index;
 select * into o from public.team_operations where id=p_operation and team_id=s.team_id;
 select * into intent from private.team_operation_intents where operation_id=p_operation and team_id=s.team_id;
 if s.state not in('accepted','preparing') or v.request_id is distinct from p_request or v.operation_id is distinct from p_operation or v.state<>'working' or o.actor_id is distinct from s.actor_id or o.kind is distinct from 'process' or o.state not in('pending','running') or o.source_material_id is distinct from s.source_material_id or intent.tool_id is distinct from 'restitch' or intent.expected_source_version is distinct from s.source_version then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 select size_bytes into bytes from public.team_materials where id=s.source_material_id and team_id=s.team_id and lifecycle='active' and drive_version=s.source_version;
 if bytes is null or bytes<=0 then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 return jsonb_build_object('operationId',o.id,'operationState',o.state,'teamId',s.team_id,'actorId',s.actor_id,'materialId',s.source_material_id,'destinationFolderId',o.destination_folder_id,'sourceVersion',s.source_version,'sourceSizeBytes',bytes,'settings',s.settings_snapshot,'settingsDigest',s.settings_digest);
end;$$;
-- Reservation identity survives lost acknowledgements. Replaying a round never
-- resets uses/revocation, and expiration consumes the next bounded acquisition.
create table private.catalog_video_grant_rounds (
 video_set_id uuid not null references private.catalog_video_sets(id),
 video_variant_index integer not null, acquisition integer not null check(acquisition between 1 and 2),
 source_ticket_id uuid not null unique default gen_random_uuid(), finalize_ticket_id uuid not null unique default gen_random_uuid(),
 expires_at timestamptz not null, source_hash bytea, finalize_hash bytea,
 primary key(video_set_id,video_variant_index,acquisition),
 foreign key(video_set_id,video_variant_index) references private.catalog_video_variants(video_set_id,video_variant_index),
 check(source_hash is null or octet_length(source_hash)=32),check(finalize_hash is null or octet_length(finalize_hash)=32)
);
alter table private.catalog_video_grant_rounds enable row level security;
alter table private.catalog_video_grant_rounds force row level security;
revoke all on private.catalog_video_grant_rounds from public,anon,authenticated,service_role;
create function public.service_reserve_catalog_video_grants(p_set uuid,p_hash bytea,p_native uuid,p_protocol integer,p_index integer,p_request uuid,p_operation uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare context jsonb;r private.catalog_video_grant_rounds%rowtype;used integer;
begin
 context:=public.service_read_catalog_video_process_context(p_set,p_hash,p_native,p_protocol,p_index,p_request,p_operation);
 perform 1 from private.catalog_video_variants where video_set_id=p_set and video_variant_index=p_index for update;
 select * into r from private.catalog_video_grant_rounds where video_set_id=p_set and video_variant_index=p_index order by acquisition desc limit 1;
 if r.expires_at is null or r.expires_at<=clock_timestamp() then
  update private.catalog_video_variants set grant_refreshes=grant_refreshes+1 where video_set_id=p_set and video_variant_index=p_index and request_id=p_request and operation_id=p_operation and grant_refreshes<2 returning grant_refreshes into used;
  if used is null then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
  insert into private.catalog_video_grant_rounds(video_set_id,video_variant_index,acquisition,expires_at) values(p_set,p_index,used,clock_timestamp()+interval '6 hours') returning * into r;
 end if;
 return jsonb_build_object('sourceTicketId',r.source_ticket_id,'finalizeTicketId',r.finalize_ticket_id,'expiresAt',r.expires_at,'acquisition',r.acquisition);
end;$$;
create function public.service_issue_catalog_video_grants(p_set uuid,p_hash bytea,p_native uuid,p_protocol integer,p_index integer,p_request uuid,p_operation uuid,p_acquisition integer,p_source_hash bytea,p_finalize_hash bytea,p_source_uses integer) returns boolean language plpgsql security definer set search_path='' as $$
declare context jsonb;r private.catalog_video_grant_rounds%rowtype;g private.team_transfer_grants%rowtype;purpose text;ticket bytea;uses_limit integer;
begin
 context:=public.service_read_catalog_video_process_context(p_set,p_hash,p_native,p_protocol,p_index,p_request,p_operation);
 select * into r from private.catalog_video_grant_rounds where video_set_id=p_set and video_variant_index=p_index and acquisition=p_acquisition for update;
 if r.expires_at is null or r.expires_at<=clock_timestamp() or octet_length(p_source_hash) is distinct from 32 or octet_length(p_finalize_hash) is distinct from 32 or p_source_hash=p_finalize_hash or p_source_uses is distinct from least(10000,ceil((context->>'sourceSizeBytes')::numeric/33554432)::integer+8) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if (r.source_hash is not null and r.source_hash<>p_source_hash) or (r.finalize_hash is not null and r.finalize_hash<>p_finalize_hash) then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='22023';end if;
 foreach purpose in array array['process_input','finalize'] loop
  ticket:=case when purpose='process_input' then p_source_hash else p_finalize_hash end;
  uses_limit:=case when purpose='process_input' then p_source_uses else 4 end;
  select * into g from private.team_transfer_grants where token_hash=ticket for update;
  if g.id is null then
   perform private.issue_team_transfer_grant(ticket,p_operation,(context->>'teamId')::uuid,(context->>'actorId')::uuid,purpose,(context->>'materialId')::uuid,(context->>'destinationFolderId')::uuid,'restitch',33554432,r.expires_at,uses_limit);
  elsif g.operation_id is distinct from p_operation or g.team_id is distinct from (context->>'teamId')::uuid or g.actor_id is distinct from (context->>'actorId')::uuid or g.purpose is distinct from purpose or g.material_id is distinct from (context->>'materialId')::uuid or g.destination_folder_id is distinct from (context->>'destinationFolderId')::uuid or g.tool_id is distinct from 'restitch' or g.max_range_bytes<>33554432 or g.expires_at<>r.expires_at or g.max_uses<>uses_limit then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='22023';
  end if;
 end loop;
 update private.catalog_video_grant_rounds set source_hash=p_source_hash,finalize_hash=p_finalize_hash where video_set_id=p_set and video_variant_index=p_index and acquisition=p_acquisition;
 return true;
end;$$;
revoke all on function public.service_issue_catalog_video_grants(uuid,bytea,uuid,integer,integer,uuid,uuid,integer,bytea,bytea,integer) from public,anon,authenticated;
grant execute on function public.service_issue_catalog_video_grants(uuid,bytea,uuid,integer,integer,uuid,uuid,integer,bytea,bytea,integer) to service_role;
revoke all on function public.service_reserve_catalog_video_grants(uuid,bytea,uuid,integer,integer,uuid,uuid) from public,anon,authenticated;
grant execute on function public.service_reserve_catalog_video_grants(uuid,bytea,uuid,integer,integer,uuid,uuid) to service_role;
revoke all on function public.service_read_catalog_video_process_context(uuid,bytea,uuid,integer,integer,uuid,uuid) from public,anon,authenticated;
grant execute on function public.service_read_catalog_video_process_context(uuid,bytea,uuid,integer,integer,uuid,uuid) to service_role;
revoke all on function public.service_authorize_catalog_video_executor(uuid,bytea,uuid,integer),public.service_dispatch_catalog_video_variant(uuid,bytea,uuid,integer,integer,uuid,uuid) from public,anon,authenticated;
grant execute on function public.service_authorize_catalog_video_executor(uuid,bytea,uuid,integer),public.service_dispatch_catalog_video_variant(uuid,bytea,uuid,integer,integer,uuid,uuid) to service_role;
create function private.guard_catalog_variant_operation_retention() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from private.catalog_video_variants where operation_id=old.id or (team_id=old.team_id and 'catalog-variant:'||request_id::text=old.idempotency_key)) then raise exception 'WRONG_STATE' using errcode='55000';end if;
 return old;
end;$$;
create trigger catalog_variant_operation_retention before delete on public.team_operations for each row execute function private.guard_catalog_variant_operation_retention();
revoke all on function private.guard_catalog_variant_operation_retention() from public,anon,authenticated,service_role;
revoke all on function private.catalog_video_snapshot(private.catalog_video_sets) from public,anon,authenticated,service_role;
revoke all on function public.service_read_catalog_video_set(uuid,uuid,uuid,uuid,bigint),public.service_checkpoint_catalog_video_set(uuid,uuid,uuid,uuid,bigint,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.service_read_catalog_video_set(uuid,uuid,uuid,uuid,bigint),public.service_checkpoint_catalog_video_set(uuid,uuid,uuid,uuid,bigint,bigint,jsonb) to service_role;
-- A new catalog consumer may reuse verified outputs, but receives a distinct
-- immutable row recipe/reference and must obtain its own publication receipt.
create function public.service_reference_ready_catalog_video_set(p_team uuid,p_actor uuid,p_set uuid,p_payload jsonb,p_assignments jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare s private.catalog_video_sets%rowtype;r private.catalog_video_set_recipes%rowtype;ref private.catalog_video_recipe_references%rowtype;rev bigint;products integer;intent uuid;attempt uuid;catalog uuid;
begin
 if private.can(p_team,'view',p_actor) is not true or private.can(p_team,'process',p_actor) is not true or private.can(p_team,'upload',p_actor) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into s from private.catalog_video_sets where id=p_set and team_id=p_team for update;
 if s.id is null or s.actor_id is distinct from p_actor or s.state<>'ready' or exists(select 1 from private.catalog_video_variants v left join public.team_materials m on m.id=v.output_material_id and m.team_id=p_team where v.video_set_id=p_set and (v.state<>'registered' or m.lifecycle is distinct from 'active')) then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if s.settings_digest is distinct from p_payload->>'settingsDigest' or s.source_version is distinct from p_payload->>'sourceVersion' or not exists(select 1 from public.team_materials m where m.id=s.source_material_id and m.team_id=p_team and m.lifecycle='active' and m.drive_version=s.source_version and m.drive_file_id=s.source_snapshot->>'fileId' and m.connection_id=(s.source_snapshot->>'connectionId')::uuid and m.checksum=s.source_snapshot->>'checksum' and m.size_bytes=(s.source_snapshot->>'sizeBytes')::bigint) then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 rev:=(p_payload->>'recipeRevision')::bigint;products:=(p_payload->>'productCount')::integer;intent:=(p_payload->>'catalogIntentId')::uuid;attempt:=(p_payload->>'updateAttemptId')::uuid;catalog:=(p_payload->>'catalogMaterialId')::uuid;
 if num_nonnulls(intent,attempt)<>1 or products not between s.requested_count and 400 or rev<=0 or p_payload->>'seed' !~ '^[a-f0-9]{64}$' or jsonb_typeof(p_assignments)<>'array' or jsonb_array_length(p_assignments)<>products then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if intent is not null then
  perform 1 from private.catalog_generation_intents i where i.id=intent and i.team_id=p_team and i.actor_id=p_actor and i.video_material_id=s.source_material_id and (catalog is null or i.replaces_material_id=catalog or (i.state='registered' and (i.checkpoint->>'materialId'=catalog::text or i.result#>>'{catalog,materialId}'=catalog::text))) for update;
 else
  perform 1 from public.team_catalog_update_attempts a join public.team_product_catalogs c on c.material_id=a.catalog_material_id and c.team_id=a.team_id where a.attempt_id=attempt and a.team_id=p_team and a.catalog_material_id=catalog and c.video_material_id=s.source_material_id and a.result='running' for update of a;
 end if;
 if not found then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into ref from private.catalog_video_recipe_references where catalog_intent_id=intent or update_attempt_id=attempt;
 if ref.id is not null and (ref.video_set_id<>p_set or ref.recipe_revision<>rev or ref.team_id<>p_team or ref.actor_id<>p_actor or ref.catalog_material_id is distinct from catalog) then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
 if (select count(distinct x->>'recipeRowId') from jsonb_array_elements(p_assignments)x)<>products or exists(select 1 from jsonb_array_elements(p_assignments)x where (x->>'recipeRowId')::uuid is null or (x->>'videoVariantIndex')::integer not between 0 and s.requested_count-1) or (select max(n)-min(n) from (select count(x)n from generate_series(0,s.requested_count-1)v left join jsonb_array_elements(p_assignments)x on (x->>'videoVariantIndex')::integer=v group by v)counts)>1 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select * into r from private.catalog_video_set_recipes where video_set_id=p_set and team_id=p_team and recipe_revision=rev;
 if r.video_set_id is not null then
  if r.product_count<>products or r.assignment_seed<>p_payload->>'seed' or exists((select recipe_row_id,video_variant_index from private.catalog_video_assignments where video_set_id=p_set and recipe_revision=rev) except (select (x->>'recipeRowId')::uuid,(x->>'videoVariantIndex')::integer from jsonb_array_elements(p_assignments)x)) then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
 else
  insert into private.catalog_video_set_recipes values(p_set,p_team,rev,products,p_payload->>'seed',1,clock_timestamp());
  insert into private.catalog_video_assignments(video_set_id,team_id,recipe_revision,recipe_row_id,video_variant_index) select p_set,p_team,rev,(x->>'recipeRowId')::uuid,(x->>'videoVariantIndex')::integer from jsonb_array_elements(p_assignments)x;
 end if;
 if ref.id is null then insert into private.catalog_video_recipe_references(video_set_id,team_id,recipe_revision,catalog_material_id,catalog_intent_id,update_attempt_id,actor_id) values(p_set,p_team,rev,catalog,intent,attempt,p_actor);end if;
 return jsonb_build_object('setId',p_set,'recipeRevision',rev,'ready',true);
end;$$;
revoke all on function public.service_reference_ready_catalog_video_set(uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.service_reference_ready_catalog_video_set(uuid,uuid,uuid,jsonb,jsonb) to service_role;
create trigger task_cleanup_reference_fence before insert or update on private.catalog_video_sets for each row execute function private.guard_task_cleanup_reference();
create trigger task_cleanup_reference_fence before insert or update on private.catalog_video_variants for each row execute function private.guard_task_cleanup_reference();
create trigger task_cleanup_reference_fence before insert or update on private.catalog_video_assignments for each row execute function private.guard_task_cleanup_reference();
create trigger task_cleanup_reference_fence before insert or update on private.catalog_video_set_recipes for each row execute function private.guard_task_cleanup_reference();
create trigger task_cleanup_reference_fence before insert or update on private.catalog_video_recipe_references for each row execute function private.guard_task_cleanup_reference();
create trigger task_cleanup_reference_fence before insert or update on private.catalog_video_grant_rounds for each row execute function private.guard_task_cleanup_reference();
create function private.notify_catalog_video_set_progress()returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT'or new.revision is distinct from old.revision or new.state is distinct from old.state then
  insert into public.team_catalog_events(team_id,material_id,event_kind)values(new.team_id,new.catalog_material_id,'sync_state');
 end if;
 return new;
end;$$;
create trigger catalog_video_progress after insert or update on private.catalog_video_sets for each row execute function private.notify_catalog_video_set_progress();
revoke all on function private.notify_catalog_video_set_progress()from public,anon,authenticated,service_role;

-- Closure-only authority captured at original dispatch. It survives revoked
-- media rights/rotated credentials but cannot issue grants or start any work.
create function public.service_complete_catalog_video_variant(p_set uuid,p_hash bytea,p_native uuid,p_protocol integer,p_index integer,p_request uuid,p_operation uuid,p_outcome text,p_code text)returns jsonb language plpgsql security definer set search_path='' as $$
declare s private.catalog_video_sets%rowtype;v private.catalog_video_variants%rowtype;o public.team_operations%rowtype;i private.team_operation_intents%rowtype;
begin
 select *into s from private.catalog_video_sets where id=p_set for update;
 select *into v from private.catalog_video_variants where video_set_id=p_set and video_variant_index=p_index for update;
 if p_protocol is distinct from 1 or p_native is null or s.id is null or s.native_instance_id is distinct from p_native or s.recovery_delegation_id is null or s.recovery_delegation_version is null or v.request_id is distinct from p_request or v.operation_id is distinct from p_operation or v.dispatch_credential_hash is null or v.dispatch_credential_hash is distinct from p_hash or not exists(select 1 from private.team_recovery_execution_fences f where f.operation_id=p_operation and f.team_id=s.team_id and f.actor_id=s.actor_id and f.job_id=p_request)then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
 if p_outcome not in('canceled','failed')or p_outcome is null or(p_outcome='failed'and(p_code is null or p_code not in('RESTITCH_SCREEN_UNAVAILABLE','RESTITCH_SCREEN_FETCH_FAILED','RESTITCH_SCREEN_UNSUPPORTED','STITCH_INTERRUPTED','STITCH_TOOL_FAILED','STITCH_PATH_INVALID','STITCH_PLAN_VIDEO_CODEC','STITCH_PLAN_AUDIO_CODEC','STITCH_PLAN_VARIABLE_FRAME_RATE','STITCH_PLAN_CONTAINER','STITCH_PLAN_UNREADABLE','STITCH_PLAN_NOTHING_TO_REMOVE','STITCH_PLAN_NO_SCREENS','STITCH_OUTPUT_UNWRITABLE','STITCH_VERIFICATION_FAILED','STITCH_IMAGE_UNAVAILABLE','STITCH_JOIN_FAILED','STITCH_AUDIO_MISMATCH','MEDIA_TOOL_UNAVAILABLE','SILENCE_BANK_FAILED','SCREEN_ENCODE_FAILED','SCREEN_SILENCE_FAILED','SCREEN_MUX_FAILED','BODY_PREPARE_FAILED','BODY_REMUX_FAILED','BODY_HEAD_FAILED','BODY_TAIL_FAILED','BODY_AUDIO_MISMATCH','BODY_RECOVERY_FAILED','BODY_RECOVERY_VERIFICATION_FAILED','BODY_TIMING_UNREADABLE','BODY_JOIN_FAILED','RESTITCH_SCREEN_CANDIDATES_EXHAUSTED','RESTITCH_SCREEN_PREVIOUS_FAILURES','RESTITCH_SCREEN_BYTE_LIMIT','RESTITCH_SCREEN_IO_LIMIT','RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN','RESTITCH_SCREEN_SELECTION_LIMIT','RESTITCH_NO_SCREENS','RESTITCH_INVALID','SOURCE_CHANGED','PERMISSION_DENIED','RESTITCH_SOURCE_FORBIDDEN','UNSUPPORTED_MEDIA','PROCESS_FAILED','TOO_LARGE')))then raise exception 'INVALID_INPUT'using errcode='22023';end if;
 select *into o from public.team_operations where id=p_operation and team_id=s.team_id for update;
 select *into i from private.team_operation_intents where operation_id=p_operation and team_id=s.team_id;
 if o.id is null or o.actor_id is distinct from s.actor_id or o.kind is distinct from 'process'or o.source_material_id is distinct from s.source_material_id or o.idempotency_key is distinct from 'catalog-variant:'||p_request::text or i.tool_id is distinct from 'restitch'or i.expected_source_version is distinct from s.source_version then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
 if o.state='succeeded'and o.result_material_id is not null then return jsonb_build_object('kind','registered','operationId',o.id,'outputId',o.result_material_id);end if;
 if o.state in('canceled','failed')then return jsonb_build_object('kind','terminal','operationId',o.id,'state',o.state);end if;
 if exists(select 1 from private.process_upload_ownership where operation_id=o.id)or i.provider_result_id is not null or o.result_material_id is not null then return jsonb_build_object('kind','unknown','operationId',o.id);end if;
 if p_outcome='canceled'and s.state not in('cancel_requested','canceled')then return jsonb_build_object('kind','unknown','operationId',o.id);end if;
 perform public.service_transition_team_operation(o.id,p_outcome,case when p_outcome='canceled'then 'canceled'else 'failed'end,o.progress,null,p_code,false);
 update private.catalog_video_variants set state='unknown'where video_set_id=p_set and video_variant_index=p_index and state<>'registered';
 update private.catalog_video_sets set state=case when state in('cancel_requested','canceled')then state else 'unknown'end,revision=revision+1,updated_at=clock_timestamp()where id=p_set;
 return jsonb_build_object('kind','terminal','operationId',o.id,'state',p_outcome);
end;$$;
revoke all on function public.service_complete_catalog_video_variant(uuid,bytea,uuid,integer,integer,uuid,uuid,text,text)from public,anon,authenticated;
grant execute on function public.service_complete_catalog_video_variant(uuid,bytea,uuid,integer,integer,uuid,uuid,text,text)to service_role;

create function private.catalog_video_failure_code(p_set uuid)returns text language sql stable security definer set search_path='' as $$
 select o.error_code from private.catalog_video_sets s join private.catalog_video_variants v on v.video_set_id=s.id join public.team_operations o on o.id=v.operation_id and o.team_id=s.team_id and o.actor_id=s.actor_id and o.source_material_id=s.source_material_id where s.id=p_set and o.kind='process'and o.state='failed'and o.idempotency_key='catalog-variant:'||v.request_id::text and o.error_code in('RESTITCH_SCREEN_UNAVAILABLE','RESTITCH_SCREEN_FETCH_FAILED','RESTITCH_SCREEN_UNSUPPORTED','STITCH_INTERRUPTED','STITCH_TOOL_FAILED','STITCH_PATH_INVALID','STITCH_PLAN_VIDEO_CODEC','STITCH_PLAN_AUDIO_CODEC','STITCH_PLAN_VARIABLE_FRAME_RATE','STITCH_PLAN_CONTAINER','STITCH_PLAN_UNREADABLE','STITCH_PLAN_NOTHING_TO_REMOVE','STITCH_PLAN_NO_SCREENS','STITCH_OUTPUT_UNWRITABLE','STITCH_VERIFICATION_FAILED','STITCH_IMAGE_UNAVAILABLE','STITCH_JOIN_FAILED','STITCH_AUDIO_MISMATCH','MEDIA_TOOL_UNAVAILABLE','SILENCE_BANK_FAILED','SCREEN_ENCODE_FAILED','SCREEN_SILENCE_FAILED','SCREEN_MUX_FAILED','BODY_PREPARE_FAILED','BODY_REMUX_FAILED','BODY_HEAD_FAILED','BODY_TAIL_FAILED','BODY_AUDIO_MISMATCH','BODY_RECOVERY_FAILED','BODY_RECOVERY_VERIFICATION_FAILED','BODY_TIMING_UNREADABLE','BODY_JOIN_FAILED','RESTITCH_SCREEN_CANDIDATES_EXHAUSTED','RESTITCH_SCREEN_PREVIOUS_FAILURES','RESTITCH_SCREEN_BYTE_LIMIT','RESTITCH_SCREEN_IO_LIMIT','RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN','RESTITCH_SCREEN_SELECTION_LIMIT','RESTITCH_NO_SCREENS','RESTITCH_INVALID','SOURCE_CHANGED','PERMISSION_DENIED','RESTITCH_SOURCE_FORBIDDEN','UNSUPPORTED_MEDIA','PROCESS_FAILED','TOO_LARGE')order by o.updated_at desc,v.video_variant_index limit 1;
$$;
revoke all on function private.catalog_video_failure_code(uuid)from public,anon,authenticated,service_role;

commit;
