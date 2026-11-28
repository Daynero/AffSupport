-- 057 T106/T107: the variations of a catalog in an R2 space are finished in the background
-- (FR-011, research.md R15 «Фонове доведення»).
--
-- On Drive, what a catalog still owes goes on without the page: the member's agent holds a
-- recovery delegation (team_recovery_*), claims the next job through team-recovery and runs it;
-- the cron lane finishes the creation. An R2 space had only the page that created the catalog:
-- close it mid-way and the remaining variations waited until it was opened again. Now:
--
-- * a variation can be leased to the member's own delegated agent (`job_id`, `lease_hash`,
--   `lease_expires_at` on private.space_catalog_variants): service_claim_space_catalog_variant
--   picks the next variation nothing is working on, of a set of this member in this space, whose
--   source is still the frozen one, and leases it; space-storage opens the run exactly as
--   `/catalog-variants/run` does (same key, same folder, same three attempts) and binds it with
--   service_bind_space_catalog_variant_job. Heartbeats keep the lease and say when to stop
--   (canceled set, closed run); complete releases it; a lease whose pictures cannot be drawn now
--   is held for an hour without a run (service_defer_space_catalog_variant_job). A lease that lapsed leaves its run open
--   only until the next claim of that member, which fails it (as the Drive updater abandons the
--   open operations of a lapsed job) so the variation gets its next attempt.
-- * a page that hands a variation over while a live lease holds it is told `background`: the
--   agent is on it, the page waits (two computers never make the same variation at once).
-- * service_team_recovery tells team-recovery that a credential's space is R2 (`storageBackend`)
--   on claim/authorize, and that a run's output is recorded once the variation registered it
--   (`outputRecorded`; on Drive that is a catalog re-stitch copy). A Drive space's receipts are
--   exactly as before: the key is only ever added for an R2 space.
-- * service_list_space_catalog_completions — the creations of an R2 space whose variations are
--   all made but whose catalog is not registered yet, for the drive-ops cron lane that finishes
--   them (paced by the same service_defer_initial_catalog_recovery). The Drive listing
--   (service_list_initial_catalog_recovery) never lists them: it asks for a Drive set.

-- 1. The lease ----------------------------------------------------------------------------------

alter table private.space_catalog_variants
  add column job_id uuid,
  add column lease_hash bytea check (lease_hash is null or octet_length(lease_hash) = 32),
  add column lease_expires_at timestamptz,
  add constraint space_catalog_variants_lease_whole check (
    (job_id is null and lease_hash is null and lease_expires_at is null)
    or (job_id is not null and lease_hash is not null and lease_expires_at is not null));
create unique index space_catalog_variants_job on private.space_catalog_variants (job_id)
  where job_id is not null;

create function private.space_catalog_variant_leased(v private.space_catalog_variants) returns boolean
language sql stable security definer set search_path = '' as $$
  select v.job_id is not null and v.lease_expires_at > clock_timestamp();
$$;
revoke all on function private.space_catalog_variant_leased(private.space_catalog_variants) from public, anon, authenticated;

-- 2. A page hands over only what no agent holds ------------------------------------------------

