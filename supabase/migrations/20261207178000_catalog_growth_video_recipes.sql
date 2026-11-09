begin;
-- Growth metadata belongs to the original ordinary attempt. It never creates
-- another media operation, changes a live policy before readback, or redraws.
create table private.catalog_growth_video_recipes(
 attempt_id uuid primary key references public.team_catalog_update_attempts(attempt_id),team_id uuid not null references public.teams(id),catalog_material_id uuid not null references public.team_product_catalogs(material_id),actor_id uuid not null references auth.users(id),
 base_target_id uuid not null references private.catalog_publication_targets(id),base_revision bigint not null,base_product_count integer not null,product_count integer not null,expected_update_count integer not null,
 mode text not null,due_at timestamptz,time_zone text,target jsonb not null,recipe_row_ids jsonb not null,command_id uuid not null default gen_random_uuid(),applied_at timestamptz,
 check(product_count=base_product_count+1 and product_count<=400),check(jsonb_array_length(recipe_row_ids)=product_count)
);
create index catalog_growth_video_recipe_pending on private.catalog_growth_video_recipes(catalog_material_id,expected_update_count)where applied_at is null;
alter table private.catalog_growth_video_recipes enable row level security;
alter table private.catalog_growth_video_recipes force row level security;
revoke all on private.catalog_growth_video_recipes from public,anon,authenticated,service_role;
create trigger task_cleanup_reference_fence before insert or update on private.catalog_growth_video_recipes for each row execute function private.guard_task_cleanup_reference();
create function private.guard_catalog_growth_recipe_immutable()returns trigger language plpgsql security definer set search_path=''as $$
begin
 if (to_jsonb(new)-'applied_at')is distinct from(to_jsonb(old)-'applied_at')or old.applied_at is not null and new.applied_at is distinct from old.applied_at or old.applied_at is null and new.applied_at is null then raise exception 'REQUEST_REUSE_CONFLICT'using errcode='55000';end if;
 return new;
