-- Retry only after reading the authoritative item and provider operation state.
create function public.prepare_team_bulk_trash_retry(p_team uuid, p_group uuid, p_material uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  item private.team_bulk_trash_items%rowtype;
  operation_row public.team_operations%rowtype;
  lifecycle text;
begin
  if actor is null or not private.can(p_team, 'delete', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  perform 1 from private.team_bulk_trash_groups
    where id = p_group and team_id = p_team and actor_id = actor for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select * into item from private.team_bulk_trash_items
    where group_id = p_group and team_id = p_team and material_id = p_material for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select m.lifecycle into lifecycle from public.team_materials m
    where m.id = p_material and m.team_id = p_team for update;
  if lifecycle = 'trashed' then return jsonb_build_object('status','confirmed'); end if;
  if lifecycle is distinct from 'active' then return jsonb_build_object('status','unknown'); end if;
  select * into operation_row from public.team_operations op
    where op.team_id = p_team and op.actor_id = actor and op.kind = 'trash'
      and op.idempotency_key = item.idempotency_key::text
      and op.source_material_id = p_material for update;
  if operation_row.state in ('pending','running') then
    return jsonb_build_object('status','active');
  end if;
  if operation_row.state = 'succeeded' then
    return jsonb_build_object('status','unknown');
  end if;
  if item.attempt_count >= 20 then
    return jsonb_build_object('status','exhausted');
  end if;
  if operation_row.state in ('failed','canceled') then
    update private.team_bulk_trash_items
      set idempotency_key = gen_random_uuid(), attempted_at = null
      where group_id = p_group and material_id = p_material
      returning * into item;
    insert into public.team_catalog_events(team_id, material_id, event_kind)
      values (p_team, null, 'bulk_trash_changed');
  end if;
  return jsonb_build_object('status','retryable','idempotencyKey',item.idempotency_key);
end $$;
revoke all on function public.prepare_team_bulk_trash_retry(uuid, uuid, uuid) from public, anon;
grant execute on function public.prepare_team_bulk_trash_retry(uuid, uuid, uuid) to authenticated;

-- Category is bounded catalog metadata, enough to retain the material-tail behavior on retry.
-- Names, paths, provider identifiers and payloads stay out of the receipt.
create or replace function public.list_team_bulk_trash(p_team uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', groups.id, 'requestId', groups.request_id,
    'createdAt', groups.created_at,
    'items', groups.items
  ) order by groups.created_at desc, groups.id desc), '[]'::jsonb) into result
  from (
    select g.id, g.request_id, g.created_at,
      coalesce(jsonb_agg(jsonb_build_object(
        'materialId', item.material_id,
        'category', material.category,
        'idempotencyKey', item.idempotency_key,
        'operationId', op.id,
        'state', case
          when op.id is null and item.attempted_at is null then 'queued'
          when op.id is null then 'unknown'
          when op.state = 'succeeded' and material.lifecycle = 'trashed' then 'confirmed'
          when op.state = 'succeeded' then 'unknown'
          when op.state in ('failed', 'canceled') then 'failed'
          else 'active' end,
        'errorCode', case when op.state in ('failed', 'canceled') then op.error_code else null end
      ) order by item.ordinal), '[]'::jsonb) as items
    from (select * from private.team_bulk_trash_groups
      where team_id = p_team order by created_at desc, id desc limit 25) g
    join private.team_bulk_trash_items item on item.group_id = g.id
    left join public.team_materials material on material.id = item.material_id and material.team_id = p_team
    left join public.team_operations op on op.team_id = p_team
      and op.actor_id = g.actor_id and op.kind = 'trash'
      and op.idempotency_key = item.idempotency_key::text
      and op.source_material_id = item.material_id
    group by g.id, g.request_id, g.created_at
  ) groups;
  return result;
end $$;
