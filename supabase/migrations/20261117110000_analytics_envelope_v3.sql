-- 031 — envelope v3: the Agent's identity and the attempt reach their own columns (FR-053, FR-006).
--
-- Three nullable columns on public.analytics_events:
--   agent_instance_id  uuid   the connected Agent's per-boot UUID (never PII), so an
--                             event joins the exact Agent run it happened under;
--   agent_platform     text   the Agent's authoritative platform; `platform` stays the
--                             browser's User-Agent guess, which calls Android "linux";
--   attempt_id         text   the opaque per-attempt id the team events have carried
--                             in properties, now a column like flow_id/run_id.
--
-- public.ingest_analytics_events is redefined to fill them. `attempt_id` is
-- taken from the envelope, or from properties for a client that still sends it
-- there, and removed from properties either way — the same compatibility path
-- flow_id/run_id took in 20260721113000. A malformed attempt_id refuses the
-- event, as a malformed flow_id always has. The Agent fields are lenient: an
-- unknown platform word or a non-UUID instance id is stored as null rather than
-- refusing an event over a field the user cannot influence.
--
-- RLS, grants and every other column are unchanged. Rows ingested before this
-- file keep their attempt_id inside properties.

alter table public.analytics_events
  add column if not exists agent_instance_id uuid,
  add column if not exists agent_platform text,
  add column if not exists attempt_id text;

alter table public.analytics_events
  drop constraint if exists analytics_agent_platform_v3_check,
  drop constraint if exists analytics_attempt_id_v3_check;

alter table public.analytics_events
  add constraint analytics_agent_platform_v3_check
    check (agent_platform is null or agent_platform in ('macos', 'windows')),
  add constraint analytics_attempt_id_v3_check
    check (attempt_id is null or attempt_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$');

create index if not exists analytics_events_attempt_created_idx
  on public.analytics_events (attempt_id, occurred_at)
  where attempt_id is not null;

create or replace function public.ingest_analytics_events(p_events jsonb)
returns table (event_id uuid, accepted boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  item jsonb;
  v_event_id uuid;
  v_event_name text;
  v_properties jsonb;
  v_flow_id uuid;
  v_run_id uuid;
  v_attempt_id text;
  v_agent_instance_id uuid;
  v_agent_platform text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) > 100 then
    raise exception 'Expected at most 100 events' using errcode = '22023';
  end if;

  for item in select value from jsonb_array_elements(p_events)
  loop
    begin
      -- Do not leak a previous loop value into the rejection result when the
      -- current event_id cannot be parsed.
      v_event_id := null;
      v_event_id := (item ->> 'event_id')::uuid;
      v_event_name := item ->> 'event_name';
      v_properties := coalesce(item -> 'properties', '{}'::jsonb);
      v_flow_id := nullif(coalesce(item ->> 'flow_id', v_properties ->> 'flow_id'), '')::uuid;
      v_run_id := nullif(coalesce(item ->> 'run_id', v_properties ->> 'run_id'), '')::uuid;
      v_attempt_id := nullif(coalesce(item ->> 'attempt_id', v_properties ->> 'attempt_id'), '');

      -- Routing identifiers live in typed columns only: 0.6.1 clients repeated
      -- flow_id/run_id in properties, pre-031 clients carry attempt_id there.
      v_properties := v_properties - 'flow_id' - 'run_id' - 'attempt_id';

      if v_event_name is null or v_event_name !~ '^[a-z][a-z0-9_]{1,63}$' then
        raise exception 'Invalid event name';
      end if;
      if v_attempt_id is not null and v_attempt_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$' then
        raise exception 'Invalid attempt_id';
      end if;
      if not public.analytics_properties_are_safe_v2(v_properties) then
        raise exception 'Unsafe event properties';
      end if;

      -- The Agent fields are informational: a value this build does not
      -- recognise is dropped, not a reason to refuse the event.
      v_agent_instance_id := case
        when (item ->> 'agent_instance_id')
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then (item ->> 'agent_instance_id')::uuid
        else null end;
      v_agent_platform := case
        when item ->> 'agent_platform' in ('macos', 'windows') then item ->> 'agent_platform'
        else null end;

      insert into public.analytics_events (
        event_id, event_name, event_version, occurred_at, session_sequence,
        user_id, session_id, installation_id, flow_id, run_id, attempt_id, tool, properties,
        app_version, agent_version, web_build_id, local_app_version, local_app_build,
        release_channel, core_api_version, tool_contracts, locale, platform, architecture,
        agent_instance_id, agent_platform,
        event_source, feature, screen, action, outcome, error_code, error_stage,
        error_fingerprint
      ) values (
        v_event_id, v_event_name, coalesce((item ->> 'event_version')::integer, 1),
        coalesce((item ->> 'occurred_at')::timestamptz, now()),
        (item ->> 'session_sequence')::integer,
        auth.uid(), (item ->> 'session_id')::uuid, (item ->> 'installation_id')::uuid,
        v_flow_id, v_run_id, v_attempt_id, nullif(item ->> 'tool', ''), v_properties,
        left(item ->> 'web_build_id', 64), left(item ->> 'local_app_version', 64),
        left(item ->> 'web_build_id', 96), left(item ->> 'local_app_version', 64),
        left(item ->> 'local_app_build', 96), left(item ->> 'release_channel', 32),
        (item ->> 'core_api_version')::integer, coalesce(item -> 'tool_contracts', '{}'::jsonb),
        nullif(item ->> 'locale', ''), nullif(item ->> 'platform', ''),
        nullif(item ->> 'architecture', ''),
        v_agent_instance_id, v_agent_platform,
        coalesce(item ->> 'event_source', 'web'),
        nullif(item ->> 'feature', ''), nullif(item ->> 'screen', ''),
        nullif(item ->> 'action', ''), nullif(item ->> 'outcome', ''),
        nullif(item ->> 'error_code', ''), nullif(item ->> 'error_stage', ''),
        nullif(item ->> 'error_fingerprint', '')
      )
      -- Omitting a conflict target avoids the PL/pgSQL OUT-parameter ambiguity
      -- while retaining idempotent delivery by the unique event_id index.
      on conflict do nothing;

      event_id := v_event_id;
      accepted := true;
      reason := null;
      return next;
    exception when others then
      event_id := v_event_id;
      accepted := false;
      reason := left(sqlerrm, 160);
      return next;
    end;
  end loop;
end;
$$;

revoke all on function public.ingest_analytics_events(jsonb) from public, anon;
grant execute on function public.ingest_analytics_events(jsonb) to authenticated;

comment on function public.ingest_analytics_events(jsonb) is
  'Idempotent per-event analytics ingestion; envelope v3 stores attempt_id, agent_instance_id and agent_platform in columns.';
