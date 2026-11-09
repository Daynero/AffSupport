-- Ordinary row refreshes preserve the actual stored video cells. This is a
-- phase of the original round, with the existing reconciliation writer fence.
create function private.catalog_nonvideo_update_context(p_item uuid,p_worker text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare item public.team_catalog_updater_items%rowtype;c public.team_product_catalogs%rowtype;p private.catalog_video_publication_policies%rowtype;a public.team_catalog_update_attempts%rowtype;r private.catalog_variant_round_snapshots%rowtype;desired integer;binding jsonb;recipe_ids jsonb;
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
 desired:=c.product_count;
 if r.attempt_id is not null then
  if r.source_kind<>'updater' or not r.regular_released or r.regular_verified_at is not null then raise exception 'CATALOG_PUBLICATION_PENDING' using errcode='55000';end if;
  desired:=r.product_count;
 end if;
 if coalesce((a.profile_snapshot->>'growProducts')::boolean,false) and c.product_count<400 then
  -- Growth needs the exact new pending recipe, never random new row counts.
  if desired<=c.product_count or not exists(select 1 from private.catalog_publication_targets t join private.catalog_video_sets s on s.id=t.video_set_id and s.team_id=t.team_id join private.catalog_video_set_recipes recipe on recipe.video_set_id=s.id and recipe.team_id=s.team_id and recipe.recipe_revision=t.recipe_revision where t.id=p.target_id and t.kind='video_set' and s.state='ready' and recipe.product_count=desired and s.id=r.set_id) then raise exception 'CATALOG_PUBLICATION_PENDING' using errcode='55000';end if;
 elsif desired<>c.product_count then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 binding:=jsonb_build_object('attemptId',a.attempt_id,'catalogId',p_item,'productCount',c.product_count,'desiredProductCount',desired,'recipeRowIds',recipe_ids,'policyRevision',p.revision,'targetId',p.target_id,'active',(select to_jsonb(d) from private.catalog_video_deliveries d where d.catalog_material_id=p_item));
 return jsonb_build_object('attemptId',a.attempt_id,'recipeRowIds',recipe_ids,'previousMarker',(select previous.actual_changes->>'_nativeNonVideoMarker' from public.team_catalog_update_attempts previous where previous.catalog_material_id=p_item and previous.delivery_verified_at is not null and previous.actual_changes?'_nativeNonVideoMarker' and previous.attempt_id<>a.attempt_id order by previous.started_at desc limit 1),'currentProductCount',c.product_count,'productCount',desired,'fileId',(select m.drive_file_id from public.team_materials m where m.id=p_item),'credentialId',(select d.credential_id from public.team_materials m join public.team_drive_connections d on d.id=m.connection_id and d.team_id=m.team_id where m.id=p_item and d.state='connected'),'rootFolderId',(select d.root_folder_id from public.team_materials m join public.team_drive_connections d on d.id=m.connection_id and d.team_id=m.team_id where m.id=p_item and d.state='connected'),'contextToken',encode(pg_catalog.sha256(convert_to(binding::text,'UTF8')),'hex'));
end;$$;
revoke all on function private.catalog_nonvideo_update_context(uuid,text) from public,anon,authenticated,service_role;
create function public.service_read_catalog_nonvideo_update_context(p_item uuid,p_worker text) returns jsonb language sql stable security definer set search_path='' as $$select private.catalog_nonvideo_update_context(p_item,p_worker);$$;
revoke all on function public.service_read_catalog_nonvideo_update_context(uuid,text) from public,anon,authenticated;
grant execute on function public.service_read_catalog_nonvideo_update_context(uuid,text) to service_role;

create function public.service_begin_catalog_nonvideo_update_write(p_item uuid,p_worker text,p_marker uuid,p_baseline_version text,p_expected_count integer,p_product_count integer,p_settings_snapshot jsonb,p_context_token text) returns boolean language plpgsql security definer set search_path='' as $$
declare context jsonb;
begin
 perform 1 from public.team_materials where id=p_item for update;
 context:=private.catalog_nonvideo_update_context(p_item,p_worker);
 if context->>'contextToken' is distinct from p_context_token or (context->>'productCount')::integer is distinct from p_product_count then return false;end if;
 if exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=p_item) or exists(select 1 from private.catalog_video_publication_jobs job join private.catalog_video_publication_policies policy on policy.catalog_material_id=job.catalog_material_id and policy.revision=job.revision left join private.catalog_publication_cell_writes frozen on frozen.job_id=job.id where job.catalog_material_id=p_item and job.state not in('published','held','superseded') and (job.dispatched_at is not null or job.writer_fence is not null or (frozen.job_id is not null and jsonb_array_length(frozen.payload->'products')<>p_product_count))) then return false;end if;
 if jsonb_typeof(p_settings_snapshot->'_catalogPublicIds') is distinct from 'array' or jsonb_array_length(p_settings_snapshot->'_catalogPublicIds')<>p_product_count or (select count(distinct value) from jsonb_array_elements_text(p_settings_snapshot->'_catalogPublicIds'))<>p_product_count then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 update public.team_catalog_update_attempts set actual_changes=coalesce(actual_changes,'{}'::jsonb)||jsonb_build_object('_nativeNonVideoMarker',p_marker) where attempt_id=(context->>'attemptId')::uuid;
 return private.publication_legacy_begin_catalog_update_write(p_item,p_worker,p_marker,p_baseline_version,p_expected_count,null,p_product_count,p_settings_snapshot||jsonb_build_object('_nativeNonVideoWrite',1));
