-- Permit delivered restitch swaps while retaining the historical video.
begin;
-- A delivered updater swap changes which video the working sheet uses. Keep the
-- historical video retained by reference, without occupying the in_use slot.
create or replace function private.guard_launch_copy_retirement()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.role='retired' and private.launch_output_retained(new.team_id,new.material_id) then
  if tg_op='UPDATE' and old.role='in_use'
   and new.catalog_material_id=old.catalog_material_id
   and exists (
    select 1 from private.catalog_update_reconciliations pending
    join public.team_product_catalogs catalog on catalog.material_id=pending.catalog_material_id
    join public.team_catalog_restitch_copies replacement on replacement.material_id=pending.swapped_copy
     and replacement.catalog_material_id=catalog.material_id and replacement.role in ('spare','retired')
    where pending.catalog_material_id=old.catalog_material_id
     and pending.swapped_copy<>old.material_id and catalog.update_count>=pending.expected_count
   ) then return new; end if;
  return null;
 end if;
 return new;
end $$;

create or replace function public.service_link_launch_restitch_catalog(p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text,p_companion uuid,p_record jsonb) returns jsonb
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
 -- The same retained video can serve another Launch catalog. Its ledger
 -- still describes the original catalog's live slot; never resurrect that slot.
 on conflict(material_id) do nothing;
 return linked;
end $$;

-- Retain the catalog-SUB wrapper and its publication fence.
create or replace function public.service_attach_launch_catalog_before_catalog_sub(p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text) returns void language plpgsql security definer set search_path='' as $$
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
  select * into copy from public.team_catalog_restitch_copies where team_id=p_team and material_id=(receipt->>'materialId')::uuid and (role='in_use' or (role='retired' and private.launch_output_retained(p_team,material_id)));
  select * into video from public.team_materials where id=copy.material_id and team_id=p_team and lifecycle='active' and category='video';
  if copy.material_id is null or video.id is null or copy.operation_id is distinct from (receipt->>'operationId')::uuid
   or c.current_video_link is null then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 end if;
 insert into public.team_launch_revision_catalogs(team_id,revision_id,catalog_id,material_id,variant,name_snapshot,sheet_url,restitch_operation_id,restitch_material_id,settings_snapshot)
 values(p_team,r.id,c.material_id,c.material_id,coalesce(c.variant,1),m.name,c.sheet_url,copy.operation_id,copy.material_id,c.settings_snapshot||case when copy.material_id is null then '{}'::jsonb else jsonb_build_object('_launchRestitchIdentity',private.launch_material_identity(jsonb_build_object('materialChecksum',video.checksum,'materialDriveFileId',video.drive_file_id,'materialVersion',video.drive_version))) end)
 on conflict(revision_id) do nothing;
 update public.team_launch_generation_steps set state='succeeded',team_operation_id=i.operation_id,result_material_id=c.material_id,reserved_variant=i.variant,provider_intent_key=i.id::text,provider_file_id=m.drive_file_id,updated_at=clock_timestamp() where generation_id=g.id and stage='catalog_registering';
end $$;

revoke all on function private.guard_launch_copy_retirement(),
 public.service_attach_launch_catalog_before_catalog_sub(uuid,uuid,uuid,text,text)
 from public,anon,authenticated,service_role;
commit;
