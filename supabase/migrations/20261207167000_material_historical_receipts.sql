-- Original completion and present catalog observation are separate facts. This
-- reader never issues execution authority or changes operation/material rows.
create function private.material_historical_receipt(
  p_team uuid, p_actor uuid, p_operation uuid, p_material uuid,
  p_action text, p_destination uuid default null
) returns jsonb language plpgsql stable set search_path='' as $$
declare
  o public.team_operations%rowtype;
  g private.team_material_group_intents%rowtype;
  total integer;
  matching integer;
  missing integer;
begin
  if p_action not in ('trash','restore') then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
  select * into o from public.team_operations where id=p_operation;
  if o.id is null or o.team_id is distinct from p_team or o.actor_id is distinct from p_actor then
    raise exception 'PERMISSION_DENIED' using errcode='42501';
  end if;
  if o.source_material_id is distinct from p_material or o.kind is distinct from p_action
     or o.destination_folder_id is distinct from p_destination then
    raise exception 'REQUEST_REUSE_CONFLICT' using errcode='22023';
  end if;
  select * into g from private.team_material_group_intents where operation_id=p_operation;
  if o.state is distinct from 'succeeded' or g.id is null or g.state is distinct from 'succeeded'
     or (g.execution_protocol is null or g.execution_protocol not in (1,2)) or g.execution_closed is distinct from true
     or g.dispatch_member is not null or g.team_id is distinct from p_team
     or g.source_material_id is distinct from p_material or g.action is distinct from p_action
     or jsonb_typeof(g.member_snapshot)<>'array' then return null; end if;
  total:=jsonb_array_length(g.member_snapshot);
  if total<1 or total>5000 or g.applied_member_ids is null or cardinality(g.applied_member_ids)<>total then return null; end if;
  -- Refuse a malformed historical manifest rather than invent original success.
  if (select count(distinct member->>'material_id') from jsonb_array_elements(g.member_snapshot) member)<>total
     or (select count(distinct id) from unnest(g.applied_member_ids) id)<>total then return null; end if;
  if exists(select 1 from jsonb_array_elements(g.member_snapshot) member
    where member->>'material_id' is null or member->>'drive_file_id' is null
      or not ((member->>'material_id')::uuid=any(g.applied_member_ids))) then return null; end if;
  select count(*) filter(where m.id is not null and m.drive_file_id=member->>'drive_file_id'
      and m.placement_state='ready' and m.parent_folder_id=case when p_action='restore' then coalesce(g.destination_parent_id,member->>'parent_folder_id') else member->>'parent_folder_id' end and m.lifecycle=case when p_action='trash' then 'trashed' else 'active' end),
    count(*) filter(where m.id is null or m.drive_file_id is distinct from member->>'drive_file_id' or m.placement_state is distinct from 'ready' or m.lifecycle not in ('active','trashed') or member->>'parent_folder_id' is null)
  into matching,missing
  from jsonb_array_elements(g.member_snapshot) member
  left join public.team_materials m on m.id=(member->>'material_id')::uuid and m.team_id=p_team;
  return jsonb_build_object('operationId',o.id,'state','succeeded','materialId',p_material,'reused',true,
    'historicalReceipt',jsonb_build_object('protocolVersion',1,'action',p_action,
      'basis','catalog_snapshot','observedAt',statement_timestamp(),
      'state',case when missing>0 then 'unknown' when matching=total then 'matches' else 'changed' end,
      'memberCount',total,'matchingCount',matching,'missingCount',missing));
