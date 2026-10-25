-- Link the actual versioned advertising URL before publishing its Launch revision.
begin;
create or replace function public.service_link_launch_restitch_catalog(p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text,p_companion uuid,p_record jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;r public.team_launch_revisions%rowtype;i private.catalog_generation_intents%rowtype;receipt jsonb;linked jsonb;bound jsonb;expected_link text;m public.team_materials%rowtype;
begin
 receipt:=public.service_launch_restitch_receipt(p_team,p_generation,p_actor,p_owner,p_fence);
 perform public.service_touch_launch_generation(p_team,p_generation,p_actor,p_owner,p_fence,'catalog_registering');
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team;
 select * into r from public.team_launch_revisions where id=g.revision_id;
 select * into i from private.catalog_generation_intents where team_id=p_team and actor_id=p_actor and request_key='launch:'||g.id::text||':catalog';
 -- Catalog SUB values are staged until this child is registered. Validate
 -- against that frozen binding without amending the unpublished revision early.
 expected_link:=r.generated_url;
 if exists(select 1 from jsonb_each(r.config->'subConfig') c
  where jsonb_typeof(c.value)='array' and c.value ? 'catalogName') then
  bound:=i.checkpoint->'launchSubBinding';
  if bound is null or bound->>'name' is distinct from i.checkpoint->'namePlan'->>'name'
   or nullif(bound->>'advertisingUrl','') is null then
   raise exception 'WRONG_STATE' using errcode='55000';
  end if;
  expected_link:=bound->>'advertisingUrl';
 end if;
 if i.id is null or i.video_material_id is distinct from (r.config->>'materialId')::uuid or i.checkpoint->>'materialId' is distinct from p_companion::text
  or p_record->>'restitchOperationId' is distinct from receipt->>'operationId' or p_record->>'restitchMaterialId' is distinct from receipt->>'materialId'
  or p_record->>'createdBy' is distinct from p_actor::text or p_record->>'sourceLink' is distinct from expected_link
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
revoke all on function public.service_link_launch_restitch_catalog(uuid,uuid,uuid,text,text,uuid,jsonb)
 from public,anon,authenticated;
grant execute on function public.service_link_launch_restitch_catalog(uuid,uuid,uuid,text,text,uuid,jsonb)
 to service_role;
commit;
