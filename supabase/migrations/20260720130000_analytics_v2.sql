-- Rich, agent-readable analytics with idempotent, per-event ingestion.
-- Files, paths, content, free text, raw commands and raw logs remain forbidden.

alter table public.analytics_events
  drop constraint if exists analytics_event_name_check,
  drop constraint if exists analytics_properties_check,
  drop constraint if exists analytics_tool_check;

alter table public.analytics_events
  add column if not exists event_id uuid,
  add column if not exists event_version integer not null default 1,
  add column if not exists occurred_at timestamptz,
  add column if not exists session_sequence integer,
  add column if not exists installation_id uuid,
  add column if not exists flow_id uuid,
  add column if not exists run_id uuid,
  add column if not exists event_source text,
  add column if not exists web_build_id text,
  add column if not exists local_app_version text,
  add column if not exists local_app_build text,
  add column if not exists release_channel text,
  add column if not exists architecture text,
  add column if not exists core_api_version integer,
  add column if not exists tool_contracts jsonb not null default '{}'::jsonb,
  add column if not exists feature text,
  add column if not exists screen text,
  add column if not exists action text,
  add column if not exists outcome text,
  add column if not exists error_code text,
  add column if not exists error_stage text,
  add column if not exists error_fingerprint text;

update public.analytics_events
set event_id = gen_random_uuid(),
    occurred_at = created_at,
    event_source = 'web',
    web_build_id = app_version,
    local_app_version = agent_version
where event_id is null;

alter table public.analytics_events
  alter column event_id set not null,
  alter column occurred_at set not null;

create unique index if not exists analytics_events_event_id_idx
  on public.analytics_events (event_id);
create index if not exists analytics_events_installation_created_idx
  on public.analytics_events (installation_id, occurred_at desc)
  where installation_id is not null;
create index if not exists analytics_events_run_created_idx
  on public.analytics_events (run_id, occurred_at)
  where run_id is not null;
create index if not exists analytics_events_error_fingerprint_idx
  on public.analytics_events (error_fingerprint, occurred_at desc)
  where error_fingerprint is not null;
create index if not exists analytics_events_local_build_idx
  on public.analytics_events (local_app_build, occurred_at desc)
  where local_app_build is not null;

create or replace function public.analytics_properties_are_safe_v2(payload jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select
    jsonb_typeof(payload) = 'object'
    and octet_length(payload::text) <= 8192
    and not exists (
      select 1 from jsonb_object_keys(payload) as property_key
      where property_key <> all (array[
        'tool_identifier', 'feature_identifier', 'screen_identifier', 'action_identifier',
        'flow_step', 'outcome', 'source_kind', 'input_method', 'format', 'video_codec',
        'audio_codec', 'image_codec', 'pixel_format', 'setting_name', 'setting_value',
        'error_category', 'error_code', 'error_stage', 'error_fingerprint', 'retryable',
        'recovered', 'success', 'video_count', 'file_count', 'total_input_bytes',
        'total_output_bytes', 'saving_percent', 'processing_duration_ms', 'duration_ms',
        'queue_wait_ms', 'attempt_number', 'width', 'height', 'mode', 'crf',
        'rate_control', 'output_fps', 'target_resolution', 'image_embedding', 'has_audio',
        'language', 'marketing_consent'
      ])
    )
    and not exists (
      select 1 from jsonb_each_text(payload) as property
      where length(property.value) > 128
         or property.value ~ '[/\\]'
         or property.value ~* '(bearer|oauth|token=|authorization)'
    );
$$;

alter table public.analytics_events
  add constraint analytics_event_name_v2_check
    check (event_name ~ '^[a-z][a-z0-9_]{1,63}$'),
  add constraint analytics_properties_v2_check
    check (public.analytics_properties_are_safe_v2(properties)),
  add constraint analytics_tool_v2_check
    check (tool is null or tool ~ '^[a-z][a-z0-9-]{0,63}$'),
  add constraint analytics_context_v2_check check (
    event_version between 1 and 1000
    and (session_sequence is null or session_sequence between 0 and 10000000)
    and (event_source is null or event_source in ('web', 'local_app', 'server'))
    and (architecture is null or architecture in ('arm64', 'x64', 'unknown'))
    and jsonb_typeof(tool_contracts) = 'object'
    and octet_length(tool_contracts::text) <= 2048
  );

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
      v_event_id := (item ->> 'event_id')::uuid;
      v_event_name := item ->> 'event_name';
      v_properties := coalesce(item -> 'properties', '{}'::jsonb);
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
        nullif(item ->> 'flow_id', '')::uuid, nullif(item ->> 'run_id', '')::uuid,
        nullif(item ->> 'tool', ''), v_properties,
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
      on conflict (event_id) do nothing;

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

-- Keep the existing column-scoped INSERT grant during the compatibility window.
-- Released web builds before analytics v2 still use it; new builds use the
-- idempotent RPC below. A later migration may revoke the legacy grant after the
-- minimum supported web build has moved past the old sender.
revoke all on function public.ingest_analytics_events(jsonb) from public, anon;
grant execute on function public.ingest_analytics_events(jsonb) to authenticated;

create or replace function public.admin_agent_versions(
  p_start_date timestamptz,
  p_end_date timestamptz
)
returns table (agent_version text, total bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  return query
  with latest as (
    select distinct on (coalesce(events.user_id::text, events.installation_id::text))
      coalesce(events.local_app_version, events.agent_version, 'unknown') as version,
      coalesce(events.user_id::text, events.installation_id::text) as identity
    from public.analytics_events as events
    where events.occurred_at >= p_start_date and events.occurred_at < p_end_date
      and (events.user_id is not null or events.installation_id is not null)
    order by coalesce(events.user_id::text, events.installation_id::text), events.occurred_at desc
  )
  select latest.version, count(*)::bigint
  from latest group by latest.version order by count(*) desc, latest.version;
end;
$$;

comment on function public.ingest_analytics_events(jsonb) is
  'Idempotent per-event analytics ingestion; invalid events are reported without rejecting valid siblings.';
