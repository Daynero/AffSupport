-- 057 T120/T121: the pictures an R2 space still lacks are made in the background too
-- (research.md R5 «Добір … через наявний фоновий цикл агента»).
--
-- Until now a derivative job (`space_derivative_jobs` `pending_agent`: HEVC, a codec and frame rate
-- to fill in, a tile the browser could not make) was taken only while a member had the folder open:
-- the page claimed it and handed it to its own Soty. A folder nobody opened kept «прев'ю готується».
-- Now a member's Soty that holds the space's background delegation takes them on its own, between
-- its other background claims, when it has nothing else to do.
--
-- The hot recovery function is not touched. `service_team_recovery` is the one door of every
-- Drive space's background work; a new action there would put an R2 branch in front of all of it.
-- Instead this one service function reads the same credential the agent already holds for its
-- claims — a claim credential, current, of a live delegation of a member who may still process in
-- the space — and answers which member and space it speaks for. team-recovery then claims the job
-- as that member through space-storage's own claim (lease, ticket, journal), exactly as the page's
-- `/derivatives/claim` does. A Drive space's credential is refused (STORAGE_BACKEND_MISMATCH); an
-- agent below workspace contract 3 is told to update. The job is leased for ten minutes, one per
-- call, so a credential that asks too often only receives nothing.

create function public.service_space_recovery_derivative_actor(p_hash bytea, p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  credential private.team_recovery_credentials%rowtype;
  delegation private.team_recovery_delegations%rowtype;
  declared integer;
begin
  if p_hash is null or octet_length(p_hash) <> 32 or p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into credential from private.team_recovery_credentials where hash = p_hash;
  select * into delegation from private.team_recovery_delegations where id = credential.delegation_id;
  if credential.hash is null or credential.audience <> 'claim' or credential.expires_at <= clock_timestamp()
     or delegation.id is null or credential.version <> delegation.version
     or delegation.revoked_at is not null or delegation.expires_at <= clock_timestamp() then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if not private.space_is_r2(delegation.team_id) then
    raise exception 'STORAGE_BACKEND_MISMATCH' using errcode = '55000';
  end if;
  declared := case when coalesce(p_input ->> 'teamWorkspaceContract', '') ~ '^[0-9]{1,4}$'
    then (p_input ->> 'teamWorkspaceContract')::integer else 2 end;
  if declared < 3 then
    raise exception 'AGENT_UPDATE_REQUIRED' using errcode = '42501';
  end if;
  if not private.recovery_actor_allowed(delegation.team_id, delegation.actor_id) then
    if not private.team_workspace_allowed(delegation.team_id) then
      raise exception 'SPACE_BLOCKED' using errcode = '42501';
    end if;
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'actorId', delegation.actor_id,
    'teamId', delegation.team_id,
    'installationId', delegation.installation_id,
    'storageBackend', 'r2');
end;
$$;
revoke all on function public.service_space_recovery_derivative_actor(bytea, jsonb) from public, anon, authenticated;
grant execute on function public.service_space_recovery_derivative_actor(bytea, jsonb) to service_role;
