-- 057 T112/T113: a variation run of an R2 space whose agent went silent is closed, so the
-- variation gets its next attempt (FR-011, research.md R15 «Завислий запуск»).
--
-- A variation is an ordinary tool run of the space (20261226250000). A run handed over by the
-- page outlives it, which is right while the agent works, but nothing closed it when the agent
-- died: the variation stayed `working` for good, the background claim (20261226260000) skips a
-- variation that is working, and a page left closed never handed it over again. Only a lapsed
-- background lease was closed, and only by the next claim of the same member.
--
-- The agent of contract 3 does not heartbeat a space run, so silence is read from what the run
-- leaves on the server: its own transitions (opened, uploading), every hand-out (each issues
-- fresh tickets) and its output upload. Rendering a long re-stitched video and uploading it are
-- silent on that scale, so the window is generous; the tickets themselves live six hours, so a
-- run silent that long could not have finished anyway.
--
-- * private.space_catalog_variant_run_life — the last sign of life of a variation's run.
-- * private.sweep_space_catalog_variant_runs — fails, as AGENT_STALLED and retryable, at most
--   p_limit open runs of R2 variations: a run no live lease holds and silent for p_silence (two
--   hours), or one whose lease lapsed p_lapsed (ten minutes) ago with no sign of life since.
--   Failing it releases its name reservation and revokes its tickets
--   (service_transition_team_operation); its open output upload expires and gives back the
--   space it reserved, as an upload found past its time does (service_space_upload_session); a
--   lapsed lease is cleared. The variation is then `pending` for its next attempt (the agent's
--   next claim or the page takes it), or `failed` after its third.
-- * pg_cron `soty-space-catalog-variant-stalled-runs`, every five minutes.
-- * service_read_space_catalog_variants (replaced) — the dialog learns that a variation is
--   waiting for its next attempt because Soty stopped answering (`waitReason` AGENT_STALLED and
--   `retry` {attempt, of}), and that a variation used its three attempts (`variantsFailed`).
--
-- Drive is untouched: these rows exist only for R2 spaces (every writer of them goes through
-- private.require_space_actor), and the Drive set machinery has its own liveness
-- (20261207240000).

-- 1. Last sign of life -----------------------------------------------------------------------

create function private.space_catalog_variant_run_life(p_operation uuid) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select greatest(
    o.created_at,
    o.updated_at,
    coalesce((select max(g.created_at) from private.team_transfer_grants g where g.operation_id = o.id), o.created_at),
    coalesce((select max(u.updated_at) from public.space_uploads u
               where u.team_id = o.team_id and u.actor_id = o.actor_id and u.ingress = 'agent_output'
                 and u.idempotency_key = 'process_output_' || o.id::text), o.created_at))
  from public.team_operations o where o.id = p_operation;
$$;
revoke all on function private.space_catalog_variant_run_life(uuid) from public, anon, authenticated, service_role;

-- 2. The sweep --------------------------------------------------------------------------------

create function private.sweep_space_catalog_variant_runs(
  p_silence interval default interval '2 hours',
  p_lapsed interval default interval '10 minutes',
  p_limit integer default 50)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  u public.space_uploads%rowtype;
  v_swept integer := 0;
