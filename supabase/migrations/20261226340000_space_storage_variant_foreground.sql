-- 057 T118/T119: the variations of an R2 space run on the member's open Soty in the foreground, as
-- on Drive, with background work as the continuation (research.md R15 «Передній план»).
--
-- On Drive a re-stitched Launch is accepted with the member's open agent as its foreground
-- executor or with their background executor; without either it is refused AGENT_REQUIRED. An R2
-- Launch (20261226320000) named no executor and required the member's background delegation, so a
-- member with Soty open but no background work could not start one at all (2026-11-27: a catalog
-- stuck on AGENT_REQUIRED for exactly that). Now:
--
-- * service_accept_launch_catalog_video_generation (patched, R2 branch only) — a Launch whose page
--   hands its variations to the member's open agent itself (`spaceForeground` in the admission,
--   the way the catalog dialog always has: space-storage `/catalog-variants/run`, workspace
--   contract 3) needs no background delegation; without the page, the delegation is required as
--   before. Two machines never make one variation: the page is handed only a variation no
--   background lease holds (`background` otherwise), the background claim takes only a variation
--   with no open run, and an agent already running a run refuses it again (20261226260000).
-- * private.space_catalog_variant_wait_reason — `AGENT_REQUIRED` for a set of variations that
--   nothing is making: some wait, none is running or leased, the member has no background work,
--   and nothing has moved for two minutes (a page hands the next variation over within seconds).
--   The Launch's progress (private.launch_space_video_generation_json) and the dialog's read
--   (service_read_space_catalog_variants) carry it, so the page says what to do instead of an
--   endless «preparing»; the Launch's progress also names every set (`spaceSets`), which the
--   page hands over.
--
-- Drive: the patch replaces only the R2 branch's delegation check; every Drive line of the
-- acceptance is the text it was. The other two functions are R2 ones.

do $patch$
declare
  d text;
  needle constant text := $n$  if private.recovery_executor_for(p_team,p_actor) is null then raise exception 'AGENT_REQUIRED' using errcode='42501';end if;$n$;
begin
  select pg_get_functiondef('public.service_accept_launch_catalog_video_generation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure) into d;
  if strpos(d, 'spaceForeground') > 0 then return; end if;
  if strpos(d, needle) = 0 or strpos(substr(d, strpos(d, needle) + length(needle)), needle) > 0 then
    raise exception 'SPACE_FOREGROUND_ACCEPT_PATCH_MISSING';
  end if;
  execute replace(d, needle,
    $r$  -- T119: the page hands the variations to the member's open Soty; else background work makes them.
  if private.recovery_executor_for(p_team,p_actor) is null and p_video->'spaceForeground' is distinct from 'true'::jsonb then raise exception 'AGENT_REQUIRED' using errcode='42501';end if;$r$);
end $patch$;

create function private.space_catalog_variant_wait_reason(p_set uuid) returns text
language sql stable security definer set search_path = '' as $$
  select 'AGENT_REQUIRED'
  from private.space_catalog_variant_sets s
  where s.id = p_set and s.state = 'preparing'
    and exists (select 1 from private.space_catalog_variants v
                where v.set_id = s.id and private.space_catalog_variant_state(v) = 'pending')
    and not exists (select 1 from private.space_catalog_variants v
                    where v.set_id = s.id
                      and (private.space_catalog_variant_state(v) = 'working' or private.space_catalog_variant_leased(v)))
    and private.recovery_executor_for(s.team_id, s.actor_id) is null
    and greatest(s.created_at,
          coalesce((select max(greatest(v.updated_at, coalesce(o.updated_at, v.updated_at)))
                    from private.space_catalog_variants v
                    left join public.team_operations o on o.id = v.operation_id
                    where v.set_id = s.id), s.created_at))
        < clock_timestamp() - interval '2 minutes';
$$;
revoke all on function private.space_catalog_variant_wait_reason(uuid) from public, anon, authenticated, service_role;

-- The Launch's video progress, in the shape of the Drive one (launch_video_generation_json), with
-- the first waiting set's reason (T119).
create or replace function private.launch_space_video_generation_json(p_team uuid, p_generation uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when count(*) = 0 then null else jsonb_strip_nulls(jsonb_build_object(
    'setId', (array_agg(x.set_id order by x.ordinal))[1],
    'requestedCount', sum((x.progress ->> 'requestedCount')::integer),
    'registeredCount', sum((x.progress ->> 'registeredCount')::integer),
    'state', private.catalog_video_sets_state(array_agg(x.progress ->> 'state')),
    'activeChildOperationId', (select v.operation_id from private.launch_space_video_sets(p_team, p_generation) y
        join private.space_catalog_variants v on v.set_id = y.set_id
        join public.team_operations o on o.id = v.operation_id and o.team_id = p_team
       where o.state in ('pending', 'running') order by y.ordinal, v.ordinal limit 1),
    'segments', case when count(*) > 1 then jsonb_agg(jsonb_build_object('ordinal', x.ordinal, 'setId', x.set_id,
        'state', x.progress ->> 'state', 'requestedCount', (x.progress ->> 'requestedCount')::integer,
        'registeredCount', (x.progress ->> 'registeredCount')::integer) order by x.ordinal) end,
    'failedOrdinal', case when count(*) > 1 then min(x.ordinal) filter (where x.progress ->> 'state' = 'unknown') end,
    'waitReason', (array_agg(private.space_catalog_variant_wait_reason(x.set_id) order by x.ordinal)
                     filter (where private.space_catalog_variant_wait_reason(x.set_id) is not null))[1],
    -- T119: every set, for the page that hands them to the member's open Soty.
    'spaceSets', jsonb_agg(jsonb_build_object('setId', x.set_id,
        'requestedCount', (x.progress ->> 'requestedCount')::integer,
        'registeredCount', (x.progress ->> 'registeredCount')::integer) order by x.ordinal)
  )) end
  from private.launch_space_video_sets(p_team, p_generation) x;
$$;
revoke all on function private.launch_space_video_generation_json(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.service_read_space_catalog_variants(p_team uuid, p_actor uuid, p_key text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  i private.catalog_generation_intents%rowtype;
  s private.space_catalog_variant_sets%rowtype;
  v_progress jsonb;
  v_failed boolean;
  v_retry integer;
  v_reason text;
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
  -- T119: nothing is making them (no open Soty handed one over, no background work).
  v_reason := private.space_catalog_variant_wait_reason(s.id);
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
         when v_reason is not null and not v_failed and i.state <> 'canceled'
         then jsonb_build_object('waitReason', v_reason)
         else '{}'::jsonb end;
end;
$$;
revoke all on function public.service_read_space_catalog_variants(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.service_read_space_catalog_variants(uuid, uuid, text) to service_role;
