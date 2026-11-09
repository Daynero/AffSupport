-- Same-table publication. Atomic Sheets batch receipt is NOT external-cell CAS.
begin;
create table private.catalog_publication_cell_writes(
 job_id uuid primary key references private.catalog_video_publication_jobs(id),
 team_id uuid not null references public.teams(id),catalog_material_id uuid not null references public.team_materials(id),
 target_id uuid not null references private.catalog_publication_targets(id),
 connection_id uuid not null references public.team_drive_connections(id),file_id text not null,
 payload jsonb not null check(jsonb_typeof(payload)='object'),created_at timestamptz not null default clock_timestamp()
);
alter table private.catalog_publication_cell_writes enable row level security;
alter table private.catalog_publication_cell_writes force row level security;
revoke all on private.catalog_publication_cell_writes from public,anon,authenticated,service_role;
create trigger task_cleanup_reference_fence before insert or update on private.catalog_publication_cell_writes for each row execute function private.guard_task_cleanup_reference();

alter table private.catalog_video_publication_jobs add column preparation_error_code text check(preparation_error_code in('SOURCE_CHANGED','PERMISSION_DENIED','SHARE_NOT_ALLOWED','DRIVE_UNAVAILABLE','RATE_LIMITED','PROCESS_RESULT_UNCERTAIN','INVALID_RESPONSE')),add column preparation_error_at timestamptz,add column validation_epoch_started_at timestamptz;
create table private.catalog_publication_link_receipts(
 job_id uuid not null references private.catalog_video_publication_jobs(id),material_id uuid not null references public.team_materials(id),
 source_version text not null,url text not null check(length(url)between 1 and 8192),prepared_at timestamptz not null default clock_timestamp(),due_verified_at timestamptz,
 primary key(job_id,material_id)
);
alter table private.catalog_publication_link_receipts enable row level security;
alter table private.catalog_publication_link_receipts force row level security;
revoke all on private.catalog_publication_link_receipts from public,anon,authenticated,service_role;
create trigger task_cleanup_reference_fence before insert or update on private.catalog_publication_link_receipts for each row execute function private.guard_task_cleanup_reference();
-- Backend-only trusted preparation context. URLs never reach browser/analytics.
create function private.catalog_publication_job_actor_allowed(p_job uuid)returns boolean language sql stable security definer set search_path='' as $$
 select private.can(j.team_id,'view',j.actor_id) and (private.can(j.team_id,'process',j.actor_id) or (t.kind='source' and private.can(j.team_id,'upload',j.actor_id) and exists(select 1 from private.catalog_generation_intents i where i.team_id=j.team_id and i.actor_id=j.actor_id and i.checkpoint->>'materialId'=j.catalog_material_id::text and i.request_payload->>'restitchEnabled'='false' and i.request_payload->>'catalogVideoProtocolVersion'='1' and i.video_material_id=t.source_material_id))) from private.catalog_video_publication_jobs j join private.catalog_publication_targets t on t.id=j.target_id where j.id=p_job