begin
  if p_silence is null or p_lapsed is null or p_limit is null or p_limit not between 1 and 200
     or p_silence < interval '0' or p_lapsed < interval '0' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  for r in
    select v.set_id, v.ordinal, v.operation_id, v.job_id, o.team_id, o.actor_id, o.progress
    from private.space_catalog_variants v
    join public.team_operations o on o.id = v.operation_id and o.team_id = v.team_id
    where o.state in ('pending', 'running')
      and private.space_is_r2(v.team_id)
      and case
        -- A live lease is the agent's word that it is on it.
        when v.job_id is not null and v.lease_expires_at > clock_timestamp() then false
        when v.job_id is not null then
          v.lease_expires_at <= clock_timestamp() - p_lapsed
          and private.space_catalog_variant_run_life(v.operation_id) <= clock_timestamp() - p_lapsed
        else private.space_catalog_variant_run_life(v.operation_id) <= clock_timestamp() - p_silence
      end
    order by o.updated_at, o.id
    limit p_limit
    for update of v, o skip locked
  loop
    perform public.service_transition_team_operation(
      r.operation_id, 'failed', 'failed', r.progress, null, 'AGENT_STALLED', true);
    for u in
      select * from public.space_uploads
       where team_id = r.team_id and actor_id = r.actor_id and ingress = 'agent_output'
         and idempotency_key = 'process_output_' || r.operation_id::text and state = 'open'
       for update
    loop
      update public.space_uploads set state = 'expired', updated_at = now() where id = u.id;
      update public.space_storage_reservations
         set state = case when u.r2_upload_id is null then 'released' else 'uncertain' end,
             settled_at = case when u.r2_upload_id is null then now() else null end
       where id = u.reservation_id and state = 'reserved';
    end loop;
    update private.space_catalog_variants
       set job_id = null, lease_hash = null, lease_expires_at = null, updated_at = clock_timestamp()
     where set_id = r.set_id and ordinal = r.ordinal;
    v_swept := v_swept + 1;
  end loop;
  return v_swept;
end;
$$;
revoke all on function private.sweep_space_catalog_variant_runs(interval, interval, integer) from public, anon, authenticated, service_role;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('soty-space-catalog-variant-stalled-runs', '*/5 * * * *',
      $cron$select private.sweep_space_catalog_variant_runs()$cron$);
  end if;
end $$;

-- 3. What the dialog reads --------------------------------------------------------------------

create or replace function public.service_read_space_catalog_variants(p_team uuid, p_actor uuid, p_key text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  i private.catalog_generation_intents%rowtype;
  s private.space_catalog_variant_sets%rowtype;
  v_progress jsonb;
  v_failed boolean;
  v_retry integer;
begin
  perform private.require_space_actor(p_team, p_actor, 'view');
  select * into i from private.catalog_generation_intents
   where team_id = p_team and actor_id = p_actor and request_key = p_key;
  if i.id is null then return null; end if;
  if i.state = 'registered' then return i.result; end if;
  select * into s from private.space_catalog_variant_sets where catalog_intent_id = i.id;
  if s.id is null then return null; end if;
  v_progress := private.space_catalog_variant_progress(s.id);
  v_failed := exists (select 1 from jsonb_array_elements(v_progress -> 'variants') e where e ->> 'state' = 'failed');
  -- The first variation waiting for its next attempt because its last run went silent.
  select v.attempt + 1 into v_retry
  from private.space_catalog_variants v
  join public.team_operations o on o.id = v.operation_id
  where v.set_id = s.id and o.state = 'failed' and o.error_code = 'AGENT_STALLED' and v.attempt < 3
    and private.space_catalog_variant_state(v) = 'pending'
  order by v.ordinal limit 1;
  return jsonb_build_object(
    'outcome', 'preparing_video',
    'catalogIntentId', i.id,
    'videoSetId', s.id,
    'requestedCount', s.variant_count,
    'registeredCount', (v_progress ->> 'registeredCount')::integer,
    -- A complete set is still «preparing» until the catalog is registered: the dialog resumes it.
    'state', case
      when i.state = 'canceled' or s.state = 'canceled' then 'canceled'
      when v_progress ->> 'state' = 'unknown' then 'unknown'
      else 'preparing' end)
    || case when v_failed and i.state <> 'canceled' and s.state <> 'canceled'
         then jsonb_build_object('variantsFailed', true) else '{}'::jsonb end
    || case when v_retry is not null and not v_failed and i.state <> 'canceled' and s.state <> 'canceled'
         then jsonb_build_object('waitReason', 'AGENT_STALLED', 'retry', jsonb_build_object('attempt', v_retry, 'of', 3))
         else '{}'::jsonb end;
end;
$$;
revoke all on function public.service_read_space_catalog_variants(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.service_read_space_catalog_variants(uuid, uuid, text) to service_role;
