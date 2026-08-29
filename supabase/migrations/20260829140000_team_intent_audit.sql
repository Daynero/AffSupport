-- 011 (findings H3): trash, restore and move complete through
-- service_complete_material_group_intent, which updated the rows and the
-- catalog events but never wrote the audit row the space history reads.
-- Same body as 20260814101000, plus one record_team_audit call at the end.

create or replace function public.service_complete_material_group_intent(p_intent uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  intent private.team_material_group_intents%rowtype;
  source_payload jsonb;
  source_before_stage text;
  operation_actor uuid;
begin
  select * into intent from private.team_material_group_intents as candidate
  where candidate.id = p_intent for update;
  if intent.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if intent.state = 'succeeded' then
    return jsonb_build_object(
      'operationId', intent.operation_id, 'state','succeeded',
      'materialId',intent.source_material_id,'reused',true
    );
  end if;
  if cardinality(intent.applied_member_ids) <> jsonb_array_length(intent.member_snapshot) then
    raise exception 'GROUP_RECONCILING' using errcode = '40001';
  end if;
  select member into source_payload
  from jsonb_array_elements(intent.member_snapshot) as member
  where member ->> 'role' = 'source' limit 1;
  if source_payload is null then raise exception 'INVALID_RESPONSE' using errcode = '22023'; end if;
  select material.library_stage into source_before_stage
  from public.team_materials as material
  where material.id = intent.source_material_id and material.team_id = intent.team_id;
  select operation.actor_id into operation_actor
  from public.team_operations as operation
  where operation.id = intent.operation_id and operation.team_id = intent.team_id;

  if intent.action = 'move' then
    update public.team_materials as material
       set parent_folder_id = intent.destination_parent_id,
           library_stage = coalesce(source_payload ->> 'target_stage', material.library_stage),
           structural_offer = coalesce(source_payload ->> 'target_offer', material.structural_offer),
           structural_language = coalesce(source_payload ->> 'target_language', material.structural_language),
           structural_type = coalesce(source_payload ->> 'target_type', material.structural_type),
           offer = coalesce(source_payload ->> 'target_offer', material.offer),
           language = case
             when source_payload ->> 'target_language' is null then material.language
             when source_payload ->> 'target_language' = 'unknown' then material.language
             else source_payload ->> 'target_language' end,
           placement_state = 'ready', placement_revision = placement_revision + 1
     where material.team_id = intent.team_id
       and material.id in (
         select (entry ->> 'material_id')::uuid
         from jsonb_array_elements(intent.member_snapshot) as entry
       );
  else
    update public.team_materials as material
       set parent_folder_id = case when intent.action = 'restore'
              then coalesce(intent.destination_parent_id, material.parent_folder_id)
              else material.parent_folder_id end,
           lifecycle = case when intent.action = 'trash' then 'trashed' else 'active' end,
           trashed_at = case when intent.action = 'trash' then clock_timestamp() else null end,
           missing_at = case when intent.action = 'restore' then null else material.missing_at end,
           placement_state = 'ready', placement_revision = placement_revision + 1
     where material.team_id = intent.team_id
       and material.id in (
         select (entry ->> 'material_id')::uuid
         from jsonb_array_elements(intent.member_snapshot) as entry
       );
  end if;
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  select intent.team_id, (entry ->> 'material_id')::uuid,
         case when intent.action = 'trash' then 'tombstoned' else 'upserted' end
  from jsonb_array_elements(intent.member_snapshot) as entry;
  update private.team_material_group_intents
     set state = 'succeeded', error_code = null, finished_at = clock_timestamp()
   where id = intent.id;
  update public.team_operations
     set state = 'succeeded', stage = 'completed', progress = 100,
         result_material_id = intent.source_material_id, error_code = null,
         retryable = false, finished_at = clock_timestamp(), updated_at = clock_timestamp()
   where id = intent.operation_id;
  if intent.action = 'move'
     and source_before_stage = 'finds'
     and source_payload ->> 'target_stage' = 'library'
     and operation_actor is not null then
    perform private.append_library_contribution(
      intent.team_id, operation_actor, 'human_activity', 'find_selected', 'success', null
    );
  end if;
  -- The space history (FR-031) knows a rename or a transfer, because their
  -- commit records one; a trash, a restore or a move through this path never
  -- did, so the history stopped at "uploaded" while the file went to the bin.
  if operation_actor is not null then
    perform private.record_team_audit(
      intent.team_id, operation_actor, 'material.' || intent.action,
      jsonb_build_object(
        'material_id', intent.source_material_id,
        'operation_id', intent.operation_id
      ),
      'succeeded', null
    );
  end if;
  return jsonb_build_object(
    'operationId', intent.operation_id, 'state','succeeded',
    'materialId',intent.source_material_id,'reused',false
  );
end;
$$;
