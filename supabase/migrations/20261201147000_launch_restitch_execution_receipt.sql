-- Only a fenced Launch executor can consume its own successful local child.
create function public.service_launch_restitch_receipt(p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;r public.team_launch_revisions%rowtype;p private.launch_restitch_preparations%rowtype;o public.team_operations%rowtype;
begin
 perform public.service_touch_launch_generation(p_team,p_generation,p_actor,p_owner,p_fence,'catalog_planning');
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team;
 select * into r from public.team_launch_revisions where id=g.revision_id;
 if r.config->>'method'<>'catalog' or r.config->'catalog'->>'restitchEnabled'<>'true' then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into p from private.launch_restitch_preparations where generation_id=g.id;
 select * into o from public.team_operations where id=p.operation_id and team_id=p_team and actor_id=p_actor;
 if o.id is null or o.state<>'succeeded' or o.source_material_id is distinct from (r.config->>'materialId')::uuid
  or not exists(select 1 from private.team_operation_intents i where i.operation_id=o.id and i.team_id=p_team and i.tool_id='restitch' and i.tool_contract_version=p.contract_version)
  or not exists(select 1 from public.team_materials m where m.id=o.result_material_id and m.team_id=p_team and m.lifecycle='active' and m.category='video')
  then raise exception 'WRONG_STATE' using errcode='55000';end if;
 return jsonb_build_object('operationId',o.id,'materialId',o.result_material_id);
end $$;
revoke all on function public.service_launch_restitch_receipt(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.service_launch_restitch_receipt(uuid,uuid,uuid,text,text) to service_role;