end;
$$;
revoke all on function private.material_historical_receipt(uuid,uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
create function public.service_read_material_historical_receipt(
 p_team uuid,p_actor uuid,p_operation uuid,p_material uuid,p_action text,p_destination uuid default null
) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not private.can(p_team,'delete',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 return private.material_historical_receipt(p_team,p_actor,p_operation,p_material,p_action,p_destination);
end;
$$;
revoke all on function public.service_read_material_historical_receipt(uuid,uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.service_read_material_historical_receipt(uuid,uuid,uuid,uuid,text,uuid) to service_role;

-- A reopened bulk receipt keeps evidence of a later catalog-state change. Normal
-- newly confirmed matching receipts keep their existing original-completion shape.
create or replace function private.bulk_trash_snapshot(p_group uuid) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('id',g.id,'teamId',g.team_id,'actorId',g.actor_id,'items',coalesce((
 select jsonb_agg((jsonb_build_object('materialId',i.material_id,'idempotencyKey',i.idempotency_key,
 'state',case when o.state='succeeded' then 'confirmed' when o.state in ('failed','canceled') then 'failed'
 when o.state in ('pending','running') then 'running' when i.requested_at is not null then 'unknown' else 'queued' end,
 'errorCode',case when o.state='succeeded' then null else coalesce(o.error_code,i.error_code) end)
 || case when h.receipt->'historicalReceipt'->>'state' in ('changed','unknown')
 then jsonb_build_object('historicalReceipt',h.receipt->'historicalReceipt') else '{}'::jsonb end) order by i.material_id)
 from private.team_bulk_trash_items i left join public.team_operations o on o.team_id=g.team_id and o.actor_id=g.actor_id
 and o.kind='trash' and o.idempotency_key=i.idempotency_key
 left join lateral (select case when o.state='succeeded' then
 private.material_historical_receipt(g.team_id,g.actor_id,o.id,i.material_id,'trash',null) else null::jsonb end receipt) h on true
 where i.group_id=g.id),'[]'::jsonb))
 from private.team_bulk_trash_groups g where g.id=p_group
$$;
revoke all on function private.bulk_trash_snapshot(uuid) from public,anon,authenticated;

-- A lost old reply can be inspected even if the current material is missing.
-- An absent/nonterminal key is only absence of historical evidence, never new
-- admission. The normal mutation path decides independently whether to proceed.
create function public.service_read_material_historical_receipt_by_key(
 p_team uuid,p_actor uuid,p_material uuid,p_action text,p_key text,p_destination uuid default null
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare o public.team_operations%rowtype; receipt jsonb;
begin
 if p_key is null or p_key !~* '^[a-z0-9][a-z0-9._:-]{7,199}$' or p_action not in ('trash','restore') then
  raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 if not private.can(p_team,'delete',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 select * into o from public.team_operations where team_id=p_team and actor_id=p_actor and idempotency_key=p_key;
 if o.id is null then return null; end if;
 if o.source_material_id is null then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000'; end if;
 if o.source_material_id is distinct from p_material or o.kind is distinct from p_action
  or o.destination_folder_id is distinct from p_destination then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='22023'; end if;
 if o.state is distinct from 'succeeded' then return null; end if;
 receipt:=private.material_historical_receipt(p_team,p_actor,o.id,p_material,p_action,p_destination);
 if receipt is null then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000'; end if;
 return receipt;
end;
$$;
revoke all on function public.service_read_material_historical_receipt_by_key(uuid,uuid,uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.service_read_material_historical_receipt_by_key(uuid,uuid,uuid,text,text,uuid) to service_role;

-- Diagnostic consumers see counts and opaque correlations only. Original
-- registration remains in analytics_material_group_execution; this is a separate
-- present catalog observation, never a provider receipt or as-of reconstruction.
create view public.analytics_material_historical_observations with(security_barrier=true) as
select g.id,g.operation_id,g.team_id,o.actor_id,g.action,
 'catalog_snapshot'::text as basis, statement_timestamp() as observed_at,
 case when x.missing_count>0 then 'unknown' when x.matching_count=x.member_count then 'matches' else 'changed' end as state,
 x.member_count,x.matching_count,x.missing_count,g.created_at,greatest(g.updated_at,o.updated_at) as updated_at
from private.team_material_group_intents g
join public.team_operations o on o.id=g.operation_id and o.team_id=g.team_id
 and o.source_material_id=g.source_material_id and o.kind=g.action
cross join lateral (
 select count(*)::integer member_count,
 count(*) filter(where m.id is not null and m.drive_file_id=member->>'drive_file_id'
  and m.placement_state='ready' and m.parent_folder_id=case when g.action='restore' then coalesce(g.destination_parent_id,member->>'parent_folder_id') else member->>'parent_folder_id' end
  and m.lifecycle=case when g.action='trash' then 'trashed' else 'active' end)::integer matching_count,
 count(*) filter(where m.id is null or m.drive_file_id is distinct from member->>'drive_file_id'
  or m.placement_state is distinct from 'ready' or m.lifecycle not in ('active','trashed') or member->>'parent_folder_id' is null)::integer missing_count
 from jsonb_array_elements(case when jsonb_typeof(g.member_snapshot)='array'
  and jsonb_array_length(g.member_snapshot) between 1 and 5000 then g.member_snapshot else '[]'::jsonb end) member
 left join public.team_materials m on m.id=(member->>'material_id')::uuid and m.team_id=g.team_id
) x
where o.state='succeeded' and g.state='succeeded' and g.action in ('trash','restore')
 and g.execution_protocol in (1,2) and g.execution_closed is true and g.dispatch_member is null
 and cardinality(g.applied_member_ids)=x.member_count and x.member_count between 1 and 5000
 and (select count(distinct member->>'material_id') from jsonb_array_elements(g.member_snapshot) member)=x.member_count
 and (select count(distinct id) from unnest(g.applied_member_ids) id)=x.member_count
 and not exists(select 1 from jsonb_array_elements(g.member_snapshot) member
   where member->>'material_id' is null or member->>'drive_file_id' is null
    or not ((member->>'material_id')::uuid=any(g.applied_member_ids)));
revoke all on public.analytics_material_historical_observations from public,anon,authenticated,service_role;
grant select on public.analytics_material_historical_observations to service_role;
do $$begin
 if exists(select 1 from pg_catalog.pg_roles where rolname='wishly_analytics_ro') then
  grant select on public.analytics_material_historical_observations to wishly_analytics_ro;
 end if;
end$$;
