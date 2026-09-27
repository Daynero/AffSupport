-- A catalog created with a re-stitched video remains a companion of the original.
-- The copy used by its first sheet becomes its in-use video in the same transaction.

create function public.service_link_restitched_product_catalog_companion(
  p_team uuid,
  p_video uuid,
  p_companion uuid,
  p_replaces uuid,
  p_record jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation_id uuid;
  v_copy_id uuid;
  copy_row public.team_materials%rowtype;
  link text;
  linked jsonb;
begin
  if p_record is null or jsonb_typeof(p_record) <> 'object'
     or nullif(p_record ->> 'restitchOperationId', '') is null
     or nullif(p_record ->> 'restitchMaterialId', '') is null
     or nullif(p_record ->> 'currentVideoLink', '') is null
  then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  v_operation_id := (p_record ->> 'restitchOperationId')::uuid;
  v_copy_id := (p_record ->> 'restitchMaterialId')::uuid;
  link := p_record ->> 'currentVideoLink';

  select material.* into copy_row
  from public.team_materials as material
  join public.team_operations as operation
    on operation.result_material_id = material.id
  join private.team_operation_intents as intent
    on intent.operation_id = operation.id
  where operation.id = v_operation_id
    and operation.team_id = p_team
    and operation.actor_id = nullif(p_record ->> 'createdBy', '')::uuid
    and operation.source_material_id = p_video
    and operation.kind = 'process'
    and operation.state = 'succeeded'
    and intent.tool_id = 'restitch'
    and material.id = v_copy_id
    and material.team_id = p_team
    and material.lifecycle = 'active'
    and material.category = 'video';
  if copy_row.id is null then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;

  linked := public.service_link_product_catalog_companion(
    p_team, p_video, p_companion, p_replaces, p_record
  );
  if linked ->> 'linked' <> 'true' then return linked; end if;

  if p_replaces is not null then
    update public.team_catalog_restitch_copies as previous
       set role = 'retired', retired_at = clock_timestamp(),
           next_delete_at = clock_timestamp() + interval '2 minutes'
     where previous.catalog_material_id = p_replaces and previous.role = 'in_use';
  end if;

  update public.team_product_catalogs as catalog
     set current_video_link = link
   where catalog.material_id = p_companion;
  insert into public.team_catalog_restitch_copies (
    material_id, catalog_material_id, team_id, role, drive_file_id, shared_link, operation_id
  ) values (
    v_copy_id, p_companion, p_team, 'in_use', copy_row.drive_file_id, link, v_operation_id
  );
  return linked;
end;
$$;

revoke all on function public.service_link_restitched_product_catalog_companion(
  uuid, uuid, uuid, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.service_link_restitched_product_catalog_companion(
  uuid, uuid, uuid, uuid, jsonb
) to service_role;