end;$$;
create trigger catalog_growth_recipe_immutable before update on private.catalog_growth_video_recipes for each row execute function private.guard_catalog_growth_recipe_immutable();
revoke all on function private.guard_catalog_growth_recipe_immutable()from public,anon,authenticated,service_role;
create function private.prepare_catalog_growth_video_recipe(p_item uuid,p_worker text)returns void language plpgsql security definer set search_path=''as $$
declare i public.team_catalog_updater_items%rowtype;a public.team_catalog_update_attempts%rowtype;c public.team_product_catalogs%rowtype;p private.catalog_video_publication_policies%rowtype;t private.catalog_publication_targets%rowtype;s private.catalog_video_sets%rowtype;g private.catalog_growth_video_recipes%rowtype;actor uuid;rows jsonb;rev bigint;nextrow uuid:=gen_random_uuid();variant integer;target jsonb;
begin
 perform 1 from public.team_materials where id=p_item for update;
 select *into i from public.team_catalog_updater_items where catalog_material_id=p_item and lease_owner=p_worker and lease_expires_at>clock_timestamp()for update;
 if i.catalog_material_id is null then raise exception 'LEASE_MISMATCH'using errcode='55000';end if;
 select *into a from public.team_catalog_update_attempts where catalog_material_id=p_item and team_id=i.team_id and round_due_at=i.round_due_at;
 if a.attempt_id is null or a.result not in('running','unknown')then raise exception 'PROCESS_RESULT_UNCERTAIN'using errcode='55000';end if;
 if coalesce((a.profile_snapshot->>'restitch')::boolean,false)or not coalesce((a.profile_snapshot->>'growProducts')::boolean,false)then return;end if;
 perform 1 from public.team_materials where id=p_item and team_id=i.team_id for update;
 select *into c from public.team_product_catalogs where material_id=p_item and team_id=i.team_id;
 if c.product_count>=400 then return;end if;
 select *into g from private.catalog_growth_video_recipes where attempt_id=a.attempt_id;
 if g.attempt_id is not null then return;end if;
 select *into p from private.catalog_video_publication_policies where catalog_material_id=p_item and team_id=i.team_id for update;
 if p.catalog_material_id is null then return;end if;
 if exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=p_item)or exists(select 1 from private.catalog_video_publication_jobs where catalog_material_id=p_item and state in('applying','verifying','unknown','cancel_requested'))then raise exception 'PROCESS_RESULT_UNCERTAIN'using errcode='55000';end if;
 actor:=p.actor_id;
 if private.can(i.team_id,'view',actor)is not true or private.can(i.team_id,'process',actor)is not true or not private.team_workspace_allowed(i.team_id)then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
 select *into t from private.catalog_publication_targets where id=p.target_id and team_id=i.team_id;
 if t.kind='source'then
  select jsonb_agg(gen_random_uuid())into rows from generate_series(1,c.product_count+1);
  target:=jsonb_build_object('kind','source','materialId',t.source_material_id,'sourceVersion',t.source_version);
 else
  select *into s from private.catalog_video_sets where id=t.video_set_id and team_id=i.team_id for update;
  if s.state is distinct from 'ready'or exists(select 1 from private.catalog_video_variants where video_set_id=s.id and state<>'registered')or private.catalog_video_recipe_consumer_allowed(s.id,i.team_id,t.recipe_revision,p_item,actor)is not true then raise exception 'CATALOG_PUBLICATION_PENDING'using errcode='55000';end if;
  rows:=c.settings_snapshot->'_catalogRecipeRowIds';
  if jsonb_typeof(rows)is distinct from 'array'or jsonb_array_length(rows)<>c.product_count then select r.recipe_row_ids into rows from private.catalog_updater_variant_requests r where r.set_id=s.id and r.catalog_material_id=p_item and t.recipe_revision=1 order by r.created_at desc limit 1;end if;
  if rows is null then select original.checkpoint->'initialVideoPlan'->'recipeRowIds'into rows from private.catalog_generation_intents original where original.team_id=i.team_id and original.checkpoint->>'materialId'=p_item::text and original.checkpoint->'initialVideoPlan'->>'setId'=s.id::text and t.recipe_revision=1 order by original.created_at desc limit 1;end if;
  if jsonb_typeof(rows)is distinct from 'array'or jsonb_array_length(rows)<>c.product_count or(select count(*)from jsonb_array_elements_text(rows)x(id)join private.catalog_video_assignments z on z.video_set_id=s.id and z.team_id=i.team_id and z.recipe_revision=t.recipe_revision and z.recipe_row_id::text=x.id)<>c.product_count then raise exception 'PROCESS_RESULT_UNCERTAIN'using errcode='55000';end if;
  select coalesce(max(recipe_revision),0)+1 into rev from private.catalog_video_set_recipes where video_set_id=s.id and team_id=i.team_id;
  insert into private.catalog_video_set_recipes(video_set_id,team_id,recipe_revision,product_count,assignment_seed,assignment_version)values(s.id,i.team_id,rev,c.product_count+1,md5(a.attempt_id::text)||md5(a.attempt_id::text||':growth'),1);
  insert into private.catalog_video_assignments(video_set_id,team_id,recipe_revision,recipe_row_id,video_variant_index)select video_set_id,team_id,rev,recipe_row_id,video_variant_index from private.catalog_video_assignments where video_set_id=s.id and team_id=i.team_id and recipe_revision=t.recipe_revision;
  select v.video_variant_index into variant from private.catalog_video_variants v left join private.catalog_video_assignments z on z.video_set_id=v.video_set_id and z.video_variant_index=v.video_variant_index and z.recipe_revision=t.recipe_revision where v.video_set_id=s.id group by v.video_variant_index order by count(z.recipe_row_id),md5(a.attempt_id::text||v.video_variant_index::text)limit 1;
  insert into private.catalog_video_assignments(video_set_id,team_id,recipe_revision,recipe_row_id,video_variant_index)values(s.id,i.team_id,rev,nextrow,variant);
  insert into private.catalog_video_recipe_references(video_set_id,team_id,recipe_revision,catalog_material_id,update_attempt_id,actor_id)values(s.id,i.team_id,rev,p_item,a.attempt_id,actor);
  rows:=rows||jsonb_build_array(nextrow);
  target:=jsonb_build_object('kind','video_set','videoSetId',s.id,'recipeRevision',rev);
 end if;
 insert into private.catalog_growth_video_recipes(attempt_id,team_id,catalog_material_id,actor_id,base_target_id,base_revision,base_product_count,product_count,expected_update_count,mode,due_at,time_zone,target,recipe_row_ids)values(a.attempt_id,i.team_id,p_item,actor,p.target_id,p.revision,c.product_count,c.product_count+1,c.update_count+1,p.mode,p.due_at,p.time_zone,target,rows);
