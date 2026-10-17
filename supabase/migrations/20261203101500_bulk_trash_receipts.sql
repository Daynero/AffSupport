-- Hosted, content-free group intent. The operation table remains the receipt authority.
create table private.team_bulk_trash_groups (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  actor_id uuid not null references auth.users(id),
  request_id uuid not null,
  material_ids uuid[] not null,
  created_at timestamptz not null default now(),
  unique (team_id, actor_id, request_id),
  unique (id, team_id)
);

create table private.team_bulk_trash_items (
  group_id uuid not null,
  team_id uuid not null,
  material_id uuid not null,
  ordinal integer not null check (ordinal between 1 and 100),
  idempotency_key uuid not null default gen_random_uuid(),
  primary key (group_id, material_id),
  unique (group_id, ordinal),
  unique (team_id, idempotency_key),
  foreign key (group_id, team_id) references private.team_bulk_trash_groups(id, team_id) on delete cascade,
  foreign key (material_id, team_id) references public.team_materials(id, team_id) on delete restrict
);

revoke all on private.team_bulk_trash_groups, private.team_bulk_trash_items from public, anon, authenticated;

alter table public.team_catalog_events drop constraint team_catalog_events_kind_check;
alter table public.team_catalog_events add constraint team_catalog_events_kind_check check (
  event_kind in (
    'upserted', 'tombstoned', 'restored', 'sync_state',
    'folder_indexed', 'thumbnail_ready', 'storage_state', 'bulk_trash_changed'
  )
);

create function public.begin_team_bulk_trash(p_team uuid, p_request uuid, p_materials uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  existing private.team_bulk_trash_groups%rowtype;
  v_group_id uuid;
  result jsonb;
begin
  if actor is null or not private.can(p_team, 'delete', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_request is null or p_materials is null or cardinality(p_materials) not between 1 and 100
    or array_position(p_materials, null) is not null
    or (select count(distinct id) from unnest(p_materials) ids(id)) <> cardinality(p_materials) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into existing from private.team_bulk_trash_groups
    where team_id = p_team and actor_id = actor and request_id = p_request for update;
  if found then
    if existing.material_ids <> p_materials then
      raise exception 'REQUEST_REUSE_CONFLICT' using errcode = '22023';
    end if;
    v_group_id := existing.id;
  else
    if exists (
      select 1 from unnest(p_materials) ids(id)
      where not exists (
        select 1 from public.team_materials m
        where m.id = ids.id and m.team_id = p_team and m.lifecycle = 'active'
      )
    ) then
      raise exception 'NOT_FOUND' using errcode = 'P0002';
    end if;
    insert into private.team_bulk_trash_groups(team_id, actor_id, request_id, material_ids)
      values (p_team, actor, p_request, p_materials) returning id into v_group_id;
    insert into private.team_bulk_trash_items(group_id, team_id, material_id, ordinal)
      select v_group_id, p_team, id, ordinal::integer
      from unnest(p_materials) with ordinality ids(id, ordinal);
    insert into public.team_catalog_events(team_id, material_id, event_kind)
      values (p_team, null, 'bulk_trash_changed');
  end if;
  select jsonb_build_object(
    'id', v_group_id, 'requestId', p_request,
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'materialId', item.material_id, 'idempotencyKey', item.idempotency_key
    ) order by item.ordinal), '[]'::jsonb)
  ) into result from private.team_bulk_trash_items item where item.group_id = v_group_id;
  return result;
end $$;

create function public.list_team_bulk_trash(p_team uuid)
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
          when op.id is null then 'queued'
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

revoke all on function public.begin_team_bulk_trash(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.begin_team_bulk_trash(uuid, uuid, uuid[]) to authenticated;
revoke all on function public.list_team_bulk_trash(uuid) from public, anon;
grant execute on function public.list_team_bulk_trash(uuid) to authenticated;
