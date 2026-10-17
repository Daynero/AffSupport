-- Link Launch history to the real existing restitch receipt and immutable material identity.
create or replace function public.service_attach_launch_catalog(p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text) returns void language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;r public.team_launch_revisions%rowtype;i private.catalog_generation_intents%rowtype;c public.team_product_catalogs%rowtype;m public.team_materials%rowtype;copy public.team_catalog_restitch_copies%rowtype;video public.team_materials%rowtype;prep private.launch_restitch_preparations%rowtype;begin
 perform public.service_touch_launch_generation(p_team,p_generation,p_actor,p_owner,p_fence,'catalog_registering');
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team;
 select * into r from public.team_launch_revisions where id=g.revision_id;
 select * into i from private.catalog_generation_intents where team_id=p_team and actor_id=p_actor and request_key='launch:'||g.id::text||':catalog' and state='registered';
 if i.id is null or i.video_material_id<>(r.config->>'materialId')::uuid then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into c from public.team_product_catalogs where team_id=p_team and material_id=(i.result->'catalog'->>'materialId')::uuid and video_material_id=i.video_material_id and variant=i.variant and source_link=r.generated_url and product_count=(r.config->'catalog'->>'productCount')::integer;
 select * into m from public.team_materials where team_id=p_team and id=c.material_id and lifecycle='active';
 if c.material_id is null or m.id is null then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 -- The existing restitch linker records its receipt in this table, not catalog settings.
 select * into copy from public.team_catalog_restitch_copies where team_id=p_team and catalog_material_id=c.material_id and role='in_use';
 if r.config->'catalog'->>'restitchEnabled'='true' then
  select * into prep from private.launch_restitch_preparations where generation_id=g.id;
  select * into video from public.team_materials where id=copy.material_id and team_id=p_team and lifecycle='active' and category='video';
  if copy.material_id is null or video.id is null or copy.operation_id is distinct from prep.operation_id
   or not exists(select 1 from public.team_operations o join private.team_operation_intents intent on intent.operation_id=o.id
    where o.id=copy.operation_id and o.team_id=p_team and o.actor_id=p_actor and o.state='succeeded'
     and o.result_material_id=copy.material_id and o.source_material_id=i.video_material_id and intent.tool_id='restitch' and intent.tool_contract_version=prep.contract_version)
   then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 elsif copy.material_id is not null then raise exception 'WRONG_STATE' using errcode='55000';end if;
 insert into public.team_launch_revision_catalogs(team_id,revision_id,catalog_id,material_id,variant,name_snapshot,sheet_url,restitch_operation_id,restitch_material_id,settings_snapshot)
 values(p_team,r.id,c.material_id,c.material_id,coalesce(c.variant,1),m.name,c.sheet_url,copy.operation_id,copy.material_id,c.settings_snapshot||case when copy.material_id is null then '{}'::jsonb else jsonb_build_object('_launchRestitchIdentity',private.launch_material_identity(jsonb_build_object('materialChecksum',video.checksum,'materialDriveFileId',video.drive_file_id,'materialVersion',video.drive_version))) end)
 on conflict(revision_id) do nothing;
 update public.team_launch_generation_steps set state='succeeded',team_operation_id=i.operation_id,result_material_id=c.material_id,reserved_variant=i.variant,provider_intent_key=i.id::text,provider_file_id=m.drive_file_id,updated_at=clock_timestamp() where generation_id=g.id and stage='catalog_registering';
end $$;