end;$$;
revoke all on function private.prepare_catalog_growth_video_recipe(uuid,text)from public,anon,authenticated,service_role;

create or replace function private.catalog_nonvideo_update_context(p_item uuid,p_worker text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare item public.team_catalog_updater_items%rowtype;c public.team_product_catalogs%rowtype;p private.catalog_video_publication_policies%rowtype;a public.team_catalog_update_attempts%rowtype;r private.catalog_variant_round_snapshots%rowtype;desired integer;binding jsonb;recipe_ids jsonb;growth private.catalog_growth_video_recipes%rowtype;
begin
 select * into item from public.team_catalog_updater_items where catalog_material_id=p_item and lease_owner=p_worker and lease_expires_at>clock_timestamp() and round_due_at is not null;
 if item.catalog_material_id is null then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 select * into c from public.team_product_catalogs where material_id=p_item and team_id=item.team_id;
 select * into p from private.catalog_video_publication_policies where catalog_material_id=p_item and team_id=item.team_id;
 select * into a from public.team_catalog_update_attempts where catalog_material_id=p_item and team_id=item.team_id and round_due_at=item.round_due_at;
 select * into r from private.catalog_variant_round_snapshots where attempt_id=a.attempt_id;
 if p.catalog_material_id is null or a.attempt_id is null or a.result not in('running','unknown') or private.team_workspace_allowed(item.team_id) is not true or not exists(select 1 from public.team_materials where id=p_item and team_id=item.team_id and lifecycle='active') then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 recipe_ids:=r.recipe_row_ids;
 if recipe_ids is null then select original.initial_video_plan->'recipeRowIds' into recipe_ids from private.launch_catalog_video_contexts original join private.catalog_publication_targets target on target.video_set_id=original.video_set_id and target.recipe_revision=1 where target.id=p.target_id and original.team_id=item.team_id order by original.created_at desc limit 1;end if;
 if recipe_ids is null then select intent.checkpoint->'initialVideoPlan'->'recipeRowIds' into recipe_ids from private.catalog_generation_intents intent join private.catalog_publication_targets target on target.video_set_id::text=intent.checkpoint->'initialVideoPlan'->>'setId' and target.recipe_revision=1 where target.id=p.target_id and intent.team_id=item.team_id and intent.checkpoint->>'materialId'=p_item::text order by intent.created_at desc limit 1;end if;
 if recipe_ids is null then select request.recipe_row_ids into recipe_ids from private.catalog_updater_variant_requests request join private.catalog_publication_targets target on target.video_set_id=request.set_id and target.recipe_revision=1 where target.id=p.target_id and request.catalog_material_id=p_item;end if;
 select *into growth from private.catalog_growth_video_recipes where attempt_id=a.attempt_id and team_id=item.team_id and applied_at is null;
 desired:=c.product_count;
 if growth.attempt_id is not null then
  if growth.base_target_id<>p.target_id or growth.base_revision<>p.revision or growth.base_product_count<>c.product_count then raise exception 'PROCESS_RESULT_UNCERTAIN'using errcode='55000';end if;
  desired:=growth.product_count;recipe_ids:=growth.recipe_row_ids;
 end if;
 if r.attempt_id is not null then
  if r.source_kind<>'updater' or not r.regular_released or r.regular_verified_at is not null then raise exception 'CATALOG_PUBLICATION_PENDING' using errcode='55000';end if;
  desired:=r.product_count;
 end if;
 if coalesce((a.profile_snapshot->>'growProducts')::boolean,false) and c.product_count<400 then
  -- Growth needs the exact new pending recipe, never random new row counts.
  if desired<=c.product_count or(growth.attempt_id is null and not exists(select 1 from private.catalog_publication_targets t join private.catalog_video_sets s on s.id=t.video_set_id and s.team_id=t.team_id join private.catalog_video_set_recipes recipe on recipe.video_set_id=s.id and recipe.team_id=s.team_id and recipe.recipe_revision=t.recipe_revision where t.id=p.target_id and t.kind='video_set' and s.state='ready' and recipe.product_count=desired and s.id=r.set_id)) then raise exception 'CATALOG_PUBLICATION_PENDING' using errcode='55000';end if;
 elsif desired<>c.product_count then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 binding:=jsonb_build_object('attemptId',a.attempt_id,'catalogId',p_item,'productCount',c.product_count,'desiredProductCount',desired,'recipeRowIds',recipe_ids,'policyRevision',p.revision,'targetId',p.target_id,'active',(select to_jsonb(d) from private.catalog_video_deliveries d where d.catalog_material_id=p_item));
 return jsonb_build_object('attemptId',a.attempt_id,'recipeRowIds',recipe_ids,'previousMarker',(select previous.actual_changes->>'_nativeNonVideoMarker' from public.team_catalog_update_attempts previous where previous.catalog_material_id=p_item and previous.delivery_verified_at is not null and previous.actual_changes?'_nativeNonVideoMarker' and previous.attempt_id<>a.attempt_id order by previous.started_at desc limit 1),'currentProductCount',c.product_count,'productCount',desired,'fileId',(select m.drive_file_id from public.team_materials m where m.id=p_item),'credentialId',(select d.credential_id from public.team_materials m join public.team_drive_connections d on d.id=m.connection_id and d.team_id=m.team_id where m.id=p_item and d.state='connected'),'rootFolderId',(select d.root_folder_id from public.team_materials m join public.team_drive_connections d on d.id=m.connection_id and d.team_id=m.team_id where m.id=p_item and d.state='connected'),'contextToken',encode(pg_catalog.sha256(convert_to(binding::text,'UTF8')),'hex'));
end;$$;

create function public.service_prepare_catalog_nonvideo_update_context(p_item uuid,p_worker text)returns jsonb language plpgsql security definer set search_path=''as $$
begin
 perform private.prepare_catalog_growth_video_recipe(p_item,p_worker);
 return private.catalog_nonvideo_update_context(p_item,p_worker);
end;$$;
revoke all on function public.service_prepare_catalog_nonvideo_update_context(uuid,text)from public,anon,authenticated;
grant execute on function public.service_prepare_catalog_nonvideo_update_context(uuid,text)to service_role;

create or replace function public.service_begin_catalog_nonvideo_update_write(p_item uuid,p_worker text,p_marker uuid,p_baseline_version text,p_expected_count integer,p_product_count integer,p_settings_snapshot jsonb,p_context_token text) returns boolean language plpgsql security definer set search_path='' as $$
declare context jsonb;
begin
 perform 1 from public.team_materials where id=p_item for update;
 context:=private.catalog_nonvideo_update_context(p_item,p_worker);
 if context->>'contextToken' is distinct from p_context_token or (context->>'productCount')::integer is distinct from p_product_count then return false;end if;
 if exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=p_item) or exists(select 1 from private.catalog_video_publication_jobs job join private.catalog_video_publication_policies policy on policy.catalog_material_id=job.catalog_material_id and policy.revision=job.revision left join private.catalog_publication_cell_writes frozen on frozen.job_id=job.id where job.catalog_material_id=p_item and job.state not in('published','held','superseded') and (job.dispatched_at is not null or job.writer_fence is not null or (frozen.job_id is not null and jsonb_array_length(frozen.payload->'products')<>p_product_count and not exists(select 1 from private.catalog_growth_video_recipes growth where growth.attempt_id=(context->>'attemptId')::uuid and growth.base_target_id=job.target_id and growth.base_revision=job.revision and growth.product_count=p_product_count and growth.applied_at is null)))) then return false;end if;
 if jsonb_typeof(p_settings_snapshot->'_catalogPublicIds') is distinct from 'array' or jsonb_array_length(p_settings_snapshot->'_catalogPublicIds')<>p_product_count or (select count(distinct value) from jsonb_array_elements_text(p_settings_snapshot->'_catalogPublicIds'))<>p_product_count then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 update public.team_catalog_update_attempts set actual_changes=coalesce(actual_changes,'{}'::jsonb)||jsonb_build_object('_nativeNonVideoMarker',p_marker) where attempt_id=(context->>'attemptId')::uuid;
 return private.publication_legacy_begin_catalog_update_write(p_item,p_worker,p_marker,p_baseline_version,p_expected_count,null,p_product_count,p_settings_snapshot||jsonb_build_object('_nativeNonVideoWrite',1));
