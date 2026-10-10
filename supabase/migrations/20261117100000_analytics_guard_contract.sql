-- 031 — the property guard mirrors the client allowlist, key for key (FR-048).
--
-- Additive redefinition of public.analytics_properties_are_safe_v2. Until now
-- the client sent twelve keys the guard had never heard of (`limit_percent`,
-- `selection_count`, `folder_count`, `ready_count`, `unavailable_count`,
-- `attention_reason`, `item_count`, `tile_state`, `had_agent`, `reason`,
-- `contribution_category`, `contribution_action`), so every `team_storage_*`,
-- `team_index_completed`, `team_previews_ready`, `team_landing_*`,
-- `team_library_*`, `team_task_completed` and `power_limit_changed` event was
-- refused at ingestion as "Unsafe event properties" — and the client, which
-- only warned, lost them. This file adds those keys with the ranges and
-- vocabularies the client already applies, the keys of the three events the
-- 031 client introduces (`tool_ready`, `analytics_delivery_report`,
-- `stitch_completed|failed`), `run_id` (stripped by ingestion anyway, so a
-- client that still sends it is not refused), and closes `error_stage` to the
-- per-tool vocabulary of apps/web/src/analytics/events.ts.
--
-- Each list below is repeated verbatim from the client. From now on
-- tests/analytics-guard-contract.test.ts loads this body into PGlite and fails
-- `npm run verify` on any drift, in either direction: a key, vocabulary word,
-- boolean or bound the client has and the guard refuses, or one the guard names
-- and no client sanitizer knows.
--
-- Narrowings, every one already enforced by the client sanitizers, so no
-- well-formed event changes fate: the numeric keys must now be JSON numbers
-- inside the client's range (before, `"video_count":"3"` and a negative width
-- passed); `tool_identifier`, `mode`, `rate_control`, `language` and
-- `error_stage` are closed vocabularies (before, any short token passed); the
-- five booleans of the compressor events must be booleans.
--
-- The function sits inside the check constraint of public.analytics_events and
-- is called by public.ingest_analytics_events; neither needs to change.