end;$$;
revoke all on function public.service_begin_catalog_nonvideo_update_write(uuid,text,uuid,text,integer,integer,jsonb,text) from public,anon,authenticated;
grant execute on function public.service_begin_catalog_nonvideo_update_write(uuid,text,uuid,text,integer,integer,jsonb,text) to service_role;
create function public.service_read_catalog_nonvideo_reconciliation(p_item uuid,p_marker uuid) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=p_item and marker=p_marker and publication_job_id is null and settings_snapshot->>'_nativeNonVideoWrite'='1');$$;
revoke all on function public.service_read_catalog_nonvideo_reconciliation(uuid,uuid) from public,anon,authenticated;
grant execute on function public.service_read_catalog_nonvideo_reconciliation(uuid,uuid) to service_role;

-- A deferred constraint trigger must not terminalize a multi-phase N round
-- merely because its ordinary fields reached the user.
create or replace function private.track_catalog_update_result()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  current_link text;
  wants_video boolean;
begin
  if new.update_count > old.update_count and exists(select 1 from private.catalog_variant_round_snapshots r where r.catalog_material_id=new.material_id and r.source_kind='updater' and r.regular_released and exists(select 1 from public.team_catalog_update_attempts a where a.attempt_id=r.attempt_id and a.result in('running','unknown'))) then
    return new;
  end if;
  if new.update_count > old.update_count then
    select record.current_video_link,
           coalesce((select (attempt.profile_snapshot ->> 'restitch')::boolean
                     from public.team_catalog_update_attempts as attempt
                     where attempt.catalog_material_id = new.material_id
                       and attempt.result in ('running', 'unknown', 'cancelled', 'failed')
                     order by attempt.started_at desc limit 1), profile.restitch)
      into current_link, wants_video
    from public.team_product_catalogs as record
    join public.team_catalog_update_profiles as profile
      on profile.catalog_material_id = record.material_id
    where record.material_id = new.material_id;
    update public.team_catalog_update_attempts as attempt
       set result = case when wants_video and current_link is not distinct from old.current_video_link
                         then 'partial' else 'success' end,
           ended_at = clock_timestamp(), delivery_verified_at = clock_timestamp(),
           failure_code = null,
           actual_changes = coalesce(attempt.actual_changes, '{}'::jsonb) ||
             jsonb_build_object('videoReplaced', wants_video and
               current_link is distinct from old.current_video_link)
     where attempt.attempt_id = (
       select recent.attempt_id from public.team_catalog_update_attempts as recent
       where recent.catalog_material_id = new.material_id
         and recent.result in ('running', 'unknown', 'cancelled', 'failed')
       order by recent.started_at desc limit 1
     );
  elsif new.last_update_error is distinct from old.last_update_error
        and new.last_update_error is not null then
    update public.team_catalog_update_attempts as attempt
       set result = 'failed', failure_code = new.last_update_error,
           ended_at = clock_timestamp()
     where attempt.attempt_id = (
       select recent.attempt_id from public.team_catalog_update_attempts as recent
       where recent.catalog_material_id = new.material_id and recent.result in ('running', 'unknown')
       order by recent.started_at desc limit 1
     );
  end if;
  return null;
