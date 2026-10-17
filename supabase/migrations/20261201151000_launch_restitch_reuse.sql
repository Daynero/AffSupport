-- Reuse only a proven restitch result from this Launch's immutable previous revision.
create function private.launch_reusable_restitch(p_team uuid,p_generation uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;r public.team_launch_revisions%rowtype;b public.team_launch_revisions%rowtype;c public.team_launch_revision_catalogs%rowtype;m public.team_materials%rowtype;identity jsonb;
begin
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team;
 select * into r from public.team_launch_revisions where id=g.revision_id;
 select * into b from public.team_launch_revisions where id=r.base_revision_id and team_id=p_team and launch_id=g.launch_id;
 select * into c from public.team_launch_revision_catalogs where revision_id=b.id and team_id=p_team;
 if c.restitch_material_id is null or r.config->'catalog'->>'restitchEnabled' is distinct from 'true'
  or b.config->'catalog'->>'restitchEnabled' is distinct from 'true'
  or r.config->>'materialId' is distinct from b.config->>'materialId'
  or private.launch_material_identity(r.sources) is null or private.launch_material_identity(r.sources) is distinct from private.launch_material_identity(b.sources)
  or r.sources->>'restitchSettingsVersion' is null or r.sources->>'restitchSettingsVersion' is distinct from b.sources->>'restitchSettingsVersion'
  or r.config->'catalog'->>'finalDurationMode' is distinct from b.config->'catalog'->>'finalDurationMode'
  or (r.config->'catalog'->>'finalDurationMode'='custom' and r.config->'catalog'->'customFinalDurationSeconds' is distinct from b.config->'catalog'->'customFinalDurationSeconds') then return null;end if;
 select * into m from public.team_materials where team_id=p_team and id=c.restitch_material_id and lifecycle='active' and category='video';
 identity:=private.launch_material_identity(jsonb_build_object('materialChecksum',m.checksum,'materialDriveFileId',m.drive_file_id,'materialVersion',m.drive_version));
 if m.id is null or identity is null or c.settings_snapshot->'_launchRestitchIdentity' is distinct from identity
  or not exists(select 1 from public.team_operations o join private.team_operation_intents i on i.operation_id=o.id
   where o.id=c.restitch_operation_id and o.team_id=p_team and o.kind='process' and o.state='succeeded'
    and o.source_material_id=(r.config->>'materialId')::uuid and o.result_material_id=m.id and i.tool_id='restitch' and i.tool_contract_version=2)
  then return null;end if;
 return jsonb_build_object('operationId',c.restitch_operation_id,'materialId',m.id,'identity',identity);
end $$;
create function public.get_launch_restitch_reuse(p_team uuid,p_generation uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 perform private.launch_access(p_team,'edit');
 if not exists(select 1 from public.team_launch_generations g join public.team_launches l on l.id=g.launch_id
  where g.id=p_generation and g.team_id=p_team and g.actor_id=auth.uid() and l.archived_at is null
  and g.state in('accepted','running','waiting_dependency','interrupted','succeeded')) then raise exception 'WRONG_STATE' using errcode='55000';end if;
 return private.launch_reusable_restitch(p_team,p_generation);
end $$;
create or replace function public.service_launch_restitch_receipt(p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;r public.team_launch_revisions%rowtype;p private.launch_restitch_preparations%rowtype;o public.team_operations%rowtype;m public.team_materials%rowtype;reused jsonb;
begin
 perform public.service_touch_launch_generation(p_team,p_generation,p_actor,p_owner,p_fence,'catalog_planning');
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team;
 select * into r from public.team_launch_revisions where id=g.revision_id;
 if r.config->>'method'<>'catalog' or r.config->'catalog'->>'restitchEnabled'<>'true' then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into p from private.launch_restitch_preparations where generation_id=g.id;
 if p.generation_id is null then
  reused:=private.launch_reusable_restitch(p_team,p_generation);
  if reused is not null then return reused;end if;
  raise exception 'WRONG_STATE' using errcode='55000';
 end if;
 select * into o from public.team_operations where id=p.operation_id and team_id=p_team and actor_id=p_actor;
 select * into m from public.team_materials where id=o.result_material_id and team_id=p_team and lifecycle='active' and category='video';
 if o.id is null or o.state<>'succeeded' or o.source_material_id is distinct from (r.config->>'materialId')::uuid or m.id is null
  or not exists(select 1 from private.team_operation_intents i where i.operation_id=o.id and i.team_id=p_team and i.tool_id='restitch' and i.tool_contract_version=p.contract_version)
  then raise exception 'WRONG_STATE' using errcode='55000';end if;
 return jsonb_build_object('operationId',o.id,'materialId',m.id,'identity',private.launch_material_identity(jsonb_build_object('materialChecksum',m.checksum,'materialDriveFileId',m.drive_file_id,'materialVersion',m.drive_version)));
end $$;
-- A reused video has one existing copy ledger row. Preserve it rather than duplicate its PK.
create function public.service_link_launch_restitch_catalog(p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text,p_companion uuid,p_record jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;r public.team_launch_revisions%rowtype;i private.catalog_generation_intents%rowtype;receipt jsonb;linked jsonb;m public.team_materials%rowtype;
begin
 receipt:=public.service_launch_restitch_receipt(p_team,p_generation,p_actor,p_owner,p_fence);
 perform public.service_touch_launch_generation(p_team,p_generation,p_actor,p_owner,p_fence,'catalog_registering');
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team;
 select * into r from public.team_launch_revisions where id=g.revision_id;
 select * into i from private.catalog_generation_intents where team_id=p_team and actor_id=p_actor and request_key='launch:'||g.id::text||':catalog';
 if i.id is null or i.video_material_id is distinct from (r.config->>'materialId')::uuid or i.checkpoint->>'materialId' is distinct from p_companion::text
  or p_record->>'restitchOperationId' is distinct from receipt->>'operationId' or p_record->>'restitchMaterialId' is distinct from receipt->>'materialId'
  or p_record->>'createdBy' is distinct from p_actor::text or p_record->>'sourceLink' is distinct from r.generated_url
  or p_record->>'productCount' is distinct from r.config->'catalog'->>'productCount' or p_record->>'variant' is distinct from i.variant::text
  or nullif(p_record->>'currentVideoLink','') is null then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into m from public.team_materials where id=(receipt->>'materialId')::uuid and team_id=p_team and lifecycle='active' for update;
 if m.id is null then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 linked:=public.service_link_product_catalog_companion(p_team,i.video_material_id,p_companion,null,p_record);
 if linked->>'linked'<>'true' then return linked;end if;
 update public.team_product_catalogs set current_video_link=p_record->>'currentVideoLink' where material_id=p_companion;
 insert into public.team_catalog_restitch_copies(material_id,catalog_material_id,team_id,role,drive_file_id,shared_link,operation_id)
 values(m.id,p_companion,p_team,'in_use',m.drive_file_id,p_record->>'currentVideoLink',(receipt->>'operationId')::uuid)
 on conflict(material_id) do update set role='in_use',retired_at=null,next_delete_at=null,
  catalog_material_id=coalesce(team_catalog_restitch_copies.catalog_material_id,excluded.catalog_material_id),operation_id=excluded.operation_id,shared_link=excluded.shared_link;
 return linked;
end $$;
revoke all on function private.launch_reusable_restitch(uuid,uuid),public.get_launch_restitch_reuse(uuid,uuid),public.service_link_launch_restitch_catalog(uuid,uuid,uuid,text,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.get_launch_restitch_reuse(uuid,uuid) to authenticated;
grant execute on function public.service_link_launch_restitch_catalog(uuid,uuid,uuid,text,text,uuid,jsonb) to service_role;

create or replace function public.service_attach_launch_catalog(p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text) returns void language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;r public.team_launch_revisions%rowtype;i private.catalog_generation_intents%rowtype;c public.team_product_catalogs%rowtype;m public.team_materials%rowtype;copy public.team_catalog_restitch_copies%rowtype;video public.team_materials%rowtype;prep private.launch_restitch_preparations%rowtype;receipt jsonb;begin
 perform public.service_touch_launch_generation(p_team,p_generation,p_actor,p_owner,p_fence,'catalog_registering');
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team;
 select * into r from public.team_launch_revisions where id=g.revision_id;
 select * into i from private.catalog_generation_intents where team_id=p_team and actor_id=p_actor and request_key='launch:'||g.id::text||':catalog' and state='registered';
 if i.id is null or i.video_material_id<>(r.config->>'materialId')::uuid then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into c from public.team_product_catalogs where team_id=p_team and material_id=(i.result->'catalog'->>'materialId')::uuid and video_material_id=i.video_material_id and variant=i.variant and source_link=r.generated_url and product_count=(r.config->'catalog'->>'productCount')::integer;
 select * into m from public.team_materials where team_id=p_team and id=c.material_id and lifecycle='active';
 if c.material_id is null or m.id is null then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 if r.config->'catalog'->>'restitchEnabled'='true' then
  receipt:=public.service_launch_restitch_receipt(p_team,p_generation,p_actor,p_owner,p_fence);
  perform public.service_touch_launch_generation(p_team,p_generation,p_actor,p_owner,p_fence,'catalog_registering');
  select * into copy from public.team_catalog_restitch_copies where team_id=p_team and material_id=(receipt->>'materialId')::uuid and role='in_use';
  select * into video from public.team_materials where id=copy.material_id and team_id=p_team and lifecycle='active' and category='video';
  if copy.material_id is null or video.id is null or copy.operation_id is distinct from (receipt->>'operationId')::uuid
   or c.current_video_link is null then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 end if;
 insert into public.team_launch_revision_catalogs(team_id,revision_id,catalog_id,material_id,variant,name_snapshot,sheet_url,restitch_operation_id,restitch_material_id,settings_snapshot)
 values(p_team,r.id,c.material_id,c.material_id,coalesce(c.variant,1),m.name,c.sheet_url,copy.operation_id,copy.material_id,c.settings_snapshot||case when copy.material_id is null then '{}'::jsonb else jsonb_build_object('_launchRestitchIdentity',private.launch_material_identity(jsonb_build_object('materialChecksum',video.checksum,'materialDriveFileId',video.drive_file_id,'materialVersion',video.drive_version))) end)
 on conflict(revision_id) do nothing;
 update public.team_launch_generation_steps set state='succeeded',team_operation_id=i.operation_id,result_material_id=c.material_id,reserved_variant=i.variant,provider_intent_key=i.id::text,provider_file_id=m.drive_file_id,updated_at=clock_timestamp() where generation_id=g.id and stage='catalog_registering';
end $$;

-- Resume only accepted work or interrupted transient/unknown outcomes, not terminal failures.
create or replace function public.service_list_launch_catalog_recovery(p_limit integer default 3) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if p_limit is null or p_limit not between 1 and 10 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('teamId',x.team_id,'generationId',x.id,'actorId',x.actor_id)) from (
  select g.id,g.team_id,g.actor_id from public.team_launch_generations g
  join public.team_launch_revisions r on r.id=g.revision_id
  join public.team_launches l on l.id=g.launch_id and l.archived_at is null
  where r.config->>'method'='catalog' and (r.config->'catalog'->>'restitchEnabled'='false' or private.launch_reusable_restitch(g.team_id,g.id) is not null or exists(select 1 from private.launch_restitch_preparations p join public.team_operations o on o.id=p.operation_id where p.generation_id=g.id and o.state='succeeded' and o.result_material_id is not null))
   and g.state in('accepted','running','interrupted')
   and (g.next_attempt_at is null or g.next_attempt_at<=clock_timestamp())
   and (g.lease_expires_at is null or g.lease_expires_at<=clock_timestamp())
   and (g.safe_error_code is null or g.safe_error_code in('DRIVE_UNAVAILABLE','RATE_LIMITED','LAUNCH_INTERNAL_ERROR','LAUNCH_RESULT_UNCERTAIN','GROUP_RECONCILING','LEASE_MISMATCH','UNKNOWN'))
   and not exists(select 1 from private.catalog_generation_intents i where i.team_id=g.team_id
    and i.request_key='launch:'||g.id::text||':catalog' and i.lease_expires_at>clock_timestamp())
  order by coalesce(g.next_attempt_at,g.created_at),g.id limit p_limit
 ) x),'[]');
end $$;