end;$$;
create function private.apply_catalog_growth_video_recipe(p_catalog uuid)returns void language plpgsql security definer set search_path=''as $$
declare g private.catalog_growth_video_recipes%rowtype;c public.team_product_catalogs%rowtype;p private.catalog_video_publication_policies%rowtype;tid uuid;receipt jsonb;
begin
 perform 1 from public.team_materials where id=p_catalog for update;
 select *into c from public.team_product_catalogs where material_id=p_catalog;
 select growth.*into g from private.catalog_growth_video_recipes growth join public.team_catalog_update_attempts original on original.attempt_id=growth.attempt_id join private.catalog_update_reconciliations rec on rec.catalog_material_id=growth.catalog_material_id and rec.marker::text=original.actual_changes->>'_nativeNonVideoMarker'and rec.publication_job_id is null where growth.catalog_material_id=p_catalog and growth.applied_at is null and growth.expected_update_count=c.update_count and growth.recipe_row_ids=c.settings_snapshot->'_catalogRecipeRowIds'order by growth.attempt_id limit 1 for update of growth;
 if g.attempt_id is null then return;end if;
 if not exists(select 1 from private.catalog_update_reconciliations rec join public.team_catalog_update_attempts a on a.attempt_id=g.attempt_id where rec.catalog_material_id=p_catalog and rec.publication_job_id is null and rec.expected_count=g.expected_update_count and rec.product_count=g.product_count and rec.settings_snapshot->>'_nativeNonVideoWrite'='1'and rec.settings_snapshot->'_catalogRecipeRowIds'=g.recipe_row_ids and rec.settings_snapshot->'_catalogPublicIds'=c.settings_snapshot->'_catalogPublicIds'and a.actual_changes->>'_nativeNonVideoMarker'=rec.marker::text)or c.product_count<>g.product_count or c.settings_snapshot->'_catalogRecipeRowIds' is distinct from g.recipe_row_ids or jsonb_typeof(c.settings_snapshot->'_catalogPublicIds')is distinct from 'array'or jsonb_array_length(c.settings_snapshot->'_catalogPublicIds')<>g.product_count or not exists(select 1 from public.team_catalog_update_attempts a where a.attempt_id=g.attempt_id and a.actual_changes?'_nativeNonVideoMarker')then raise exception 'PROCESS_RESULT_UNCERTAIN'using errcode='55000';end if;
 select *into p from private.catalog_video_publication_policies where catalog_material_id=p_catalog and team_id=g.team_id for update;
 if p.revision<>g.base_revision or p.target_id<>g.base_target_id or p.mode<>g.mode or p.due_at is distinct from g.due_at or p.time_zone is distinct from g.time_zone or exists(select 1 from private.catalog_video_publication_jobs where catalog_material_id=p_catalog and (writer_fence is not null or dispatched_at is not null)and state not in('published','superseded'))then raise exception 'PROCESS_RESULT_UNCERTAIN'using errcode='55000';end if;
 if g.target->>'kind'='source'then tid:=g.base_target_id;
 else
  if private.catalog_video_recipe_consumer_allowed((g.target->>'videoSetId')::uuid,g.team_id,(g.target->>'recipeRevision')::bigint,p_catalog,g.actor_id)is not true then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
  insert into private.catalog_publication_targets(team_id,kind,video_set_id,recipe_revision)values(g.team_id,'video_set',(g.target->>'videoSetId')::uuid,(g.target->>'recipeRevision')::bigint)returning id into tid;
 end if;
 update private.catalog_video_publication_jobs set state='superseded',worker_id=null,lease_until=null where catalog_material_id=p_catalog and state not in('published','superseded');
 update private.catalog_video_publication_policies set target_id=tid,revision=revision+1,updated_at=clock_timestamp()where catalog_material_id=p_catalog;
 insert into private.catalog_video_publication_jobs(catalog_material_id,team_id,actor_id,revision,command_id,target_id,state,blocked_reason)values(p_catalog,g.team_id,g.actor_id,g.base_revision+1,g.command_id,tid,case when g.mode='held'then 'held'when p.legacy_delivery_unverified and not exists(select 1 from private.catalog_video_deliveries where catalog_material_id=p_catalog)then 'blocked'else 'waiting'end,case when g.mode<>'held'and p.legacy_delivery_unverified and not exists(select 1 from private.catalog_video_deliveries where catalog_material_id=p_catalog)then 'legacy_adoption_required'end);
 receipt:=public.service_read_catalog_publication(g.team_id,g.actor_id,p_catalog);
 insert into private.catalog_publication_commands(request_id,team_id,actor_id,payload,receipt)values(g.command_id,g.team_id,g.actor_id,jsonb_build_object('catalogId',p_catalog,'expectedRevision',g.base_revision,'mode',g.mode,'dueAt',g.due_at,'timeZone',g.time_zone,'target',g.target),receipt);
 update private.catalog_growth_video_recipes set applied_at=clock_timestamp()where attempt_id=g.attempt_id;
 insert into public.team_catalog_events(team_id,material_id,event_kind)values(g.team_id,p_catalog,'sync_state');