end;
$$;

alter function public.service_complete_catalog_update(uuid,text,integer,uuid,integer,jsonb) set schema private;
alter function private.service_complete_catalog_update(uuid,text,integer,uuid,integer,jsonb) rename to nonvideo_legacy_complete_catalog_update;
revoke all on function private.nonvideo_legacy_complete_catalog_update(uuid,text,integer,uuid,integer,jsonb) from public,anon,authenticated,service_role;
create function public.service_complete_catalog_update(p_item uuid,p_worker text,p_update_count integer,p_swapped_copy uuid default null,p_product_count integer default null,p_settings_snapshot jsonb default null) returns boolean language plpgsql security definer set search_path='' as $$
declare item public.team_catalog_updater_items%rowtype;r private.catalog_variant_round_snapshots%rowtype;images jsonb:='[]'::jsonb;native boolean;done boolean;
begin
 native:=exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=p_item and settings_snapshot->>'_nativeNonVideoWrite'='1');
 if native then perform 1 from public.team_materials where id=p_item for update;end if;
 select * into item from public.team_catalog_updater_items where catalog_material_id=p_item for update;
 select snap.* into r from private.catalog_variant_round_snapshots snap join public.team_catalog_update_attempts a on a.attempt_id=snap.attempt_id where snap.catalog_material_id=p_item and snap.source_kind='updater' and snap.regular_released and a.round_due_at=item.round_due_at and a.result in('running','unknown');
 if r.attempt_id is null then
  done:=private.nonvideo_legacy_complete_catalog_update(p_item,p_worker,p_update_count,p_swapped_copy,p_product_count,p_settings_snapshot);
  if done and native then perform private.rebind_pending_catalog_video_cells(p_item);end if;
  return done;
 end if;
 if r.regular_verified_at is not null then
  done:=exists(select 1 from public.team_product_catalogs c where c.material_id=p_item and c.update_count=p_update_count and c.product_count=p_product_count);
  if done then update public.team_catalog_update_attempts set result='running',ended_at=null where attempt_id=r.attempt_id and result='unknown';end if;
  return done;
 end if;
 if p_worker is null or item.lease_owner is null or item.lease_owner is distinct from p_worker or item.lease_expires_at is null or item.lease_expires_at<=clock_timestamp() or p_swapped_copy is not null or p_product_count is distinct from r.product_count or not exists(select 1 from private.catalog_update_reconciliations rec where rec.catalog_material_id=p_item and rec.publication_job_id is null and rec.expected_count=p_update_count and rec.product_count=p_product_count and rec.settings_snapshot->>'_nativeNonVideoWrite'='1') then return false;end if;
 if jsonb_typeof(p_settings_snapshot->'rows')='array' then select coalesce(jsonb_agg(image_row.value->'pictureImage'),'[]'::jsonb) into images from jsonb_array_elements(p_settings_snapshot->'rows') image_row(value) where image_row.value?'pictureImage';end if;
 if jsonb_array_length(images)>0 then perform public.service_catalog_image_validate_rows_v2(item.team_id,images);end if;
 update public.team_product_catalogs c set update_count=p_update_count,last_updated_at=clock_timestamp(),last_update_error=null,product_count=p_product_count::smallint,settings_snapshot=p_settings_snapshot where c.material_id=p_item and p_update_count=c.update_count+1;
 if not found then return false;end if;
 perform private.rebind_pending_catalog_video_cells(p_item);
 update private.catalog_variant_round_snapshots set regular_verified_at=clock_timestamp() where attempt_id=r.attempt_id;
 update public.team_catalog_update_attempts set result='running',ended_at=null,delivery_verified_at=clock_timestamp(),failure_code=null where attempt_id=r.attempt_id;
 update public.team_catalog_updater_items set lease_owner=null,lease_expires_at=null,next_attempt_at='infinity'::timestamptz where catalog_material_id=p_item;
 insert into public.team_catalog_events(team_id,material_id,event_kind) values(item.team_id,p_item,'upserted');
 return true;