create or replace function public.service_space_catalog_variant_run(
  p_team uuid, p_actor uuid, p_set uuid, p_index integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s private.space_catalog_variant_sets%rowtype;
  v private.space_catalog_variants%rowtype;
  v_state text;
  v_source record;
begin
  perform private.require_space_actor(p_team, p_actor, 'process');
  select * into s from private.space_catalog_variant_sets where id = p_set and team_id = p_team;
  -- Only the member who asked for the catalog hands its variations to an agent (their own).
  if s.id is null or s.actor_id <> p_actor then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  select * into v from private.space_catalog_variants where set_id = p_set and ordinal = p_index for update;
  if v.set_id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if s.state = 'canceled' then return jsonb_build_object('state', 'canceled', 'index', p_index); end if;
  v_state := private.space_catalog_variant_state(v);
  if v_state = 'registered' then
    return jsonb_build_object('state', 'registered', 'index', p_index, 'outputMaterialId', v.output_material_id);
  end if;
  if v_state = 'failed' then return jsonb_build_object('state', 'failed', 'index', p_index); end if;
  -- T107: the member's delegated agent holds it; the page waits instead of handing it over too.
  if private.space_catalog_variant_leased(v) then
    return jsonb_build_object('state', 'background', 'index', p_index);
  end if;
  select material.id, material.name into v_source
  from public.team_materials material
  join public.space_objects object on object.id = material.space_object_id and object.team_id = material.team_id
  where material.id = s.source_material_id and material.team_id = p_team and material.lifecycle = 'active'
    and object.content_id = s.source_content_id and object.state = 'committed';
  if v_source.id is null then raise exception 'SOURCE_CHANGED' using errcode = '55000'; end if;
  return jsonb_build_object(
    'state', case when v_state = 'working' then 'running' else 'open' end,
    'index', p_index,
    'requestId', v.request_id,
    'attempt', case when v_state = 'working' then v.attempt else v.attempt + 1 end,
    'operationId', case when v_state = 'working' then v.operation_id else null end,
    'destinationFolderId', case when v_state = 'working'
      then (select o.destination_folder_id from public.team_operations o where o.id = v.operation_id) else null end,
    'sourceMaterialId', v_source.id,
    'sourceName', v_source.name,
    'variantCount', s.variant_count,
    'settings', s.settings,
    'settingsDigest', s.settings_digest);
end;
$$;

-- 3. The agent's claim, bind, heartbeat and release --------------------------------------------

create function public.service_claim_space_catalog_variant(
  p_team uuid, p_actor uuid, p_lease_hash bytea, p_lease_seconds integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_lapsed record;
  v_pick record;
  v private.space_catalog_variants%rowtype;
  s private.space_catalog_variant_sets%rowtype;
  v_job uuid := gen_random_uuid();
begin
  if p_team is null or p_actor is null or p_lease_hash is null or octet_length(p_lease_hash) <> 32
     or p_lease_seconds is null or p_lease_seconds not between 30 and 600 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform private.require_space_actor(p_team, p_actor, 'process');
  perform private.require_space_actor(p_team, p_actor, 'upload');

  -- A lease that lapsed leaves its run behind: fail it, so the variation gets its next attempt.
  for v_lapsed in
    select v2.set_id, v2.ordinal, v2.operation_id
    from private.space_catalog_variants v2
    join private.space_catalog_variant_sets s2 on s2.id = v2.set_id
    where s2.team_id = p_team and s2.actor_id = p_actor
      and v2.job_id is not null and v2.lease_expires_at <= clock_timestamp()
    for update of v2 skip locked
  loop
    if exists (select 1 from public.team_operations o
               where o.id = v_lapsed.operation_id and o.state in ('pending', 'running')) then
      perform public.service_transition_team_operation(
        v_lapsed.operation_id, 'failed', 'failed', 100, null, 'PROCESS_FAILED', true);
    end if;
    update private.space_catalog_variants
       set job_id = null, lease_hash = null, lease_expires_at = null, updated_at = clock_timestamp()
     where set_id = v_lapsed.set_id and ordinal = v_lapsed.ordinal;
  end loop;

  -- The oldest creation first, its variations in order; only what nothing is working on.
  select v2.set_id, v2.ordinal into v_pick
  from private.space_catalog_variants v2
  join private.space_catalog_variant_sets s2 on s2.id = v2.set_id
  join private.catalog_generation_intents i on i.id = s2.catalog_intent_id
  join public.team_materials material on material.id = s2.source_material_id and material.team_id = s2.team_id
  join public.space_objects object on object.id = material.space_object_id and object.team_id = material.team_id
  where s2.team_id = p_team and s2.actor_id = p_actor and s2.state = 'preparing'
    and i.state not in ('canceled', 'registered')
    and material.lifecycle = 'active' and object.state = 'committed'
    and object.content_id = s2.source_content_id
    and v2.job_id is null
    and private.space_catalog_variant_state(v2) = 'pending'
  order by s2.created_at, s2.id, v2.ordinal
  limit 1
  for update of v2 skip locked;
  if v_pick.set_id is null then return null; end if;

  select * into s from private.space_catalog_variant_sets where id = v_pick.set_id;
  update private.space_catalog_variants
     set job_id = v_job, lease_hash = p_lease_hash,
         lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         updated_at = clock_timestamp()
   where set_id = v_pick.set_id and ordinal = v_pick.ordinal
  returning * into v;
  return jsonb_build_object(
    'jobId', v_job,
    'setId', s.id,
    'index', v.ordinal,
    'requestId', v.request_id,
    'attempt', v.attempt + 1,
    'sourceMaterialId', s.source_material_id,
    'sourceName', (select m.name from public.team_materials m where m.id = s.source_material_id),
    'variantCount', s.variant_count,
    'settings', s.settings,
    'settingsDigest', s.settings_digest);
end;
$$;

-- The variation a live lease names, locked; null when the lease is not (or no longer) this one.
create function private.space_catalog_variant_job(p_actor uuid, p_job uuid, p_lease_hash bytea)
returns private.space_catalog_variants
language plpgsql security definer set search_path = '' as $$
declare
  v private.space_catalog_variants%rowtype;
begin
  select v2.* into v
  from private.space_catalog_variants v2
  join private.space_catalog_variant_sets s2 on s2.id = v2.set_id
  where v2.job_id = p_job and v2.lease_hash = p_lease_hash and s2.actor_id = p_actor
  for update of v2;
  return v;
end;
$$;
revoke all on function private.space_catalog_variant_job(uuid, uuid, bytea) from public, anon, authenticated;

create function public.service_bind_space_catalog_variant_job(
  p_team uuid, p_actor uuid, p_job uuid, p_lease_hash bytea, p_attempt integer, p_operation uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v private.space_catalog_variants%rowtype;
begin
  v := private.space_catalog_variant_job(p_actor, p_job, p_lease_hash);
  if v.set_id is null or v.team_id <> p_team or v.lease_expires_at <= clock_timestamp() then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;
  return public.service_bind_space_catalog_variant_run(p_team, p_actor, v.set_id, v.ordinal, p_attempt, p_operation);
end;
$$;

-- Keeps the lease; `cancel` when the work is no longer wanted (the creation was canceled, the run
-- closed elsewhere) or the lease is not this agent's any more.
create function public.service_heartbeat_space_catalog_variant_job(
  p_actor uuid, p_job uuid, p_lease_hash bytea, p_lease_seconds integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v private.space_catalog_variants%rowtype;
  s private.space_catalog_variant_sets%rowtype;
begin
  if p_lease_seconds is null or p_lease_seconds not between 30 and 600 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  v := private.space_catalog_variant_job(p_actor, p_job, p_lease_hash);
  if v.set_id is null then return jsonb_build_object('cancel', true); end if;
  select * into s from private.space_catalog_variant_sets where id = v.set_id;
  if s.state = 'canceled'
     or exists (select 1 from private.catalog_generation_intents i where i.id = s.catalog_intent_id and i.state = 'canceled')
     or exists (select 1 from public.team_operations o where o.id = v.operation_id and o.state in ('failed', 'canceled')) then
    return jsonb_build_object('cancel', true);
  end if;
  update private.space_catalog_variants
     set lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds), updated_at = clock_timestamp()
   where set_id = v.set_id and ordinal = v.ordinal;
  return jsonb_build_object('cancel', false);
end;
$$;

create function public.service_complete_space_catalog_variant_job(
  p_actor uuid, p_job uuid, p_lease_hash bytea)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v private.space_catalog_variants%rowtype;
begin
  v := private.space_catalog_variant_job(p_actor, p_job, p_lease_hash);
  if v.set_id is null then return jsonb_build_object('recorded', false); end if;
  update private.space_catalog_variants
     set job_id = null, lease_hash = null, lease_expires_at = null, updated_at = clock_timestamp()
   where set_id = v.set_id and ordinal = v.ordinal;
  return jsonb_build_object('recorded', true);
end;
$$;

-- Holds a lease that opened no run (the space's pictures cannot be drawn or granted now) for up
-- to an hour, as the Drive updater defers a job whose pool is empty: neither the agent nor a page
-- spins on it every claim. The lease then lapses and the next claim takes it again.
create function public.service_defer_space_catalog_variant_job(
  p_actor uuid, p_job uuid, p_lease_hash bytea, p_seconds integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v private.space_catalog_variants%rowtype;
begin
  if p_seconds is null or p_seconds not between 30 and 3600 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  v := private.space_catalog_variant_job(p_actor, p_job, p_lease_hash);
  if v.set_id is null or private.space_catalog_variant_state(v) <> 'pending' then
    return jsonb_build_object('deferred', false);
  end if;
  update private.space_catalog_variants
     set lease_expires_at = clock_timestamp() + make_interval(secs => p_seconds), updated_at = clock_timestamp()
   where set_id = v.set_id and ordinal = v.ordinal;
  return jsonb_build_object('deferred', true);
end;
$$;

-- 4. team-recovery learns the backend of an R2 credential --------------------------------------

create function private.space_recovery_receipt(p_action text, p_receipt jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_team uuid;
begin
  if p_action not in ('claim', 'authorize_claim', 'authorize_execute') or p_receipt is null
     or jsonb_typeof(p_receipt) <> 'object' or not (p_receipt ? 'teamId') then
    return p_receipt;
  end if;
  v_team := (p_receipt ->> 'teamId')::uuid;
  if not private.space_is_r2(v_team) then return p_receipt; end if;
  return p_receipt || jsonb_build_object(
    'storageBackend', 'r2',
    'outputRecorded', coalesce((p_receipt ->> 'outputRecorded')::boolean, false) or exists (
      select 1 from private.space_catalog_variants v
      where v.team_id = v_team and v.operation_id = (p_receipt ->> 'operationId')::uuid
        and v.output_material_id is not null));
end;
$$;
revoke all on function private.space_recovery_receipt(text, jsonb) from public, anon, authenticated;

do $patch$
declare d text;
begin
  select pg_get_functiondef('public.service_team_recovery(text,bytea,jsonb)'::regprocedure) into d;
  if strpos(d, 'space_storage_recovery_backend') = 0 then
    if strpos(d, $find$ if p_action not in ('delegate','redeem') then
  return private.service_team_recovery_before_automatic(p_action,p_hash,p_input);
 end if;$find$) = 0 then
      raise exception 'RECOVERY_BACKEND_PATCH_MISSING';
    end if;
    d := replace(d, $find$ if p_action not in ('delegate','redeem') then
  return private.service_team_recovery_before_automatic(p_action,p_hash,p_input);
 end if;$find$, $replace$ if p_action not in ('delegate','redeem') then
  -- space_storage_recovery_backend (057 T107): an R2 credential says so; a Drive one is unchanged.
  return private.space_recovery_receipt(p_action,private.service_team_recovery_before_automatic(p_action,p_hash,p_input));
 end if;$replace$);
    execute d;
  end if;
end $patch$;

-- 5. The creations the cron lane finishes ----------------------------------------------------

create function public.service_list_space_catalog_completions(p_limit integer default 3)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 3 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('teamId', x.team_id, 'actorId', x.actor_id, 'idempotencyKey', x.request_key)
             order by x.next_attempt_at, x.id)
    from (
      select i.id, i.team_id, i.actor_id, i.request_key, coalesce(i.next_attempt_at, '-infinity') as next_attempt_at
      from private.space_catalog_variant_sets s
      join private.catalog_generation_intents i on i.id = s.catalog_intent_id
      where s.state = 'preparing'
        and i.team_id = s.team_id and i.actor_id = s.actor_id
        and i.request_key ~ '^product-catalog:[0-9a-f-]{36}$'
        and i.request_payload ->> 'catalogVideoProtocolVersion' = '1'
        and i.state in ('interrupted', 'create_started', 'created', 'finalized')
        and coalesce(i.next_attempt_at, '-infinity') <= statement_timestamp()
        and (i.lease_expires_at is null or i.lease_expires_at <= statement_timestamp())
        and private.space_is_r2(i.team_id)
        and private.can(i.team_id, 'view', i.actor_id)
        and private.can(i.team_id, 'upload', i.actor_id)
        and private.can(i.team_id, 'process', i.actor_id)
        and private.space_catalog_variant_progress(s.id) ->> 'state' = 'ready'
      order by coalesce(i.next_attempt_at, '-infinity'), i.id
      limit p_limit
    ) x
  ), '[]'::jsonb);
end;
$$;

-- Grants -----------------------------------------------------------------------------------------

revoke all on function public.service_claim_space_catalog_variant(uuid, uuid, bytea, integer) from public, anon, authenticated;
revoke all on function public.service_bind_space_catalog_variant_job(uuid, uuid, uuid, bytea, integer, uuid) from public, anon, authenticated;
revoke all on function public.service_heartbeat_space_catalog_variant_job(uuid, uuid, bytea, integer) from public, anon, authenticated;
revoke all on function public.service_complete_space_catalog_variant_job(uuid, uuid, bytea) from public, anon, authenticated;
revoke all on function public.service_defer_space_catalog_variant_job(uuid, uuid, bytea, integer) from public, anon, authenticated;
revoke all on function public.service_list_space_catalog_completions(integer) from public, anon, authenticated;
grant execute on function public.service_claim_space_catalog_variant(uuid, uuid, bytea, integer) to service_role;
grant execute on function public.service_bind_space_catalog_variant_job(uuid, uuid, uuid, bytea, integer, uuid) to service_role;
grant execute on function public.service_heartbeat_space_catalog_variant_job(uuid, uuid, bytea, integer) to service_role;
grant execute on function public.service_complete_space_catalog_variant_job(uuid, uuid, bytea) to service_role;
grant execute on function public.service_defer_space_catalog_variant_job(uuid, uuid, bytea, integer) to service_role;
grant execute on function public.service_list_space_catalog_completions(integer) to service_role;