$$;
revoke all on function private.catalog_publication_job_actor_allowed(uuid)from public,anon,authenticated,service_role;
create function public.service_catalog_publication_cells_context(p_job uuid,p_worker uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j private.catalog_video_publication_jobs%rowtype;p private.catalog_video_publication_policies%rowtype;t private.catalog_publication_targets%rowtype;m public.team_materials%rowtype;c public.team_drive_connections%rowtype;catalog public.team_product_catalogs%rowtype;row_ids jsonb;source_rows jsonb;s private.catalog_video_sets%rowtype;stored private.catalog_publication_cell_writes%rowtype;public_ids jsonb;
begin
 select * into j from private.catalog_video_publication_jobs where id=p_job;
 select * into p from private.catalog_video_publication_policies where catalog_material_id=j.catalog_material_id;
 if j.id is null or j.worker_id is distinct from p_worker or j.lease_until is null or j.lease_until<=clock_timestamp() or j.revision<>p.revision then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 if private.catalog_publication_job_actor_allowed(j.id) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into m from public.team_materials where id=j.catalog_material_id and team_id=j.team_id and lifecycle='active';
 select * into c from public.team_drive_connections where id=m.connection_id and team_id=j.team_id and state='connected';
 select * into catalog from public.team_product_catalogs where material_id=m.id;
 if m.id is null or c.id is null or catalog.material_id is null then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 if (p.mode='immediate'or p.mode='scheduled'and p.due_at<=clock_timestamp())and j.validation_epoch_started_at is null then update private.catalog_video_publication_jobs set validation_epoch_started_at=clock_timestamp()where id=j.id returning * into j;end if;
 if j.dispatched_at is not null and j.validation_epoch_started_at<clock_timestamp()-interval '5 minutes' and coalesce((select max(coalesce(receipt.due_verified_at,receipt.prepared_at))from private.catalog_publication_link_receipts receipt where receipt.job_id=j.id),j.validation_epoch_started_at)<clock_timestamp()-interval '5 minutes'then update private.catalog_video_publication_jobs set validation_epoch_started_at=clock_timestamp()where id=j.id returning * into j;end if;
 if j.dispatched_at is null and j.validation_epoch_started_at<clock_timestamp()-interval '1 hour'then update private.catalog_video_publication_jobs set state='blocked',blocked_reason='target_unavailable',preparation_error_code='DRIVE_UNAVAILABLE',preparation_error_at=clock_timestamp()where id=j.id;return jsonb_build_object('state','blocked','reason','validation_epoch_expired');end if;
 select * into stored from private.catalog_publication_cell_writes where job_id=j.id;
 if stored.job_id is not null then
  if stored.file_id<>m.drive_file_id or stored.connection_id<>m.connection_id or stored.target_id<>j.target_id then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;

 end if;
 if stored.job_id is null and (j.dispatched_at is not null or p.mode='held' or p.legacy_delivery_unverified) then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into t from private.catalog_publication_targets where id=j.target_id and team_id=j.team_id;
 if t.kind='video_set' then
  select * into s from private.catalog_video_sets where id=t.video_set_id and team_id=j.team_id;
  if exists(select 1 from private.catalog_variant_round_snapshots r where r.set_id=s.id and r.source_kind='updater' and r.regular_verified_at is null) then return jsonb_build_object('state','waiting');end if;
  if s.state is distinct from 'ready' then return jsonb_build_object('state','waiting');end if;
  if private.catalog_video_recipe_consumer_allowed(s.id,j.team_id,t.recipe_revision,j.catalog_material_id,j.actor_id) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
  select i.checkpoint->'initialVideoPlan'->'recipeRowIds' into row_ids from private.catalog_generation_intents i where i.team_id=j.team_id and i.checkpoint->>'materialId'=j.catalog_material_id::text and i.checkpoint->'initialVideoPlan'->>'setId'=s.id::text order by i.created_at limit 1;
  if row_ids is null then select r.recipe_row_ids into row_ids from private.catalog_updater_variant_requests r where r.set_id=s.id and r.team_id=j.team_id and r.catalog_material_id=j.catalog_material_id;end if;
  if row_ids is null then select r.recipe_row_ids into row_ids from private.catalog_variant_round_snapshots r where r.set_id=s.id and r.team_id=j.team_id and r.catalog_material_id=j.catalog_material_id;end if;
  if jsonb_typeof(catalog.settings_snapshot->'_catalogRecipeRowIds')='array' and jsonb_array_length(catalog.settings_snapshot->'_catalogRecipeRowIds')=catalog.product_count and (select count(*)from jsonb_array_elements_text(catalog.settings_snapshot->'_catalogRecipeRowIds') actual(id)join private.catalog_video_assignments assignment on assignment.recipe_row_id::text=actual.id and assignment.video_set_id=s.id and assignment.recipe_revision=t.recipe_revision)=catalog.product_count then row_ids:=catalog.settings_snapshot->'_catalogRecipeRowIds';end if;
  if row_ids is null or jsonb_array_length(row_ids)<>catalog.product_count then return jsonb_build_object('state','waiting');end if;
  if (select count(*) from private.catalog_video_variants where video_set_id=s.id and state='registered')<>s.requested_count or exists(select 1 from private.catalog_video_variants v left join public.team_materials output on output.id=v.output_material_id and output.team_id=j.team_id left join public.team_operations original on original.id=v.operation_id and original.team_id=j.team_id where v.video_set_id=s.id and (v.state<>'registered' or output.lifecycle is distinct from 'active' or original.state is distinct from 'succeeded' or original.source_material_id is distinct from s.source_material_id or original.result_material_id is distinct from v.output_material_id or not exists(select 1 from private.team_operation_intents original_intent where original_intent.operation_id=original.id and original_intent.tool_id='restitch' and original_intent.expected_source_version=s.source_version))) then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
  select jsonb_agg(jsonb_build_object('rowId',a.recipe_row_id,'materialId',output.id,'connectionId',output.connection_id,'sourceVersion',private.catalog_publication_source_version(output.id,j.team_id),'fileId',output.drive_file_id,'credentialId',conn.credential_id,'rootFolderId',conn.root_folder_id)) into source_rows from private.catalog_video_assignments a join private.catalog_video_variants v on v.video_set_id=a.video_set_id and v.video_variant_index=a.video_variant_index join public.team_materials output on output.id=v.output_material_id and output.team_id=j.team_id join public.team_drive_connections conn on conn.id=output.connection_id and conn.team_id=j.team_id and conn.state='connected' where a.video_set_id=s.id and a.team_id=j.team_id and a.recipe_revision=t.recipe_revision;
  select jsonb_agg(output.value order by recipe.ordinality) into source_rows from jsonb_array_elements_text(row_ids)with ordinality recipe(id,ordinality) join jsonb_array_elements(source_rows)output(value) on output.value->>'rowId'=recipe.id;
  if source_rows is null or jsonb_array_length(source_rows)<>catalog.product_count then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 else
  if private.catalog_publication_source_version(t.source_material_id,j.team_id) is distinct from t.source_version then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
  select jsonb_build_array(jsonb_build_object('materialId',src.id,'connectionId',src.connection_id,'sourceVersion',t.source_version,'fileId',src.drive_file_id,'credentialId',conn.credential_id,'rootFolderId',conn.root_folder_id)) into source_rows from public.team_materials src join public.team_drive_connections conn on conn.id=src.connection_id and conn.team_id=j.team_id and conn.state='connected' where src.id=t.source_material_id and src.team_id=j.team_id and src.lifecycle='active';
  if source_rows is null then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 end if;
 select jsonb_agg(generated_cell.value->0->>'v' order by generated_cell.ordinality) into public_ids from private.catalog_generation_intents i cross join lateral jsonb_array_elements(i.checkpoint->'sheetRows')with ordinality generated_cell(value,ordinality) where i.team_id=j.team_id and i.checkpoint->>'materialId'=j.catalog_material_id::text and generated_cell.ordinality>2 and (t.kind='source' or i.checkpoint->'initialVideoPlan'->>'setId'=t.video_set_id::text);
 if (t.kind='source' or catalog.settings_snapshot->'_catalogRecipeRowIds'=row_ids) and jsonb_typeof(catalog.settings_snapshot->'_catalogPublicIds')='array' then public_ids:=catalog.settings_snapshot->'_catalogPublicIds';end if;
 if public_ids is not null and jsonb_array_length(public_ids)<>catalog.product_count then public_ids:=null;end if;
 return jsonb_build_object('previousMarker',(select old.writer_fence::text from private.catalog_video_publication_jobs old join private.catalog_video_deliveries active on active.catalog_material_id=old.catalog_material_id and active.target_id=old.target_id where old.catalog_material_id=j.catalog_material_id and old.state='published' and old.provider_revision=active.provider_revision order by old.verified_at desc limit 1),'phase',case when p.mode='immediate' or p.mode='scheduled' and p.due_at<=clock_timestamp()then 'due'else 'eager'end,'links',(select coalesce(jsonb_agg(jsonb_build_object('materialId',receipt.material_id,'sourceVersion',receipt.source_version,'url',receipt.url,'dueVerified',coalesce((receipt.due_verified_at>=j.validation_epoch_started_at or receipt.prepared_at>=coalesce(j.validation_epoch_started_at,clock_timestamp())-interval '5 minutes'),false))),'[]'::jsonb)from private.catalog_publication_link_receipts receipt where receipt.job_id=j.id),'recipeRowIds',row_ids,'publicIds',public_ids,'prepared',stored.payload,'state','ready','credentialId',c.credential_id,'rootFolderId',c.root_folder_id,'fileId',m.drive_file_id,'productCount',catalog.product_count,'sources',source_rows,'sourceOnly',t.kind='source');
end $$;
create function public.service_prepare_catalog_publication_cells(p_job uuid,p_worker uuid,p_payload jsonb)returns jsonb language plpgsql security definer set search_path='' as $$
declare j private.catalog_video_publication_jobs%rowtype;m public.team_materials%rowtype;previous private.catalog_publication_cell_writes%rowtype;context jsonb;
begin
 select * into j from private.catalog_video_publication_jobs where id=p_job for update;
 context:=public.service_catalog_publication_cells_context(p_job,p_worker);
 select * into previous from private.catalog_publication_cell_writes where job_id=p_job;
 if previous.job_id is not null then if previous.payload is distinct from p_payload then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;return previous.payload;end if;
 if context->>'state' is distinct from 'ready' or j.dispatched_at is not null or jsonb_typeof(p_payload) is distinct from 'object' or p_payload->>'fileId' is distinct from context->>'fileId' or jsonb_typeof(p_payload->'products') is distinct from 'array' or jsonb_array_length(p_payload->'products')<>(context->>'productCount')::integer or p_payload->>'markerKey' is distinct from 'soty_video_publication' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if octet_length(p_payload::text)>4194304 or p_payload->>'rootFolderId' is distinct from context->>'rootFolderId' or p_payload->>'sheetName' is distinct from 'catalog_products' or p_payload->>'idColumn' is distinct from '0' or p_payload->>'videoColumn' is distinct from '25' or p_payload#>>'{idHeaders,1}' is distinct from 'id' or p_payload#>>'{videoHeaders,1}' is distinct from 'video[0].url' or coalesce(p_payload->'recipeRowIds','null'::jsonb)is distinct from coalesce(context->'recipeRowIds','null'::jsonb)or (select count(distinct product.value->>'id')from jsonb_array_elements(p_payload->'products')product(value))<>(context->>'productCount')::integer then raise exception 'INVALID_INPUT'using errcode='22023';end if;
 if exists(select 1 from jsonb_array_elements(p_payload->'products')with ordinality product(value,ordinality)where not exists(select 1 from private.catalog_publication_link_receipts receipt where receipt.job_id=j.id and receipt.material_id=(case when context->>'sourceOnly'='true'then context#>>'{sources,0,materialId}'else context->'sources'->((product.ordinality-1)::integer)->>'materialId'end)::uuid and receipt.url=product.value->>'url')or (jsonb_typeof(context->'publicIds')='array'and product.value->'id'is distinct from context->'publicIds'->((product.ordinality-1)::integer)))then raise exception 'SOURCE_CHANGED'using errcode='55000';end if;
 select * into m from public.team_materials where id=j.catalog_material_id;
 insert into private.catalog_publication_cell_writes(job_id,team_id,catalog_material_id,target_id,connection_id,file_id,payload)values(j.id,j.team_id,j.catalog_material_id,j.target_id,m.connection_id,m.drive_file_id,p_payload);
 return p_payload;
end $$;
revoke all on function public.service_catalog_publication_cells_context(uuid,uuid),public.service_prepare_catalog_publication_cells(uuid,uuid,jsonb)from public,anon,authenticated;
grant execute on function public.service_catalog_publication_cells_context(uuid,uuid),public.service_prepare_catalog_publication_cells(uuid,uuid,jsonb)to service_role;

-- Reclaim only the original dispatched fence for READ-ONLY reconciliation.
-- Unknown jobs are never returned as undispatched retry candidates.
do $claim$
declare definition text;
begin
 select pg_get_functiondef('public.service_claim_catalog_publication_jobs(uuid,integer)'::regprocedure) into definition;
 definition:=replace(definition,
  'q.state in(''waiting'',''preparing'',''retry_wait'') and q.dispatched_at is null',
  '(q.state in(''waiting'',''preparing'',''retry_wait'') and q.dispatched_at is null or q.state in(''applying'',''verifying'',''unknown'') and q.dispatched_at is not null and q.writer_fence is not null)');
 definition:=replace(definition,'private.can(j.team_id,''process'',j.actor_id)','private.catalog_publication_job_actor_allowed(j.id)');
 execute definition;
end $claim$;
do $authority$
declare signature text;definition text;
begin
 foreach signature in array array['public.service_reserve_catalog_publication(uuid,uuid)','public.service_dispatch_catalog_publication(uuid,uuid,uuid)']loop
 select pg_get_functiondef(signature::regprocedure)into definition;
 definition:=replace(definition,'private.can(j.team_id,''process'',j.actor_id)','private.catalog_publication_job_actor_allowed(j.id)');execute definition;
 end loop;
end $authority$;
create function public.service_requeue_catalog_publication_cell_jobs()returns integer language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 with candidates as(select j.id from private.catalog_video_publication_jobs j join private.catalog_video_publication_policies p on p.catalog_material_id=j.catalog_material_id and p.revision=j.revision where j.state='blocked' and j.blocked_reason='writer_unsupported' and j.writer_fence is null and j.dispatched_at is null and p.mode<>'held' and not p.legacy_delivery_unverified order by j.created_at limit 3 for update of j skip locked)
 update private.catalog_video_publication_jobs j set state='retry_wait',blocked_reason=null,next_attempt_at=clock_timestamp() from candidates c where j.id=c.id;get diagnostics n=row_count;return n;
end $$;
revoke all on function public.service_requeue_catalog_publication_cell_jobs()from public,anon,authenticated;
grant execute on function public.service_requeue_catalog_publication_cell_jobs()to service_role;

-- Healthy dependency preparation follows the existing cron cadence, not an
-- additional minute of delay per bounded batch.
do $cadence$
declare signature text;definition text;
begin
 foreach signature in array array['public.service_defer_catalog_publication(uuid,uuid,text)','public.service_settle_catalog_publication(uuid,uuid,uuid,text,text)']loop
 select pg_get_functiondef(signature::regprocedure)into definition;
 definition:=replace(definition,'interval ''1 minute''','interval ''0 seconds''');
 definition:=replace(definition,'set state=''unknown'' where id=j.id','set state=''unknown'',lease_until=clock_timestamp(),next_attempt_at=clock_timestamp() where id=j.id');execute definition;
 end loop;
end $cadence$;

-- Eager preparation uses the same existing cron lane and no provider sheet write.
create function public.service_claim_catalog_publication_preparations(p_worker uuid,p_limit integer default 3)returns jsonb language plpgsql security definer set search_path='' as $$
declare answer jsonb;
begin
 if p_worker is null or p_limit not between 1 and 3 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 with candidates as(select j.id from private.catalog_video_publication_jobs j join private.catalog_video_publication_policies p on p.catalog_material_id=j.catalog_material_id and p.revision=j.revision where j.dispatched_at is null and j.writer_fence is null and j.state in('waiting','preparing','retry_wait') and p.mode<>'held' and not p.legacy_delivery_unverified and j.next_attempt_at<=clock_timestamp()and (j.lease_until is null or j.lease_until<clock_timestamp()) and not exists(select 1 from private.catalog_publication_cell_writes prepared where prepared.job_id=j.id) order by j.next_attempt_at,j.created_at limit p_limit for update of j skip locked), claimed as(update private.catalog_video_publication_jobs j set worker_id=p_worker,lease_until=clock_timestamp()+interval '2 minutes' from candidates c where j.id=c.id returning j.id,j.team_id,j.actor_id)
 select coalesce(jsonb_agg(jsonb_build_object('jobId',id,'teamId',team_id,'actorId',actor_id)),'[]'::jsonb)into answer from claimed;return answer;
end $$;
create function public.service_release_catalog_publication_preparation(p_job uuid,p_worker uuid,p_error_code text default null)returns boolean language plpgsql security definer set search_path='' as $$
begin
 if p_error_code is not null and p_error_code not in('SOURCE_CHANGED','PERMISSION_DENIED','SHARE_NOT_ALLOWED','DRIVE_UNAVAILABLE','RATE_LIMITED','PROCESS_RESULT_UNCERTAIN','INVALID_RESPONSE')then raise exception 'INVALID_INPUT'using errcode='22023';end if;
 update private.catalog_video_publication_jobs set worker_id=case when writer_fence is null and dispatched_at is null then null else worker_id end,lease_until=case when writer_fence is null and dispatched_at is null then null else lease_until end,next_attempt_at=clock_timestamp()+case when p_error_code is null then interval '0 seconds'else interval '30 seconds'end,preparation_error_code=p_error_code,preparation_error_at=case when p_error_code is not null then clock_timestamp()else null end where id=p_job and worker_id=p_worker;return found;
end $$;
revoke all on function public.service_claim_catalog_publication_preparations(uuid,integer),public.service_release_catalog_publication_preparation(uuid,uuid,text)from public,anon,authenticated;
grant execute on function public.service_claim_catalog_publication_preparations(uuid,integer),public.service_release_catalog_publication_preparation(uuid,uuid,text)to service_role;

-- Called ONLY after ordinary provider readback has frozen the new actual IDs.
-- Rebind public IDs; retain the same URL per canonical recipe-row ordinal.
create function private.rebind_pending_catalog_video_cells(p_catalog uuid)returns integer language plpgsql security definer set search_path='' as $$
declare prepared private.catalog_publication_cell_writes%rowtype;j private.catalog_video_publication_jobs%rowtype;c public.team_product_catalogs%rowtype;products jsonb;count_updated integer:=0;
begin
 perform 1 from public.team_materials where id=p_catalog for update;
 select * into c from public.team_product_catalogs where material_id=p_catalog;
 if jsonb_typeof(c.settings_snapshot->'_catalogPublicIds') is distinct from 'array' or jsonb_array_length(c.settings_snapshot->'_catalogPublicIds')<>c.product_count then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 for j in select job.* from private.catalog_video_publication_jobs job join private.catalog_video_publication_policies policy on policy.catalog_material_id=job.catalog_material_id and policy.revision=job.revision where job.catalog_material_id=p_catalog and job.state not in('published','superseded','held') for update of job
 loop
  if j.writer_fence is not null or j.dispatched_at is not null then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
  select * into prepared from private.catalog_publication_cell_writes where job_id=j.id for update;
  if prepared.job_id is null then continue;end if;
  if jsonb_array_length(prepared.payload->'products')<>c.product_count then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
  if exists(select 1 from private.catalog_publication_targets target where target.id=j.target_id and target.kind='video_set' and (c.settings_snapshot->'_catalogRecipeRowIds' is distinct from prepared.payload->'recipeRowIds' or not exists(select 1 from jsonb_array_elements_text(c.settings_snapshot->'_catalogRecipeRowIds') actual(id) join private.catalog_video_assignments assignment on assignment.recipe_row_id::text=actual.id where assignment.video_set_id=target.video_set_id and assignment.recipe_revision=target.recipe_revision having count(*)=c.product_count))) then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
  select jsonb_agg(jsonb_set(old.value,'{id}',new.value) order by old.ordinality)into products from jsonb_array_elements(prepared.payload->'products')with ordinality old(value,ordinality) join jsonb_array_elements(c.settings_snapshot->'_catalogPublicIds')with ordinality new(value,ordinality)on new.ordinality=old.ordinality;
  update private.catalog_publication_cell_writes set payload=jsonb_set(payload,'{products}',products)where job_id=j.id;count_updated:=count_updated+1;
 end loop;return count_updated;
end $$;
revoke all on function private.rebind_pending_catalog_video_cells(uuid)from public,anon,authenticated,service_role;

create function public.service_record_catalog_publication_link(p_job uuid,p_worker uuid,p_material uuid,p_source_version text,p_url text)returns boolean language plpgsql security definer set search_path='' as $$
declare context jsonb;previous private.catalog_publication_link_receipts%rowtype;
begin
 context:=public.service_catalog_publication_cells_context(p_job,p_worker);
 if context->>'state' is distinct from 'ready' or p_url is null or length(p_url)>8192 or p_url not like 'https://drive.google.com/file/d/%/view?usp=sharing%' or not exists(select 1 from jsonb_array_elements(context->'sources')source(value)where source.value->>'materialId'=p_material::text and source.value->>'sourceVersion'=p_source_version and (p_url='https://drive.google.com/file/d/'||(source.value->>'fileId')||'/view?usp=sharing' or left(p_url,length('https://drive.google.com/file/d/'||(source.value->>'fileId')||'/view?usp=sharing&resourcekey='))='https://drive.google.com/file/d/'||(source.value->>'fileId')||'/view?usp=sharing&resourcekey='))then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 select * into previous from private.catalog_publication_link_receipts where job_id=p_job and material_id=p_material for update;
 if previous.job_id is not null and (previous.source_version<>p_source_version or previous.url<>p_url)then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 insert into private.catalog_publication_link_receipts(job_id,material_id,source_version,url,due_verified_at)values(p_job,p_material,p_source_version,p_url,case when context->>'phase'='due'then clock_timestamp()else null end)
 on conflict(job_id,material_id)do update set due_verified_at=case when context->>'phase'='due'then clock_timestamp()else private.catalog_publication_link_receipts.due_verified_at end;
 return true;
end $$;
revoke all on function public.service_record_catalog_publication_link(uuid,uuid,uuid,text,text)from public,anon,authenticated;
grant execute on function public.service_record_catalog_publication_link(uuid,uuid,uuid,text,text)to service_role;
create view public.analytics_catalog_publication_preparations with(security_barrier=true)as
 select j.id job_id,j.catalog_material_id,j.team_id,j.actor_id,j.created_at job_created_at,j.state job_state,policy.mode publication_mode,policy.due_at,
 case when t.kind='source'then 1 else video_set.requested_count end required_unique_links,
 (select count(*)::integer from private.catalog_publication_link_receipts r where r.job_id=j.id)prepared_unique_links,
 (select count(*)::integer from private.catalog_publication_link_receipts r where r.job_id=j.id and (r.due_verified_at>=j.validation_epoch_started_at or r.prepared_at>=coalesce(j.validation_epoch_started_at,clock_timestamp())-interval '5 minutes'))due_verified_unique_links,
 (select min(coalesce(r.due_verified_at,r.prepared_at))from private.catalog_publication_link_receipts r where r.job_id=j.id)first_source_observed_at,
 (select max(coalesce(r.due_verified_at,r.prepared_at))from private.catalog_publication_link_receipts r where r.job_id=j.id)last_source_observed_at,
 (select min(r.due_verified_at)from private.catalog_publication_link_receipts r where r.job_id=j.id)first_due_source_observed_at,
 (select max(r.due_verified_at)from private.catalog_publication_link_receipts r where r.job_id=j.id)last_due_source_observed_at,
 exists(select 1 from private.catalog_publication_cell_writes w where w.job_id=j.id)private_mapping_prepared,
 j.preparation_error_code,j.preparation_error_at,j.validation_epoch_started_at,coalesce((j.dispatched_at is null and j.validation_epoch_started_at<clock_timestamp()-interval '1 hour'),false)validation_epoch_expired,'video_columns'::text writer_protocol,clock_timestamp()observed_at
 from private.catalog_video_publication_jobs j join private.catalog_video_publication_policies policy on policy.catalog_material_id=j.catalog_material_id and policy.revision=j.revision join private.catalog_publication_targets t on t.id=j.target_id left join private.catalog_video_sets video_set on video_set.id=t.video_set_id;
revoke all on public.analytics_catalog_publication_preparations from public,anon,authenticated,service_role;
do $$begin if exists(select 1 from pg_roles where rolname='wishly_analytics_ro')then grant select on public.analytics_catalog_publication_preparations to wishly_analytics_ro;end if;end$$;
alter function private.launch_catalog_recovery_due()rename to catalog_video_cells_recovery_due_before_prepare;
create function private.launch_catalog_recovery_due()returns boolean language sql stable security definer set search_path='' as $$
 select private.catalog_video_cells_recovery_due_before_prepare()or exists(select 1 from private.catalog_video_publication_jobs original where original.state in('applying','verifying','unknown')and original.writer_fence is not null and original.dispatched_at is not null and original.next_attempt_at<=statement_timestamp()and(original.lease_until is null or original.lease_until<=statement_timestamp()))or exists(select 1 from private.catalog_video_publication_jobs j join private.catalog_video_publication_policies p on p.catalog_material_id=j.catalog_material_id and p.revision=j.revision where j.state in('waiting','preparing','retry_wait')and j.dispatched_at is null and j.writer_fence is null and p.mode<>'held'and not p.legacy_delivery_unverified and not exists(select 1 from private.catalog_publication_cell_writes w where w.job_id=j.id))
$$;
revoke all on function private.catalog_video_cells_recovery_due_before_prepare(),private.launch_catalog_recovery_due()from public,anon,authenticated,service_role;
-- Independent N-work controls remain reachable after Launch table success.
create function public.service_created_launch_catalog_video(p_team uuid,p_actor uuid,p_generation uuid,p_action text,p_request uuid default null)returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;x private.launch_catalog_video_contexts%rowtype;i private.catalog_generation_intents%rowtype;
begin
 if p_action not in('read','cancel')or p_action is null or(p_action='cancel'and p_request is null)then raise exception 'INVALID_INPUT'using errcode='22023';end if;
 if private.can(p_team,'view',p_actor)is not true or private.can(p_team,'edit',p_actor)is not true then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team and actor_id=p_actor;
 select * into x from private.launch_catalog_video_contexts where generation_id=g.id and team_id=p_team and actor_id=p_actor;
 select * into i from private.catalog_generation_intents where id=x.catalog_intent_id and team_id=p_team and actor_id=p_actor and state='registered'and request_key='launch:'||g.id::text||':catalog';
 if g.id is null or x.generation_id is null or i.id is null or i.request_payload is distinct from x.request_payload or i.checkpoint->'initialVideoPlan'is distinct from x.initial_video_plan or not exists(select 1 from private.catalog_initial_publication_checks proof where proof.intent_id=i.id and proof.team_id=p_team and proof.actor_id=p_actor and proof.state='verified'and proof.catalog_material_id::text=i.result#>>'{catalog,materialId}')then raise exception 'WRONG_STATE'using errcode='55000';end if;
 if p_action='cancel'then return public.service_cancel_initial_catalog_video(p_team,p_actor,i.request_key,p_request);end if;
 return public.service_read_initial_catalog_video(p_team,p_actor,i.request_key);
end $$;
revoke all on function public.service_created_launch_catalog_video(uuid,uuid,uuid,text,uuid)from public,anon,authenticated;
grant execute on function public.service_created_launch_catalog_video(uuid,uuid,uuid,text,uuid)to service_role;
commit;
