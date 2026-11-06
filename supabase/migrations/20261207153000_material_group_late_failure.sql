-- Late failures may not change a completed or replacement execution.
create function private.mark_material_group_reconciling(
  p_intent uuid,
  p_executor uuid,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  intent private.team_material_group_intents%rowtype;
begin
  if p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into intent from private.team_material_group_intents as candidate
  where candidate.id = p_intent for update;
  if intent.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if intent.state not in ('pending','running','reconciling') then return false; end if;
  if intent.execution_protocol is null then
    if p_executor is not null then return false; end if;
  elsif intent.execution_protocol is distinct from 1 or p_executor is null
     or intent.execution_owner is distinct from p_executor
     or intent.execution_closed is distinct from false then return false;
  end if;
  perform 1 from public.team_operations where id=intent.operation_id
    and state in ('pending','running') for update;
  if not found then return false; end if;

  update private.team_material_group_intents
     set state = 'reconciling', error_code = p_error_code
   where id = p_intent and state <> 'succeeded';
  update public.team_materials as material
     set placement_state = 'reconciling'
   where material.team_id = intent.team_id
     and material.id in (
       select (entry ->> 'material_id')::uuid
       from jsonb_array_elements(intent.member_snapshot) as entry
     );
  update public.team_operations
     set state = 'running', stage = 'group_reconciling', progress = 50,
         error_code = p_error_code, retryable = true, updated_at = clock_timestamp()
   where id = intent.operation_id and state not in ('succeeded','canceled');
  return true;
end;
$$;


revoke all on function private.mark_material_group_reconciling(uuid,uuid,text)
  from public,anon,authenticated,service_role;
create or replace function public.service_mark_material_group_reconciling(p_intent uuid,p_error_code text)
returns boolean language sql security definer set search_path='' as $$
  select private.mark_material_group_reconciling(p_intent,null,p_error_code);
$$;
create function public.service_mark_material_group_execution_reconciling(p_intent uuid,p_executor uuid,p_error_code text)
returns boolean language sql security definer set search_path='' as $$
  select private.mark_material_group_reconciling(p_intent,p_executor,p_error_code);
$$;
revoke all on function public.service_mark_material_group_execution_reconciling(uuid,uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.service_mark_material_group_execution_reconciling(uuid,uuid,text) to service_role;

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
     or material.lifecycle is distinct from (case when p_action='trash' then 'active' else 'trashed' end) then
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
