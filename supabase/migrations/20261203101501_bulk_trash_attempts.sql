-- A dispatched item without an operation receipt is unknown, not queued.
alter table private.team_bulk_trash_items
  add column attempted_at timestamptz,
  add column attempt_count integer not null default 0 check (attempt_count between 0 and 20);

create function public.mark_team_bulk_trash_attempt(p_team uuid, p_group uuid, p_material uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  if actor is null or not private.can(p_team, 'delete', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  perform 1 from private.team_bulk_trash_groups
    where id = p_group and team_id = p_team and actor_id = actor for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  update private.team_bulk_trash_items item
    set attempted_at = clock_timestamp(), attempt_count = attempt_count + 1
    where item.group_id = p_group and item.team_id = p_team and item.material_id = p_material
      and item.attempt_count < 20;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  insert into public.team_catalog_events(team_id, material_id, event_kind)
    values (p_team, null, 'bulk_trash_changed');
end $$;
revoke all on function public.mark_team_bulk_trash_attempt(uuid, uuid, uuid) from public, anon;
grant execute on function public.mark_team_bulk_trash_attempt(uuid, uuid, uuid) to authenticated;

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