end;$$;
revoke all on function private.apply_catalog_growth_video_recipe(uuid)from public,anon,authenticated,service_role;
alter function private.rebind_pending_catalog_video_cells(uuid)rename to rebind_pending_catalog_video_cells_before_growth;
revoke all on function private.rebind_pending_catalog_video_cells_before_growth(uuid)from public,anon,authenticated,service_role;
create function private.rebind_pending_catalog_video_cells(p_catalog uuid)returns integer language plpgsql security definer set search_path=''as $$
begin
 perform private.apply_catalog_growth_video_recipe(p_catalog);
 return private.rebind_pending_catalog_video_cells_before_growth(p_catalog);
end;$$;
revoke all on function private.rebind_pending_catalog_video_cells(uuid)from public,anon,authenticated,service_role;
create view public.analytics_catalog_growth_video_recipes with(security_barrier=true)as
 select attempt_id,team_id,actor_id,catalog_material_id,command_id,base_revision,base_product_count,product_count,
 target->>'kind'target_kind,case when target->>'kind'='video_set'then(target->>'videoSetId')::uuid end video_set_id,
 case when target->>'kind'='video_set'then(target->>'recipeRevision')::bigint end recipe_revision,
 applied_at is not null target_bound,applied_at
 from private.catalog_growth_video_recipes;
revoke all on public.analytics_catalog_growth_video_recipes from public,anon,authenticated;
grant select on public.analytics_catalog_growth_video_recipes to service_role;
do $$begin if exists(select 1 from pg_roles where rolname='wishly_analytics_ro')then grant select on public.analytics_catalog_growth_video_recipes to wishly_analytics_ro;end if;end$$;
commit;