create or replace function public.analytics_properties_are_safe_v2(payload jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select
    jsonb_typeof(payload) = 'object'
    and octet_length(payload::text) <= 8192
    -- The allowlist: ANALYTICS_PROPERTY_KEYS ∪ TEAM_ANALYTICS_PROPERTY_KEYS.
    and not exists (
      select 1 from jsonb_object_keys(payload) as property_key
      where property_key <> all (array[
        'flow_id', 'run_id', 'tool_identifier', 'feature_identifier', 'screen_identifier',
        'action_identifier', 'flow_step', 'outcome', 'source_kind', 'input_method', 'format',
        'video_codec', 'audio_codec', 'image_codec', 'pixel_format', 'setting_name',
        'setting_value', 'error_category', 'error_code', 'error_stage', 'error_fingerprint',
        'retryable', 'recovered', 'success', 'video_count', 'file_count', 'total_input_bytes',
        'total_output_bytes', 'saving_percent', 'processing_duration_ms', 'duration_ms',
        'queue_wait_ms', 'attempt_number', 'width', 'height', 'mode', 'crf', 'limit_percent',
        'rate_control', 'output_fps', 'target_resolution', 'image_embedding', 'has_audio',
        'language', 'marketing_consent',
        'study_run_id', 'attempt_id', 'workflow_id', 'category', 'cue_category', 'action',
        'storage_kind', 'size_bucket', 'cache_state', 'stage', 'assisted', 'invite_persisted',
        'root_confirmed', 'sync_queued', 'workspace_session', 'discovery_completed',
        'production_completed', 'window_index', 'item_count', 'ready_count', 'tile_state',
        'had_agent', 'reason', 'contribution_category', 'contribution_action',
        'selection_count', 'folder_count', 'unavailable_count', 'attention_reason',
        'link_trigger', 'link_origin', 'browser_family', 'link_reason', 'link_stage',
        'link_transport', 'recovery_mode', 'surface', 'instance_changed', 'token_changed',
        'pairing_method', 'link_stream_open',
        'rejected_count', 'evicted_count', 'expired_count', 'rejected_events',
        'evicted_events', 'report_window_ms'
      ])
    )
    -- No value may be long, path-like, or smell of a credential.
    and not exists (
      select 1 from jsonb_each_text(payload) as property
      where length(property.value) > 128
         or property.value ~ '[/\\]'
         or property.value ~* '(bearer|oauth|token=|authorization)'
    )
    -- Closed vocabularies: ANALYTICS_PROPERTY_ENUMS ∪ TEAM_ANALYTICS_PROPERTY_ENUMS.
    and case when payload ? 'tool_identifier' then
      payload ->> 'tool_identifier' in (
        'compressor','landing-optimizer','landing-preview','transcription','stitcher','two-factor'
      )
      else true end
    and case when payload ? 'outcome' then
      payload ->> 'outcome' in ('success','failure','cancelled','blocked','skipped','unsupported')
      else true end
    and case when payload ? 'error_stage' then
      payload ->> 'error_stage' in (
        -- compressor
        'input','estimate','encode','output','image_embedding',
        -- transcription
        'model','transcribe','translate','save',
        -- landing optimizer
        'upload','optimize','package',
        -- landing preview
        'open','render','refresh',
        -- team
        'transfer','process','download','library',
        -- stitcher
        'picker','drop_resolve','input_probe','settings_read','stitch',
        -- tool_ready
        'initial_read','subscribe',
        -- link (032)
        'probe','token','health','entitlement','snapshot','stream'
      )
      else true end
    and case when payload ? 'mode' then
      payload ->> 'mode' in ('optimal','custom')
      else true end
    and case when payload ? 'rate_control' then
      payload ->> 'rate_control' in ('crf','bitrate')
      else true end
    and case when payload ? 'language' then
      payload ->> 'language' in ('en','uk')
      else true end
    and case when payload ? 'category' then
      payload ->> 'category' in ('video','image','archive','transcript','landing','other')
      else true end
    and case when payload ? 'cue_category' then
      payload ->> 'cue_category' in ('geo','offer','language','category')
      else true end
    and case when payload ? 'action' then
      payload ->> 'action' in ('upload','download','rename','move','trash')
      else true end
    and case when payload ? 'storage_kind' then
      payload ->> 'storage_kind' in ('my_drive','shared_drive')
      else true end
    and case when payload ? 'size_bucket' then
      payload ->> 'size_bucket' in ('tiny','small','medium','large','agent')
      else true end
    and case when payload ? 'cache_state' then
      payload ->> 'cache_state' in ('cold','warm','unknown')
      else true end
    and case when payload ? 'stage' then
      payload ->> 'stage' in ('finding','previewing','downloading','processing','uploading','finalizing')
      else true end
    and case when payload ? 'tile_state' then
      payload ->> 'tile_state' in ('ready','candidate','rendering','needs_agent','agent_outdated','error')
      else true end
    and case when payload ? 'reason' then
      payload ->> 'reason' in ('unsupported','corrupt','protected','too_large','render_error')
      else true end
    and case when payload ? 'contribution_category' then
      payload ->> 'contribution_category' in ('local_processing','human_activity')
      else true end
    and case when payload ? 'contribution_action' then
      payload ->> 'contribution_action' in (
        'transcription','translation','landing_optimization','find_selected','task_created',
        'task_completed','batch_completed'
      )
      else true end
    and case when payload ? 'attention_reason' then
      payload ->> 'attention_reason' in ('needs_reauth','root_missing','permission_lost','quota','sync_failed')
      else true end
    and case when payload ? 'link_trigger' then
      payload ->> 'link_trigger' in (
        'boot','visibility','pageshow','online','manual','stream_lost','request_failed',
        'token_changed','retry'
      )
      else true end
    and case when payload ? 'link_origin' then
      payload ->> 'link_origin' in ('hosted','local_copy')
      else true end
    and case when payload ? 'browser_family' then
      payload ->> 'browser_family' in ('safari','chrome','firefox','edge','other')
      else true end
    and case when payload ? 'link_reason' then
      payload ->> 'link_reason' in (
        'not_running','not_installed','blocked_by_browser','pairing_rejected','agent_too_old',
        'web_too_old','account_check_required','account_check_unavailable','update_in_progress',
        'timeout','unknown'
      )
      else true end
    and case when payload ? 'link_stage' then
      payload ->> 'link_stage' in ('probe','token','health','entitlement','snapshot','stream')
      else true end
    and case when payload ? 'link_transport' then
      payload ->> 'link_transport' in ('stream','request','watchdog')
      else true end
    and case when payload ? 'recovery_mode' then
      payload ->> 'recovery_mode' in ('auto','manual','local_copy')
      else true end
    and case when payload ? 'surface' then
      payload ->> 'surface' in (
        'header_badge','home','account','compressor','transcription','stitcher',
        'landing_optimizer','landing_preview','power','team_shell','team_actions',
        'team_process_dialog','team_library_dialog','team_preview','team_landings'
      )
      else true end
    and case when payload ? 'pairing_method' then
      payload ->> 'pairing_method' in ('fragment','handshake','navigation')
      else true end
    -- Booleans are booleans: ANALYTICS_BOOLEAN_KEYS ∪ TEAM_ANALYTICS_BOOLEAN_KEYS.
    and not exists (
      select 1
      from jsonb_each(payload) as property
      where property.key in (
        'retryable','recovered','success','image_embedding','has_audio','marketing_consent',
        'assisted','invite_persisted','root_confirmed','sync_queued','workspace_session',
        'discovery_completed','production_completed','had_agent',
        'instance_changed','token_changed','link_stream_open'
      ) and jsonb_typeof(property.value) <> 'boolean'
    )
    -- Numbers are numbers inside the client's closed range:
    -- ANALYTICS_NUMERIC_RANGES ∪ TEAM_ANALYTICS_NUMERIC_RANGES (the wider bound
    -- where the two sanitizers differ, so `duration_ms` keeps the year).
    and not exists (
      select 1
      from jsonb_each(payload) as property
      join (values
        ('video_count', 0, 10000),
        ('file_count', 0, 1000000),
        ('total_input_bytes', 0, 9007199254740991),
        ('total_output_bytes', 0, 9007199254740991),
        ('saving_percent', -10000, 100),
        ('processing_duration_ms', 0, 31536000000),
        ('duration_ms', 0, 31536000000),
        ('queue_wait_ms', 0, 31536000000),
        ('attempt_number', 1, 10000),
        ('width', 0, 131072),
        ('height', 0, 131072),
        ('crf', 0, 63),
        ('limit_percent', 20, 100),
        ('output_fps', 1, 1000),
        ('target_resolution', 16, 32768),
        ('window_index', 1, 4),
        ('item_count', 0, 100000),
        ('ready_count', 0, 100000),
        ('selection_count', 0, 100000),
        ('folder_count', 0, 100000),
        ('unavailable_count', 0, 100000),
        ('rejected_count', 0, 100000),
        ('evicted_count', 0, 100000),
        ('expired_count', 0, 100000),
        ('report_window_ms', 0, 86400000)
      ) as bound(key, low, high) on bound.key = property.key
      where jsonb_typeof(property.value) <> 'number'
         or (property.value #>> '{}')::numeric not between bound.low and bound.high
    )
    -- Opaque identifiers.
    and not exists (
      select 1
      from jsonb_each_text(payload) as property
      where property.key in ('flow_id','run_id','study_run_id','attempt_id','workflow_id')
        and property.value !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
    )
    -- The delivery report's two lists: at most ten event names, comma-joined.
    and not exists (
      select 1
      from jsonb_each_text(payload) as property
      where property.key in ('rejected_events','evicted_events')
        and property.value !~ '^[a-z][a-z0-9_]{1,63}(,[a-z][a-z0-9_]{1,63}){0,9}$'
    );
$$;
