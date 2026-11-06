-- A catalog observation may already reflect the acknowledged provider result.
-- The same managed pending marker, owner/action and cancellation fences still apply.
create or replace function public.service_reconcile_confirmed_material_group(
  p_team uuid, p_actor uuid, p_operation uuid, p_material uuid,
  p_action text, p_destination uuid default null
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  o public.team_operations%rowtype;
  g private.team_material_group_intents%rowtype;
  material public.team_materials%rowtype;
  receipt jsonb;
begin
  if p_action not in ('trash','restore') then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  if not private.can(p_team,'delete',p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode='42501';
  end if;
  select * into o from public.team_operations where id=p_operation;
  if o.id is null or o.team_id is distinct from p_team or o.actor_id is distinct from p_actor then
    raise exception 'PERMISSION_DENIED' using errcode='42501';
  end if;
  if o.source_material_id is distinct from p_material or o.kind is distinct from p_action
     or o.destination_folder_id is distinct from p_destination then
    raise exception 'REQUEST_REUSE_CONFLICT' using errcode='22023';
  end if;
  select * into g from private.team_material_group_intents where operation_id=p_operation for update;
  if g.id is null then return null; end if;
  -- Same intent-first lock order as group completion. Cancellation holds only
  -- the operation; re-read it under its lock before committing any material.
  select * into o from public.team_operations where id=p_operation for update;
  if o.state not in ('pending','running') or g.execution_protocol is distinct from 1
     or g.state not in ('pending','running','reconciling') then
    raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';
  end if;
  if g.team_id is distinct from p_team or g.source_material_id is distinct from p_material
     or g.action is distinct from p_action or o.request_nonce !~ '^group-v1:[0-9a-f]{64}$' then
    raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';
  end if;
  if g.dispatch_member is not null then
    raise exception 'GROUP_RECONCILING' using errcode='55000';
  end if;
  if cardinality(g.applied_member_ids)<>jsonb_array_length(g.member_snapshot) then return null; end if;
  select * into material from public.team_materials where id=p_material and team_id=p_team for update;
  if material.id is null or material.placement_state not in ('moving','reconciling')
     or material.lifecycle not in ('active','trashed') then
    raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';
  end if;
  receipt:=public.service_complete_material_group_intent(g.id);
  -- Every member is acknowledged and registration has committed in this same
  -- transaction. Close the completed marker without clearing an unknown member
  -- or issuing new provider permission.
  update private.team_material_group_intents set execution_closed=true where id=g.id;
  return receipt;
end;
$$;
