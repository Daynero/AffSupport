-- Fenced coordinator uses the existing catalog generator and its private journal.
create function public.service_claim_launch_generation(p_team uuid,p_generation uuid,p_actor uuid,p_owner text) returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;l public.team_launches%rowtype;r public.team_launch_revisions%rowtype;begin
 if p_actor is null or not private.can(p_team,'edit',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into l from public.team_launches where id=(select launch_id from public.team_launch_generations where id=p_generation and team_id=p_team) and archived_at is null for update;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 if g.id is null or l.id is null then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 if g.actor_id<>p_actor then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if g.state='succeeded' then return jsonb_build_object('id',g.id,'state',g.state,'revisionId',g.revision_id);end if;
 if g.state not in('accepted','running','interrupted','partial','failed') then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if p_owner is null or char_length(p_owner) not between 8 and 200 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if g.lease_expires_at>clock_timestamp() and g.lease_owner<>p_owner then raise exception 'LAUNCH_BUSY' using errcode='55000';end if;
 update public.team_launch_generations set state='running',lease_owner=p_owner,lease_expires_at=clock_timestamp()+interval '180 seconds',fence=fence+1,next_attempt_at=clock_timestamp()+interval '180 seconds',state_version=state_version+1,updated_at=clock_timestamp() where id=g.id returning * into g;
 select * into r from public.team_launch_revisions where id=g.revision_id;
 perform private.launch_signal(p_team,l.id,l.aggregate_version);
 return jsonb_build_object('id',g.id,'state',g.state,'fence',g.fence::text,'revisionId',g.revision_id,'config',r.config,'sources',r.sources,'advertisingUrl',r.generated_url,'previousRevision',private.launch_revision_json(p_team,r.base_revision_id));
end $$;
create function public.service_touch_launch_generation(p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text,p_stage text) returns void language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;l public.team_launches%rowtype;begin
 if p_actor is null or not private.can(p_team,'edit',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into l from public.team_launches where id=(select launch_id from public.team_launch_generations where id=p_generation and team_id=p_team) and archived_at is null for update;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 if g.id is null or l.id is null or g.actor_id<>p_actor or g.state<>'running' or g.lease_owner<>p_owner or g.fence::text<>p_fence or g.lease_expires_at<=clock_timestamp() then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 if p_stage not in('preparing','catalog_planning','catalog_creating','catalog_sharing','catalog_registering','result_committing') then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 insert into public.team_launch_generation_steps(team_id,generation_id,stage,stable_step_key,state,fence) values(p_team,g.id,p_stage,p_stage,'running',g.fence) on conflict(generation_id,stable_step_key) do update set state=case when team_launch_generation_steps.state='succeeded' then 'succeeded' else 'running' end,fence=g.fence,updated_at=clock_timestamp();
 update public.team_launch_generation_steps set state='succeeded',updated_at=clock_timestamp() where generation_id=g.id and state='running' and stage<>p_stage;
 update public.team_launch_generations set stage=p_stage,state_version=state_version+1,lease_expires_at=clock_timestamp()+interval '180 seconds',next_attempt_at=clock_timestamp()+interval '180 seconds',updated_at=clock_timestamp() where id=g.id;
 perform private.launch_signal(p_team,l.id,l.aggregate_version);
end $$;
create function public.service_attach_launch_catalog(p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text) returns void language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;r public.team_launch_revisions%rowtype;i private.catalog_generation_intents%rowtype;c public.team_product_catalogs%rowtype;m public.team_materials%rowtype;begin
 perform public.service_touch_launch_generation(p_team,p_generation,p_actor,p_owner,p_fence,'catalog_registering');
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team;
 select * into r from public.team_launch_revisions where id=g.revision_id;
 select * into i from private.catalog_generation_intents where team_id=p_team and actor_id=p_actor and request_key='launch:'||g.id::text||':catalog' and state='registered';
 if i.id is null or i.video_material_id<>(r.config->>'materialId')::uuid then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into c from public.team_product_catalogs where team_id=p_team and material_id=(i.result->'catalog'->>'materialId')::uuid and video_material_id=i.video_material_id and variant=i.variant and source_link=r.generated_url and product_count=(r.config->'catalog'->>'productCount')::integer;
 select * into m from public.team_materials where team_id=p_team and id=c.material_id and lifecycle='active';
 if c.material_id is null or m.id is null then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 insert into public.team_launch_revision_catalogs(team_id,revision_id,catalog_id,material_id,variant,name_snapshot,sheet_url,restitch_operation_id,restitch_material_id,settings_snapshot)
 values(p_team,r.id,c.material_id,c.material_id,coalesce(c.variant,1),m.name,c.sheet_url,nullif(c.settings_snapshot->>'restitchOperationId','')::uuid,nullif(c.settings_snapshot->>'restitchMaterialId','')::uuid,c.settings_snapshot)
 on conflict(revision_id) do nothing;
 update public.team_launch_generation_steps set state='succeeded',team_operation_id=i.operation_id,result_material_id=c.material_id,reserved_variant=i.variant,provider_intent_key=i.id::text,provider_file_id=m.drive_file_id,updated_at=clock_timestamp() where generation_id=g.id and stage='catalog_registering';
end $$;
create function public.service_interrupt_launch_generation(p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text,p_code text) returns void language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;l public.team_launches%rowtype;begin
 if p_actor is null or not private.can(p_team,'edit',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into l from public.team_launches where id=(select launch_id from public.team_launch_generations where id=p_generation and team_id=p_team) for update;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 if g.id is null or g.actor_id<>p_actor or g.state<>'running' or g.lease_owner<>p_owner or g.fence::text<>p_fence then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 if p_code is null or p_code !~ '^[A-Z][A-Z0-9_]{1,79}$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 update public.team_launch_generations set state='interrupted',safe_error_code=p_code,retryable=true,lease_expires_at=clock_timestamp(),next_attempt_at=clock_timestamp()+interval '30 seconds',state_version=state_version+1,updated_at=clock_timestamp() where id=g.id;
 perform private.launch_signal(p_team,l.id,l.aggregate_version);
end $$;
revoke all on function public.service_claim_launch_generation(uuid,uuid,uuid,text),public.service_touch_launch_generation(uuid,uuid,uuid,text,text,text),public.service_attach_launch_catalog(uuid,uuid,uuid,text,text),public.service_interrupt_launch_generation(uuid,uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.service_claim_launch_generation(uuid,uuid,uuid,text),public.service_touch_launch_generation(uuid,uuid,uuid,text,text,text),public.service_attach_launch_catalog(uuid,uuid,uuid,text,text),public.service_interrupt_launch_generation(uuid,uuid,uuid,text,text,text) to service_role;