end;$$;
revoke all on function public.service_complete_catalog_update(uuid,text,integer,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.service_complete_catalog_update(uuid,text,integer,uuid,integer,jsonb) to service_role;

-- Existing public projections perform their full membership checks; the outer
-- definer is required only to append a bounded private desired-set projection.
create or replace function public.list_team_catalog_manager_snapshot(p_team uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or private.can(p_team,'view',auth.uid()) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 return jsonb_build_object('catalogs',coalesce((select jsonb_agg(to_jsonb(c)||jsonb_build_object('video_generation',private.catalog_registry_video_generation(p_team,c.catalog_id))) from public.list_team_product_catalogs(p_team)c),'[]'::jsonb),'profiles',coalesce((select jsonb_agg(to_jsonb(p)) from public.list_team_catalog_update_profiles(p_team)p),'[]'::jsonb));
end;$$;
revoke all on function public.list_team_catalog_manager_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.list_team_catalog_manager_snapshot(uuid) to authenticated;

-- Registered-output preparation is independent from an already-created blank Launch catalog.
create or replace function public.get_launch(p_team uuid,p_launch uuid,p_revision uuid default null) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;c private.launch_catalog_video_contexts%rowtype;s private.catalog_video_sets%rowtype;n integer;
begin
 result:=public.get_launch_before_catalog_video(p_team,p_launch,p_revision);
 if result#>>'{generation,id}' is not null and result#>>'{generation,stage}' in('accepted','preparing','catalog_planning') and result#>>'{generation,state}' not in('succeeded','canceled') then
  select * into c from private.launch_catalog_video_contexts where generation_id=(result#>>'{generation,id}')::uuid and team_id=p_team;
  if c.video_set_id is not null then
   select * into s from private.catalog_video_sets where id=c.video_set_id;
   select count(*)::integer into n from private.catalog_video_variants where video_set_id=s.id and state='registered';
   result:=jsonb_set(result,'{generation,progress}',jsonb_build_object('completed',n,'total',s.requested_count,'unit','videos','source','registered_video_variants'));
  end if;
 end if;
 if result#>>'{generation,id}' is not null then
  select * into c from private.launch_catalog_video_contexts where generation_id=(result#>>'{generation,id}')::uuid and team_id=p_team;
  if c.video_set_id is not null then
   select * into s from private.catalog_video_sets where id=c.video_set_id and team_id=p_team;
   select count(*)::integer into n from private.catalog_video_variants where video_set_id=s.id and state='registered';
   result:=jsonb_set(result,'{generation,videoGeneration}',jsonb_strip_nulls(jsonb_build_object('setId',s.id,'requestedCount',s.requested_count,'registeredCount',n,'state',s.state,'activeChildOperationId',(select v.operation_id from private.catalog_video_variants v join public.team_operations o on o.id=v.operation_id and o.team_id=p_team where v.video_set_id=s.id and v.state in('working','unknown') and o.state in('pending','running') order by v.video_variant_index limit 1))));
  end if;
 end if;
 return result;
end;
$$;
revoke all on function public.get_launch(uuid,uuid,uuid) from public,anon;
grant execute on function public.get_launch(uuid,uuid,uuid) to authenticated;
