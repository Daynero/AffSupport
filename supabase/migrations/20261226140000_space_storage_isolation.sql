-- 057 M1 (T020): the Drive paths never touch an R2 space (specs/057-r2-workspaces, FR-014, FR-054).
--
-- Additive: two function bodies are replaced with the previous query behind one guard, two are
-- patched in place, two are new. A Drive space behaves exactly as before.
--
-- * service_get_material_operation_context / service_get_root_operation_context — every file
--   route of drive-ops resolves its material or its root through one of them, so an R2 space is
--   refused there with STORAGE_BACKEND_MISMATCH instead of an empty answer read as
--   PERMISSION_DENIED. Only a member is told: someone outside the space learns nothing.
-- * service_space_storage_backend(team, actor) — the backend of a space for one of its members,
--   for the Edge paths that have no context function of their own (drive-transfer after the
--   caller is known, drive-ops process output).
-- * service_team_recovery 'claim' — delegated background work for an R2 space is claimed only
--   by an agent that declares team workspace contract 3; contract 2 gets AGENT_UPDATE_REQUIRED.
-- * private.claim_catalog_sync_jobs — an explicit storage_backend='drive' condition, although an
--   R2 space already can never get a Drive connection (20261226110000).

create function private.require_drive_space(p_team uuid, p_actor uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (
    select 1 from public.teams team
    where team.id = p_team and team.storage_backend = 'r2'
      and (p_actor is null or exists (
        select 1 from public.team_members member
        where member.team_id = team.id and member.user_id = p_actor and member.status = 'active'))
  ) then
    raise exception 'STORAGE_BACKEND_MISMATCH' using errcode = '55000';
  end if;
end;
$$;

-- Same query as 20260801102000, behind the guard.
CREATE OR REPLACE FUNCTION public.service_get_material_operation_context(p_team uuid, p_material uuid, p_actor uuid, p_permission text, p_allow_trashed boolean DEFAULT false)
 RETURNS TABLE(team_id uuid, material_id uuid, actor_id uuid, connection_id uuid, credential_id uuid, root_folder_id text, root_resource_key text, drive_id text, drive_file_id text, resource_key text, parent_folder_id text, name text, kind text, lifecycle text, category text, mime_type text, file_extension text, size_bytes bigint, drive_version text, checksum text, transcript_ingest_state text, transcript_truncated boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_drive_space(p_team, p_actor);
  return query
  select material.team_id,
         material.id,
         p_actor,
         connection.id,
         connection.credential_id,
         connection.root_folder_id,
         connection.root_resource_key,
         connection.drive_id,
         material.drive_file_id,
         material.resource_key,
         material.parent_folder_id,
         material.name,
         material.kind,
         material.lifecycle,
         material.category,
         material.mime_type,
         material.file_extension,
         material.size_bytes,
         material.drive_version,
         material.checksum,
         material.transcript_ingest_state,
         material.transcript_truncated
  from public.team_materials as material
  join public.team_drive_connections as connection
    on connection.id = material.connection_id
   and connection.team_id = material.team_id
  where material.id = p_material
    and material.team_id = p_team
    and connection.state = 'connected'
    and (material.lifecycle = 'active' or (p_allow_trashed and material.lifecycle = 'trashed'))
    and p_permission in ('view','download','upload','edit','delete','process','manage_metadata')
    and private.can(p_team, p_permission, p_actor)
  limit 1;
end;
$function$;

-- Same query as 20260829110000, behind the guard.
CREATE OR REPLACE FUNCTION public.service_get_root_operation_context(p_team uuid, p_actor uuid, p_permission text)
 RETURNS TABLE(team_id uuid, actor_id uuid, connection_id uuid, credential_id uuid, root_folder_id text, root_resource_key text, drive_id text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_drive_space(p_team, p_actor);
  return query
  select connection.team_id,
         p_actor,
         connection.id,
         connection.credential_id,
         connection.root_folder_id,
         connection.root_resource_key,
         connection.drive_id
  from public.team_drive_connections as connection
  where connection.team_id = p_team
    and connection.state = 'connected'
    and p_permission in ('view','download','upload','edit','delete','process','manage_metadata')
    and private.can(p_team, p_permission, p_actor)
  order by connection.connected_at desc nulls last
  limit 1;
end;
$function$;

create function public.service_space_storage_backend(p_team uuid, p_actor uuid) returns text
language sql stable security definer set search_path = '' as $$
  select team.storage_backend
  from public.teams team
  where team.id = p_team
    and (p_actor is null or exists (
      select 1 from public.team_members member
      where member.team_id = team.id and member.user_id = p_actor and member.status = 'active'));
$$;

-- Contract 3 of the team workspace (packages/shared/src/release.ts) is the first agent that
-- reads and writes R2. The declared version arrives from team-recovery as teamWorkspaceContract;
-- an agent that sends none is contract 2.
create function private.require_recovery_workspace_contract(p_hash bytea, p_input jsonb) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  claimed_team uuid;
  declared integer;
begin
  select delegation.team_id into claimed_team
  from private.team_recovery_credentials credential
  join private.team_recovery_delegations delegation on delegation.id = credential.delegation_id
  where credential.hash = p_hash;
  if claimed_team is null or not private.space_is_r2(claimed_team) then return; end if;
  declared := case when coalesce(p_input->>'teamWorkspaceContract', '') ~ '^[0-9]{1,4}$'
    then (p_input->>'teamWorkspaceContract')::integer else 2 end;
  if declared < 3 then
    raise exception 'AGENT_UPDATE_REQUIRED' using errcode = '42501';
  end if;
end;
$$;

do $patch$
declare d text;
begin
  select pg_get_functiondef('public.service_team_recovery(text,bytea,jsonb)'::regprocedure) into d;
  if strpos(d, 'space_storage_claim_contract') = 0 then
    if strpos(d, $find$begin
 if p_action='probe' and p_input ? 'localState' then$find$) = 0 then
      raise exception 'RECOVERY_CLAIM_CONTRACT_PATCH_MISSING';
    end if;
    d := replace(d, $find$begin
 if p_action='probe' and p_input ? 'localState' then$find$, $replace$begin
 -- space_storage_claim_contract (057): an R2 space is claimed only by an agent of contract 3.
 if p_action='claim' then perform private.require_recovery_workspace_contract(p_hash,p_input); end if;
 if p_action='probe' and p_input ? 'localState' then$replace$);
    execute d;
  end if;

  select pg_get_functiondef('private.claim_catalog_sync_jobs(text,integer,integer)'::regprocedure) into d;
  if strpos(d, 'space_storage_drive_only') = 0 then
    if strpos(d, $find$join public.team_drive_connections c on c.id = j.connection_id$find$) = 0 then
      raise exception 'CATALOG_SYNC_DRIVE_ONLY_PATCH_MISSING';
    end if;
    d := replace(d, $find$join public.team_drive_connections c on c.id = j.connection_id$find$,
      $replace$join public.team_drive_connections c on c.id = j.connection_id
      -- space_storage_drive_only (057): catalog-sync reads Drive spaces only.
      join public.teams sync_space on sync_space.id = c.team_id and sync_space.storage_backend = 'drive'$replace$);
    execute d;
  end if;
end $patch$;

revoke all on function private.require_drive_space(uuid, uuid) from public, anon, authenticated;
revoke all on function private.require_recovery_workspace_contract(bytea, jsonb) from public, anon, authenticated;
revoke all on function public.service_space_storage_backend(uuid, uuid) from public, anon, authenticated;
grant execute on function public.service_space_storage_backend(uuid, uuid) to service_role;
