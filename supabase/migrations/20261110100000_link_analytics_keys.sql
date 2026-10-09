-- 032 — the browser ↔ Soty Agent link lifecycle reaches analytics (FR-024…FR-026).
--
-- Additive redefinition of the property guard. The allowlist grows by the
-- twelve link keys, each closed vocabulary is repeated verbatim from
-- apps/web/src/analytics/events.ts, the three new booleans must be booleans,
-- and `duration_ms` — until now unbounded — is a number between zero and one
-- year, the bound the shared team sanitizer already applies. Everything the
-- guard accepted before, it still accepts; the one narrowing is a
-- `duration_ms` above 31 536 000 000, which no client sends.
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
        'language', 'marketing_consent', 'flow_id', 'study_run_id', 'attempt_id',
        'workflow_id', 'category', 'cue_category', 'action', 'storage_kind',
        'size_bucket', 'cache_state', 'stage', 'assisted', 'invite_persisted',
        'root_confirmed', 'sync_queued', 'workspace_session', 'discovery_completed',
        'production_completed', 'window_index',
        'link_trigger', 'link_origin', 'browser_family', 'link_reason', 'link_stage',
        'link_transport', 'recovery_mode', 'surface', 'instance_changed', 'token_changed',
        'pairing_method', 'link_stream_open'
      ])
    )
    and not exists (
      select 1 from jsonb_each_text(payload) as property
      where length(property.value) > 128
         or property.value ~ '[/\\]'
         or property.value ~* '(bearer|oauth|token=|authorization)'
    )
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
    and case when payload ? 'outcome' then
      payload ->> 'outcome' in ('success','failure','cancelled','blocked','skipped','unsupported')
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
    and not exists (
      select 1
      from jsonb_each(payload) as property
      where property.key in (
        'retryable','assisted','invite_persisted','root_confirmed','sync_queued',
        'workspace_session','discovery_completed','production_completed',
        'instance_changed','token_changed','link_stream_open'
      ) and jsonb_typeof(property.value) <> 'boolean'
    )
    and case when payload ? 'window_index' then
      jsonb_typeof(payload -> 'window_index') = 'number'
      and (payload ->> 'window_index')::numeric between 1 and 4
      else true end
    and case when payload ? 'attempt_number' then
      jsonb_typeof(payload -> 'attempt_number') = 'number'
      and (payload ->> 'attempt_number')::numeric between 1 and 10000
      else true end
    and case when payload ? 'duration_ms' then
      jsonb_typeof(payload -> 'duration_ms') = 'number'
      and (payload ->> 'duration_ms')::numeric between 0 and 31536000000
      else true end
    and not exists (
      select 1
      from jsonb_each_text(payload) as property
      where property.key in ('flow_id','study_run_id','attempt_id','workflow_id')
        and property.value !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
    );
$$;
