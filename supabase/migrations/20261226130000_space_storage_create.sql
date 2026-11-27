-- 057 M1 (T015): creating a space on R2, and the facts every space-storage request is checked
-- against (specs/057-r2-workspaces/contracts/storage-api.md).
--
-- Additive: one private table, three service functions.
--
-- * service_create_r2_space(actor, name, key): a pilot (storage_r2_pilots) creates a space with
--   storage_backend='r2', storage_pilot=true, an owner membership and the root folder, in one
--   transaction. No 034 tariff is bound or needed: the pilot gate in team_workspace_allowed opens
--   it (20261226120000). The same key from the same person returns the same space, so a lost
--   reply never makes a second one. Removing the pilot later never deletes the space (US11.5).
-- * service_space_storage_context(team, actor, permission): the closed facts the edge function
--   checks on every request — membership, backend, pilot mark of the space and of the ACTING
--   person, tariff gate and the permission. A service call has no auth.uid(), so
--   team_workspace_allowed answers for the owner; the acting person's own pilot status has to be
--   read here and checked by the function (contract check 3).

create table private.space_create_requests (
  actor_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  team_id uuid not null references public.teams(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (actor_id, idempotency_key)
);
revoke all on table private.space_create_requests from public, anon, authenticated;

create function private.space_created_snapshot(p_team uuid, p_actor uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'teamId', team.id,
    'rootMaterialId', team.storage_root_material_id,
    'storageBackend', team.storage_backend,
    'storagePilot', team.storage_pilot,
    'name', team.name,
    'role', case when team.owner_id = p_actor then 'owner' else member.base_role end,
    'permissions', private.effective_permissions(team.id, p_actor),
    'connectionState', 'none',
    'contentRevision', team.content_revision::text)
  from public.teams team
  left join public.team_members member
    on member.team_id = team.id and member.user_id = p_actor and member.status = 'active'
  where team.id = p_team;
$$;

create function public.service_create_r2_space(p_actor uuid, p_name text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  normalized_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  existing uuid;
  created_id uuid;
  root_id uuid;
begin
  if p_actor is null or not private.team_profile_active(p_actor) then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{16,128}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  -- One creation at a time per person, so a retry racing its own first attempt waits for it.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('space-create:' || p_actor::text, 0));

  select request.team_id into existing
  from private.space_create_requests request
  join public.teams team on team.id = request.team_id and team.status = 'active'
  where request.actor_id = p_actor and request.idempotency_key = p_idempotency_key;
  if existing is not null then
    return private.space_created_snapshot(existing, p_actor);
  end if;

  if not private.is_storage_r2_pilot_user(p_actor) then
    raise exception 'R2_PILOT_REQUIRED' using errcode = '42501';
  end if;
  if char_length(normalized_name) not between 1 and 120 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  -- The same rule as create_team: no two of your own active spaces share a name.
  if exists (
    select 1
    from public.team_members member
    join public.teams team on team.id = member.team_id
    where member.user_id = p_actor
      and member.status = 'active'
      and team.status = 'active'
      and lower(btrim(team.name)) = lower(normalized_name)
  ) then
    raise exception 'NAME_CONFLICT' using errcode = '23505';
  end if;

  insert into public.teams (name, owner_id, storage_backend, storage_pilot)
  values (normalized_name, p_actor, 'r2', true)
  returning id into created_id;
  insert into public.team_members (team_id, user_id, base_role)
  values (created_id, p_actor, 'admin');
  insert into public.team_materials (team_id, name, kind)
  values (created_id, normalized_name, 'folder')
  returning id into root_id;
  update public.teams set storage_root_material_id = root_id where id = created_id;
  insert into private.space_create_requests (actor_id, idempotency_key, team_id)
  values (p_actor, p_idempotency_key, created_id);

  perform private.record_team_audit(
    created_id, p_actor, 'team.created',
    jsonb_build_object('material_id', root_id, 'state', 'r2'), 'succeeded', null);
  return private.space_created_snapshot(created_id, p_actor);
end;
$$;

create function public.service_space_storage_context(p_team uuid, p_actor uuid, p_permission text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when team.id is null then null else jsonb_build_object(
    'member', member.user_id is not null,
    'storageBackend', team.storage_backend,
    'storagePilot', team.storage_pilot,
    'actorPilot', private.is_storage_r2_pilot_user(p_actor),
    -- The tariff gate as it stands for the space, apart from the pilot rule checked above.
    'workspaceAllowed', team.storage_pilot or private.team_workspace_allowed(team.id),
    'archived', false,
    'allowed', member.user_id is not null
      and p_permission in ('view','download','upload','edit','delete','process','manage_members','manage_metadata')
      and coalesce((private.effective_permissions(team.id, p_actor) ->> p_permission)::boolean, false),
    'accessEpoch', team.access_epoch::text,
    'contentRevision', team.content_revision::text,
    'rootMaterialId', team.storage_root_material_id) end
  from (select 1) one
  left join public.teams team on team.id = p_team and team.status = 'active'
  left join public.team_members member
    on member.team_id = team.id and member.user_id = p_actor and member.status = 'active'
    and private.team_profile_active(p_actor);
$$;

revoke all on function private.space_created_snapshot(uuid, uuid) from public, anon, authenticated;
revoke all on function public.service_create_r2_space(uuid, text, text) from public, anon, authenticated;
grant execute on function public.service_create_r2_space(uuid, text, text) to service_role;
revoke all on function public.service_space_storage_context(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.service_space_storage_context(uuid, uuid, text) to service_role;
