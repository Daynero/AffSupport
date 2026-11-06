-- Managed execution is positively bound to the immutable operation nonce.
-- Historical intents remain unclassified; no timeout reissues provider authority.
alter table private.team_material_group_intents
  add column execution_protocol smallint,
  add column execution_owner uuid,
  add column execution_closed boolean,
  add column dispatch_member uuid,
  add constraint material_group_execution_shape check (
    (execution_protocol is null and execution_owner is null and execution_closed is null and dispatch_member is null)
    or ((execution_protocol=1 and execution_closed is not null
      and (execution_owner is not null or (execution_closed and dispatch_member is null))
      and (state <> 'succeeded' or (dispatch_member is null and cardinality(applied_member_ids)=jsonb_array_length(member_snapshot)))) is true)
  );

create or replace function public.service_create_material_lifecycle_intent(
  p_team uuid,
  p_actor uuid,
  p_operation uuid,
  p_material uuid,
  p_action text,
  p_destination_parent_id text default null
)
returns table (
  intent_id uuid,
  team_id uuid,
  operation_id uuid,
  source_material_id uuid,
  action text,
  members jsonb,
  applied_member_ids uuid[]
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  source public.team_materials%rowtype;
  existing private.team_material_group_intents%rowtype;
  snapshot jsonb;
  created_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('material-group-members:'||p_team::text,0));
  if p_action not in ('move','trash','restore')
     or not exists (
       select 1 from public.team_operations as operation
       where operation.id = p_operation and operation.team_id = p_team
         and operation.actor_id = p_actor and operation.kind = p_action
         and operation.source_material_id = p_material
         and operation.state in ('pending','running')
     )
     or (p_action = 'move' and (p_destination_parent_id is null
       or char_length(p_destination_parent_id) not between 1 and 1024))
     or (p_destination_parent_id is not null
       and char_length(p_destination_parent_id) not between 1 and 1024) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if not private.can(p_team, case when p_action = 'move' then 'edit' else 'delete' end, p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  select * into existing
  from private.team_material_group_intents as intent
  where intent.operation_id = p_operation for update;
  if existing.id is not null then
    return query select existing.id, existing.team_id, existing.operation_id,
      existing.source_material_id, existing.action, existing.member_snapshot,
      existing.applied_member_ids;
    return;
  end if;

  select * into source from public.team_materials as material
  where material.id = p_material and material.team_id = p_team for update;
  if source.id is null or source.kind <> 'file'
     or (p_action = 'restore' and source.lifecycle <> 'trashed')
     or (p_action <> 'restore' and source.lifecycle <> 'active') then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  select jsonb_agg(jsonb_build_object(
    'material_id', member.id,
    'drive_file_id', member.drive_file_id,
    'resource_key', member.resource_key,
    'parent_folder_id', member.parent_folder_id,
    'role', member.role
  ) order by case member.role when 'source' then 0 when 'transcript' then 1 else 2 end,
             member.id)
  into snapshot
  from (
    select material.id, material.drive_file_id, material.resource_key,
           material.parent_folder_id, 'source'::text as role
    from public.team_materials as material
    where material.id = p_material and material.team_id = p_team
    union all
    select sidecar.id, sidecar.drive_file_id, sidecar.resource_key,
           sidecar.parent_folder_id,
           case when result.kind = 'transcription' then 'transcript' else 'translation' end
    from public.team_library_results as result
    join public.team_materials as sidecar
      on sidecar.id = result.material_id and sidecar.team_id = result.team_id
    where result.team_id = p_team and result.source_material_id = p_material
      and result.state = 'current'
      and sidecar.lifecycle = case when p_action = 'restore' then 'trashed' else 'active' end
  ) as member;

  insert into private.team_material_group_intents (
    team_id, source_material_id, operation_id, action, destination_parent_id,
    member_snapshot, state
  ) values (
    p_team, p_material, p_operation, p_action, p_destination_parent_id, snapshot, 'running'
  ) returning id into created_id;
  update public.team_materials as material set placement_state = 'moving'
  where material.team_id = p_team and material.id in (
    select (entry ->> 'material_id')::uuid from jsonb_array_elements(snapshot) as entry
  );
  return query
  select intent.id, intent.team_id, intent.operation_id, intent.source_material_id,
         intent.action, intent.member_snapshot, intent.applied_member_ids
  from private.team_material_group_intents as intent where intent.id = created_id;
end;
$$;

create or replace function public.service_create_material_group_intent(
  p_team uuid,
  p_actor uuid,
  p_operation uuid,
  p_material uuid,
  p_expected_revision bigint,
  p_destination_material uuid,
  p_destination_parent_id text,
  p_stage text,
  p_offer text,
  p_language text,
  p_type text
)
returns table (
  intent_id uuid,
  team_id uuid,
  operation_id uuid,
  source_material_id uuid,
  action text,
  members jsonb,
  applied_member_ids uuid[]
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  source public.team_materials%rowtype;
  existing private.team_material_group_intents%rowtype;
  snapshot jsonb;
  created_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('material-group-members:'||p_team::text,0));
  if not private.can(p_team, 'edit', p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_stage not in ('finds','library')
     or char_length(btrim(p_offer)) not between 1 and 120
     or char_length(p_language) not between 1 and 35
     or char_length(btrim(p_type)) not between 1 and 64
     or char_length(p_destination_parent_id) not between 1 and 1024 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.team_operations as operation
    where operation.id = p_operation and operation.team_id = p_team
      and operation.actor_id = p_actor and operation.kind = 'move'
      and operation.source_material_id = p_material
      and operation.destination_folder_id = p_destination_material
      and operation.state in ('pending','running')
  ) or not exists (
    select 1 from public.team_materials as folder
    where folder.id = p_destination_material and folder.team_id = p_team
      and folder.kind = 'folder' and folder.lifecycle = 'active'
      and folder.drive_file_id = p_destination_parent_id
  ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  select * into existing
  from private.team_material_group_intents as intent
  where intent.operation_id = p_operation for update;
  if existing.id is not null then
    return query select existing.id, existing.team_id, existing.operation_id,
      existing.source_material_id, existing.action, existing.member_snapshot,
      existing.applied_member_ids;
    return;
  end if;

  select * into source
  from public.team_materials as material
  where material.id = p_material and material.team_id = p_team
  for update;
  if source.id is null or source.kind <> 'file' or source.lifecycle <> 'active' then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if source.placement_revision <> p_expected_revision
     or source.placement_state in ('moving','reconciling') then
    raise exception 'SOURCE_CHANGED' using errcode = '40001';
  end if;

  select jsonb_agg(jsonb_build_object(
    'material_id', member.id,
    'drive_file_id', member.drive_file_id,
    'resource_key', member.resource_key,
    'parent_folder_id', member.parent_folder_id,
    'role', member.role,
    'target_stage', p_stage,
    'target_offer', btrim(p_offer),
    'target_language', p_language,
    'target_type', btrim(p_type)
  ) order by case member.role when 'source' then 0 when 'transcript' then 1 else 2 end,
             member.id)
  into snapshot
  from (
    select material.id, material.drive_file_id, material.resource_key,
           material.parent_folder_id, 'source'::text as role
    from public.team_materials as material
    where material.id = p_material and material.team_id = p_team
    union all
    select sidecar.id, sidecar.drive_file_id, sidecar.resource_key,
           sidecar.parent_folder_id,
           case when result.kind = 'transcription' then 'transcript' else 'translation' end
    from public.team_library_results as result
    join public.team_materials as sidecar
      on sidecar.id = result.material_id and sidecar.team_id = result.team_id
    where result.team_id = p_team and result.source_material_id = p_material
      and result.state = 'current' and sidecar.lifecycle = 'active'
  ) as member;

  insert into private.team_material_group_intents (
    team_id, source_material_id, operation_id, action, destination_parent_id,
    member_snapshot, state
  ) values (
    p_team, p_material, p_operation, 'move', p_destination_parent_id,
    snapshot, 'running'
  ) returning id into created_id;

  update public.team_materials as material
     set placement_state = 'moving'
   where material.team_id = p_team
     and material.id in (
       select (entry ->> 'material_id')::uuid from jsonb_array_elements(snapshot) as entry
     );
  update public.team_operations
     set state = 'running', stage = 'moving_group', progress = 5,
         updated_at = clock_timestamp()
   where id = p_operation;

  return query
  select intent.id, intent.team_id, intent.operation_id, intent.source_material_id,
         intent.action, intent.member_snapshot, intent.applied_member_ids
  from private.team_material_group_intents as intent where intent.id = created_id;
end;
$$;

create or replace function public.service_create_folder_lifecycle_intent(
  p_team uuid, p_actor uuid, p_operation uuid, p_material uuid,
  p_action text, p_destination_parent_id text default null
)
returns table (
  intent_id uuid, team_id uuid, operation_id uuid, source_material_id uuid,
  action text, members jsonb, applied_member_ids uuid[]
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  source public.team_materials%rowtype;
  existing private.team_material_group_intents%rowtype;
  created_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('material-group-members:'||p_team::text,0));
  if p_action not in ('trash', 'restore') or not private.can(p_team, 'delete', p_actor)
     or not exists (
       select 1 from public.team_operations as operation
       where operation.id = p_operation and operation.team_id = p_team
         and operation.actor_id = p_actor and operation.kind = p_action
         and operation.source_material_id = p_material
         and operation.state in ('pending', 'running')
     ) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  select * into existing from private.team_material_group_intents as intent
  where intent.operation_id = p_operation for update;
  if existing.id is not null then
    return query select existing.id, existing.team_id, existing.operation_id,
      existing.source_material_id, existing.action, existing.member_snapshot,
      existing.applied_member_ids;
    return;
  end if;

  select * into source from public.team_materials as material
  where material.id = p_material and material.team_id = p_team for update;
  if source.id is null or source.kind <> 'folder'
     or (p_action = 'restore' and source.lifecycle <> 'trashed')
     or (p_action = 'trash' and source.lifecycle <> 'active')
     or source.folder_trash_root is not null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into private.team_material_group_intents (
    team_id, source_material_id, operation_id, action, destination_parent_id,
    member_snapshot, state
  ) values (
    p_team, p_material, p_operation, p_action, p_destination_parent_id,
    jsonb_build_array(jsonb_build_object(
      'material_id', source.id,
      'drive_file_id', source.drive_file_id,
      'resource_key', source.resource_key,
      'parent_folder_id', source.parent_folder_id,
      'role', 'source'
    )), 'running'
  ) returning id into created_id;
  update public.team_materials as material set placement_state = 'moving'
  where material.id = p_material and material.team_id = p_team;
  return query select intent.id, intent.team_id, intent.operation_id,
    intent.source_material_id, intent.action, intent.member_snapshot,
    intent.applied_member_ids
  from private.team_material_group_intents as intent where intent.id = created_id;
end;
$$;

create function private.guard_material_group_execution()
returns trigger language plpgsql security definer set search_path='' as $$
declare o public.team_operations%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('material-group-members:'||new.team_id::text,0));
  if exists(
    select 1 from private.team_material_group_intents prior
    where prior.team_id=new.team_id
      and (prior.state in('pending','running','reconciling') or
        (prior.state='failed' and ((prior.execution_protocol=1 and prior.execution_closed is true and prior.dispatch_member is null) is not true)))
      and (
        prior.source_material_id=new.source_material_id or
        exists(select 1 from jsonb_array_elements(prior.member_snapshot) om where
          lower(om->>'material_id')=new.source_material_id::text or
          exists(select 1 from jsonb_array_elements(new.member_snapshot) nm where lower(nm->>'material_id')=lower(om->>'material_id'))) or
        exists(select 1 from jsonb_array_elements(new.member_snapshot) nm where lower(nm->>'material_id')=prior.source_material_id::text)
      )
  ) then raise exception 'GROUP_RECONCILING' using errcode='55000'; end if;
  select * into o from public.team_operations where id=new.operation_id;
  if o.request_nonce ~ '^group-v1:[0-9a-f]{64}$' then
    if o.team_id is distinct from new.team_id or o.source_material_id is distinct from new.source_material_id
       or o.kind is distinct from new.action then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
    new.execution_protocol:=1; new.execution_owner:=null;
    new.execution_closed:=true; new.dispatch_member:=null;
  else
    new.execution_protocol:=null; new.execution_owner:=null;
    new.execution_closed:=null; new.dispatch_member:=null;
  end if;
  return new;
end;
$$;
revoke all on function private.guard_material_group_execution() from public,anon,authenticated,service_role;
create trigger guard_material_group_execution before insert on private.team_material_group_intents
for each row execute function private.guard_material_group_execution();

create or replace function public.service_checkpoint_material_group_intent(
  p_intent uuid,
  p_material uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  intent private.team_material_group_intents%rowtype;
begin
  select * into intent from private.team_material_group_intents as candidate
  where candidate.id = p_intent for update;
  if intent.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  -- Managed members can only be confirmed by their held execution owner.
  if intent.execution_protocol = 1 then return false; end if;
  if intent.state not in ('running','reconciling') then
    return p_material = any(intent.applied_member_ids);
  end if;
  if not exists (
    select 1 from jsonb_array_elements(intent.member_snapshot) as member
    where (member ->> 'material_id')::uuid = p_material
  ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update private.team_material_group_intents
     set applied_member_ids = array(
       select distinct value from unnest(intent.applied_member_ids || p_material) as value
       order by value
     ), state = 'running', error_code = null
   where id = p_intent;
  return true;
end;
$$;

create function public.service_claim_material_group_execution(p_intent uuid,p_executor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  g private.team_material_group_intents%rowtype;
  o public.team_operations%rowtype;
  acquired boolean:=false;
  completed boolean:=false;
begin
  if p_executor is null then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
  select * into g from private.team_material_group_intents where id=p_intent for update;
  if g.id is null then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  select * into o from public.team_operations where id=g.operation_id;
  if o.id is null or not private.can(g.team_id,case when g.action='move' then 'edit' else 'delete' end,o.actor_id) then
    raise exception 'PERMISSION_DENIED' using errcode='42501';
  end if;
  if g.execution_protocol=1 then
    completed:=g.dispatch_member is null and cardinality(g.applied_member_ids)=jsonb_array_length(g.member_snapshot);
    if not completed and g.state in('pending','running','reconciling') and o.state in('pending','running')
       and (g.execution_owner is null or (g.execution_closed is true and g.dispatch_member is null)) then
      update private.team_material_group_intents
        set execution_owner=p_executor,execution_closed=false where id=g.id;
      acquired:=true;
    end if;
  end if;
  return jsonb_build_object('intentId',g.id,'teamId',g.team_id,'operationId',g.operation_id,
    'sourceMaterialId',g.source_material_id,'acquired',acquired,'completed',completed,
    'appliedMemberIds',to_jsonb(g.applied_member_ids));
end;
$$;

create function public.service_begin_material_group_dispatch(p_intent uuid,p_executor uuid,p_material uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare g private.team_material_group_intents%rowtype; o public.team_operations%rowtype;
begin
  select * into g from private.team_material_group_intents where id=p_intent for update;
  if g.id is null or g.execution_protocol is distinct from 1 or g.execution_owner is distinct from p_executor
     or g.execution_closed is distinct from false or g.dispatch_member is not null
     or g.state not in('pending','running','reconciling')
     or p_material=any(g.applied_member_ids) then return false; end if;
  select * into o from public.team_operations where id=g.operation_id;
  if o.id is null or o.state not in('pending','running')
     or not private.can(g.team_id,case when g.action='move' then 'edit' else 'delete' end,o.actor_id) then
    raise exception 'PERMISSION_DENIED' using errcode='42501';
  end if;
  if not exists(select 1 from jsonb_array_elements(g.member_snapshot) m where m->>'material_id'=p_material::text) then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  update private.team_material_group_intents set dispatch_member=p_material where id=g.id;
  return true;
end;
$$;

create function private.checkpoint_material_group_execution(p_intent uuid,p_executor uuid,p_material uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare g private.team_material_group_intents%rowtype;
begin
  select * into g from private.team_material_group_intents where id=p_intent for update;
  if g.id is null or g.execution_protocol is distinct from 1 or g.execution_owner is distinct from p_executor then return false; end if;
  if p_material=any(g.applied_member_ids) and g.dispatch_member is distinct from p_material then return true; end if;
  if g.execution_closed is distinct from false or g.dispatch_member is distinct from p_material
     or g.state not in('pending','running','reconciling') then return false; end if;
  update private.team_material_group_intents
    set applied_member_ids=array(select distinct x from unnest(g.applied_member_ids||p_material)x order by x),
        dispatch_member=null,state='running',error_code=null where id=g.id;
  return true;
end;
$$;
revoke all on function private.checkpoint_material_group_execution(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function public.service_checkpoint_material_group_execution(p_intent uuid,p_executor uuid,p_material uuid)
returns boolean language sql security definer set search_path='' as $$
  select private.checkpoint_material_group_execution(p_intent,p_executor,p_material);
$$;

create function public.service_end_material_group_execution(
  p_intent uuid,p_executor uuid,p_not_dispatched uuid default null,p_acknowledged uuid default null
)
returns boolean language plpgsql security definer set search_path='' as $$
declare g private.team_material_group_intents%rowtype;
begin
  if p_not_dispatched is not null and p_acknowledged is not null then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  select * into g from private.team_material_group_intents where id=p_intent for update;
  if g.id is null or g.execution_protocol is distinct from 1 or g.execution_owner is distinct from p_executor then return false; end if;
  if p_acknowledged is not null then
    if not private.checkpoint_material_group_execution(p_intent,p_executor,p_acknowledged) then return false; end if;
  elsif p_not_dispatched is not null and g.dispatch_member=p_not_dispatched then
    update private.team_material_group_intents set dispatch_member=null where id=g.id;
  end if;
  update private.team_material_group_intents set execution_closed=true where id=g.id;
  return true;
end;
$$;

revoke all on function public.service_claim_material_group_execution(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.service_begin_material_group_dispatch(uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.service_checkpoint_material_group_execution(uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.service_end_material_group_execution(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.service_claim_material_group_execution(uuid,uuid) to service_role;
grant execute on function public.service_begin_material_group_dispatch(uuid,uuid,uuid) to service_role;
grant execute on function public.service_checkpoint_material_group_execution(uuid,uuid,uuid) to service_role;
grant execute on function public.service_end_material_group_execution(uuid,uuid,uuid,uuid) to service_role;

-- Only closed states, opaque identities and bounded counts; no snapshots, paths or provider IDs.
create view public.analytics_material_group_execution with(security_barrier=true) as
select g.id,g.operation_id,g.team_id,o.actor_id,g.action,
 case
  when g.state='succeeded' then 'registered'
  when g.execution_protocol is null then 'legacy_unknown'
  when g.dispatch_member is not null then 'dispatch_unconfirmed'
  when cardinality(g.applied_member_ids)=jsonb_array_length(g.member_snapshot) then 'provider_confirmed'
  when g.execution_owner is null then 'accepted'
  when g.execution_closed is true then 'retryable_no_pending'
  else 'executor_reserved'
 end as state,
 case when coalesce(g.error_code,o.error_code) is null then null
      when exists(select 1 from public.team_error_codes c where c.code=coalesce(g.error_code,o.error_code))
      then coalesce(g.error_code,o.error_code) else 'UNKNOWN' end as code,
 jsonb_array_length(g.member_snapshot)::integer as member_count,
 cardinality(g.applied_member_ids)::integer as confirmed_count,
 (g.dispatch_member is not null) as has_unconfirmed_dispatch,
 g.created_at,greatest(g.updated_at,o.updated_at) as updated_at
from private.team_material_group_intents g
join public.team_operations o on o.id=g.operation_id and o.team_id=g.team_id
 and o.source_material_id=g.source_material_id and o.kind=g.action;
revoke all on public.analytics_material_group_execution from public,anon,authenticated,service_role;
grant select on public.analytics_material_group_execution to service_role;
do $$begin
 if exists(select 1 from pg_catalog.pg_roles where rolname='wishly_analytics_ro') then
  grant select on public.analytics_material_group_execution to wishly_analytics_ro;
 end if;
end$$;
