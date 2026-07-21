-- Restore analytics v2 ingestion for released clients.
--
-- The original RPC returned a column named event_id and also used
-- ON CONFLICT (event_id). In PL/pgSQL that identifier is ambiguous between the
-- OUT parameter and analytics_events.event_id, so every item was caught and
-- returned as rejected. Released v2 clients also duplicated flow_id/run_id in
-- properties even though those identifiers belong in dedicated columns.
-- Analytics v2 also made event_id/occurred_at required without defaults, which
-- broke the legacy column-scoped INSERT intentionally kept for older clients.

alter table public.analytics_events
  alter column event_id set default gen_random_uuid(),
  alter column occurred_at set default now();

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

      -- Compatibility for Wishly 0.6.1: routing identifiers were present both
      -- in the event envelope and in properties. Keep only the typed columns.
      v_properties := v_properties - 'flow_id' - 'run_id';

      if v_event_name is null or v_event_name !~ '^[a-z][a-z0-9_]{1,63}$' then
        raise exception 'Invalid event name';
      end if;
      if not public.analytics_properties_are_safe_v2(v_properties) then
        raise exception 'Unsafe event properties';
      end if;

      insert into public.analytics_events (
        event_id, event_name, event_version, occurred_at, session_sequence,
        user_id, session_id, installation_id, flow_id, run_id, tool, properties,
        app_version, agent_version, web_build_id, local_app_version, local_app_build,
        release_channel, core_api_version, tool_contracts, locale, platform, architecture,
        event_source, feature, screen, action, outcome, error_code, error_stage,
        error_fingerprint
      ) values (
        v_event_id, v_event_name, coalesce((item ->> 'event_version')::integer, 1),
        coalesce((item ->> 'occurred_at')::timestamptz, now()),
        (item ->> 'session_sequence')::integer,
        auth.uid(), (item ->> 'session_id')::uuid, (item ->> 'installation_id')::uuid,
        v_flow_id, v_run_id, nullif(item ->> 'tool', ''), v_properties,
        left(item ->> 'web_build_id', 64), left(item ->> 'local_app_version', 64),
        left(item ->> 'web_build_id', 96), left(item ->> 'local_app_version', 64),
        left(item ->> 'local_app_build', 96), left(item ->> 'release_channel', 32),
        (item ->> 'core_api_version')::integer, coalesce(item -> 'tool_contracts', '{}'::jsonb),
        nullif(item ->> 'locale', ''), nullif(item ->> 'platform', ''),
        nullif(item ->> 'architecture', ''), coalesce(item ->> 'event_source', 'web'),
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
  'Idempotent per-event analytics ingestion with 0.6.1 routing-property compatibility.';
