-- 055: retain every integrated analytics rule and admit the seven closed global-image
-- failure codes now emitted by Launch generation. No payload keys or privacy bounds change.
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
        'installer_target', 'native_startup_id', 'agent_architecture', 'package_target', 'flow_id', 'parent_flow_id', 'run_id', 'tool_identifier', 'feature_identifier', 'screen_identifier',
        'action_identifier', 'flow_step', 'outcome', 'source_kind', 'input_method', 'format',
        'video_codec', 'audio_codec', 'image_codec', 'pixel_format', 'setting_name',
        'setting_value', 'error_category', 'error_code', 'error_stage', 'error_fingerprint',
        'retryable', 'recovered', 'success', 'video_count', 'file_count', 'total_input_bytes',
        'total_output_bytes', 'saving_percent', 'processing_duration_ms', 'duration_ms',
        'queue_wait_ms', 'attempt_number', 'width', 'height', 'mode', 'crf', 'limit_percent',
        'rate_control', 'output_fps', 'target_resolution', 'image_embedding', 'explicit_start_image', 'explicit_end_image', 'has_audio',
        'language', 'marketing_consent',
        'study_run_id', 'attempt_id', 'workflow_id', 'category', 'cue_category', 'action', 'file_surface', 'file_delivery',
        'storage_kind', 'size_bucket', 'cache_state', 'stage', 'assisted', 'invite_persisted',
        'root_confirmed', 'sync_queued', 'workspace_session', 'discovery_completed',
        'production_completed', 'window_index', 'item_count', 'ready_count', 'tile_state',
        'had_agent', 'reason', 'contribution_category', 'contribution_action',
        'selection_count', 'folder_count', 'unavailable_count', 'attention_reason',
        'link_trigger', 'link_origin', 'browser_family', 'link_reason', 'link_stage',
        'link_transport', 'recovery_mode', 'surface', 'instance_changed', 'token_changed',
        'pairing_method', 'link_stream_open',
        'rejected_count', 'evicted_count', 'expired_count', 'rejected_events',
        'evicted_events', 'report_window_ms',
        'account_operation','account_action','account_stage','account_code','account_result','account_entity','account_day','account_coverage','revision_id','launch_stage','launch_action','launch_field','launch_code','launch_method','launch_state'
      ])
    )
    -- No value may be long, path-like, or smell of a credential.
    and not exists (
      select 1 from jsonb_each_text(payload) as property
      where length(property.value) > 128
         or property.value ~ '[/\\]'
         or property.value ~* '(bearer|oauth|token=|authorization)'
    )
    and case when payload ? 'account_operation' then payload ->> 'account_operation' in ('createAccount','renameAccount','setAccountTwoFactor','deleteAccount','addAccountAgent','updateAccountAgent','deleteAccountAgent','addAgentRun','updateAgentRun','deleteAgentRun','setAgentRunMarker','clearAgentRunMarkers','clearAgentRuns','attachAgentLabel','detachAgentLabel','financeClear','financeUndo','financeLegacyImport','financeTransfer','financeHistory','financeExport') else true end
    and case when payload ? 'account_action' then payload ->> 'account_action' in ('overview','reorder','lifecycle','decoration','finance_edit','topup_copy','retained_action') else true end
    and case when payload ? 'account_stage' then payload ->> 'account_stage' in ('held','captured','drop','draft_resolution','preflight','edited','validated','requested','accepted','applied','terminal','clipboard_requested','clipboard_confirmed') else true end
    and case when payload ? 'account_code' then payload ->> 'account_code' in ('NONE','AUTH_REQUIRED','NOT_A_MEMBER','AGENT_ID_CONFLICT','NAME_CONFLICT','WRONG_STATE','DATE_BEFORE_AGENT','TRANSFER_DATE_INVALID','FINANCE_UNDO_ALREADY_APPLIED','LEGACY_ALREADY_IMPORTED','LEGACY_TARGET_OCCUPIED','INVALID_INPUT','INVALID_RESPONSE','PERMISSION_DENIED','NOT_FOUND','ACCOUNT_ARCHIVED','ACCOUNT_SCOPE_CHANGED','PARENT_ARCHIVED','HISTORICAL_CORRECTION_REQUIRED','REQUEST_REPLAY_MISMATCH','FINANCE_CONFLICT','FINANCE_AMOUNT_INVALID','FINANCE_HISTORY_PROTECTED','FINANCE_CLIENT_UPGRADE_REQUIRED','REQUEST_REUSE_CONFLICT','FINANCE_EXPORT_FAILED','FUTURE_FINANCE_DATE','PLACEMENT_CONFLICT','ACCOUNT_ORDER_CONFLICT','ACCOUNT_LIFECYCLE_CONFLICT','ACCOUNT_CONTENT_CONFLICT','ACCOUNT_PREFERENCE_CONFLICT','ACCOUNT_RESULT_UNCERTAIN','VERSION_CONFLICT','CLIPBOARD_DENIED','SOURCE_CHANGED','WORKSPACE_READ_TIMEOUT','UNKNOWN') else true end
    and case when payload ? 'account_result' then payload ->> 'account_result' in ('complete','partial','cancelled','noop','conflict','denied','unknown','hidden_no_period_data','retained_period_data','restored','parent_archived','failed') else true end
    and case when payload ? 'account_entity' then payload ->> 'account_entity' in ('social','rk','workspace') else true end
    and case when payload ? 'account_day' then payload ->> 'account_day' in ('today','previous','historical') else true end
    and case when payload ? 'account_coverage' then payload ->> 'account_coverage' in ('complete','accounts_missing','finance_missing','launches_missing','multiple_missing','accounts_only') else true end
    and case when payload ? 'launch_stage' then payload ->> 'launch_stage' in ('validation','draft_saved','accepted','preparing','restitch_preparing','restitch_processing','restitch_uploading','catalog_planning','catalog_creating','catalog_sharing','catalog_registering','result_committing','result_committed','cancel','cleanup') else true end
    and case when payload ? 'launch_action' then payload ->> 'launch_action' in ('generate','retry','cancel','save_draft','refresh_sources','save_overrides','restore_config','save_defaults','copy_launch','archive_launch','copy_field','rename_dictionary','archive_dictionary','restore_dictionary','assign_account','release_account') else true end
    and case when payload ? 'launch_field' then payload ->> 'launch_field' in ('advertising_url','catalog_name','catalog_url','campaign_name','budget','ad_range','sub1','sub2','sub3') else true end
    and case when payload ? 'launch_code' then payload ->> 'launch_code' in ('GLOBAL_IMAGE_POOL_UNAVAILABLE','GLOBAL_IMAGE_READINESS_UNKNOWN','GLOBAL_IMAGE_ALLOCATION_UNKNOWN','GLOBAL_IMAGE_SETTINGS_RETIRED','GLOBAL_IMAGE_CLIENT_UPGRADE_REQUIRED','GLOBAL_IMAGE_POLICY_CONFLICT','GLOBAL_IMAGE_CLEANUP_UNKNOWN','RESTITCH_SCREEN_CANDIDATES_EXHAUSTED','RESTITCH_SCREEN_PREVIOUS_FAILURES','RESTITCH_SCREEN_BYTE_LIMIT','RESTITCH_SCREEN_IO_LIMIT','RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN','RESTITCH_SCREEN_UNAVAILABLE','RESTITCH_SCREEN_FETCH_FAILED','RESTITCH_SCREEN_UNSUPPORTED','STITCH_INTERRUPTED','STITCH_TOOL_FAILED','STITCH_PATH_INVALID','STITCH_PLAN_VIDEO_CODEC','STITCH_PLAN_AUDIO_CODEC','STITCH_PLAN_VARIABLE_FRAME_RATE','STITCH_PLAN_CONTAINER','STITCH_PLAN_UNREADABLE','STITCH_PLAN_NOTHING_TO_REMOVE','STITCH_PLAN_NO_SCREENS','STITCH_OUTPUT_UNWRITABLE','STITCH_VERIFICATION_FAILED','STITCH_IMAGE_UNAVAILABLE','STITCH_JOIN_FAILED','STITCH_AUDIO_MISMATCH','MEDIA_TOOL_UNAVAILABLE','SILENCE_BANK_FAILED','SCREEN_ENCODE_FAILED','SCREEN_SILENCE_FAILED','SCREEN_MUX_FAILED','BODY_PREPARE_FAILED','BODY_REMUX_FAILED','BODY_HEAD_FAILED','BODY_TAIL_FAILED','BODY_AUDIO_MISMATCH','BODY_RECOVERY_FAILED','BODY_RECOVERY_VERIFICATION_FAILED','BODY_TIMING_UNREADABLE','BODY_JOIN_FAILED','PROCESS_RESULT_UNCERTAIN','INVALID_INPUT','INVALID_RESPONSE','SOURCE_CHANGED','PERMISSION_DENIED','NOT_FOUND','SPACE_BLOCKED','LAUNCH_BUSY','LAUNCH_VERSION_CONFLICT','LAUNCH_URL_INVALID','LAUNCH_SUB_INVALID','LAUNCH_BUDGET_INVALID','LAUNCH_RESULT_UNCERTAIN','LEASE_MISMATCH','DRIVE_UNAVAILABLE','DRIVE_FILE_MISSING','AGENT_UPDATE_REQUIRED','AGENT_REQUIRED','NEEDS_REAUTH','RESTITCH_INVALID','RESTITCH_NO_SCREENS','RESTITCH_POOL_EMPTY','RESTITCH_SOURCE_FORBIDDEN','RESTITCH_SOURCES_INVALID','RESTITCH_CLIENT_OUTDATED','PROCESS_FAILED','PROCESS_CANCELED','WRONG_STATE','LAUNCH_INTERNAL_ERROR','SHARE_NOT_ALLOWED','NO_WORK','UNKNOWN','CATALOG_IMAGE_UPGRADE_REQUIRED','CATALOG_IMAGE_IMPORT_DISABLED','IMAGE_QUOTA_EXCEEDED','IMAGE_UPLOAD_CAPACITY_BUSY','IMAGE_MANIFEST_INCOMPLETE','IMAGE_SOURCE_UNAVAILABLE','IMAGE_SOURCE_CHANGED','IMAGE_LOCAL_SOURCE_REQUIRED','IMAGE_UNSUPPORTED_FORMAT','IMAGE_TOO_LARGE','IMAGE_DIMENSIONS_INVALID','IMAGE_ANIMATED_UNSUPPORTED','IMAGE_ORIENTATION_UNSUPPORTED','IMAGE_CONTENT_INVALID','IMAGE_CLASSIFICATION_CONFLICT','IMAGE_TEXT_PAIRING_CONFLICT','IMAGE_PROVIDER_UNAVAILABLE','IMAGE_PROVIDER_RATE_LIMITED','IMAGE_PUBLIC_VERIFICATION_FAILED','IMAGE_WRITE_UNCERTAIN','IMAGE_DICTIONARY_COMMIT_FAILED','IMAGE_PUBLICATION_REVOKED','IMAGE_CLIPBOARD_UNAVAILABLE','IDEMPOTENCY_CONFLICT') else true end
    and case when payload ? 'launch_method' then payload ->> 'launch_method' in ('catalog','other') else true end
    and case when payload ? 'launch_state' then payload ->> 'launch_state' in ('accepted','running','waiting_dependency','partial','failed','interrupted','succeeded','cancel_requested','canceled_with_cleanup_pending','canceled') else true end
    and case when payload ? 'agent_architecture' then payload ->> 'agent_architecture' in ('arm64','x64','unknown') else true end
    and case when payload ? 'package_target' then payload ->> 'package_target' in ('macos-arm64','macos-x64','windows-x64','unknown') else true end
    and case when payload ? 'installer_target' then payload ->> 'installer_target' in ('macos-arm64','macos-x64','windows-x64') else true end
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
        'input','estimate','encode','output','image_embedding', 'explicit_start_image', 'explicit_end_image',
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
      payload ->> 'action' in ('upload','download','rename','move','trash','share')
      else true end
    and case when payload ? 'file_delivery' then
      payload ->> 'file_delivery' in ('browser_handoff','agent_saved','url_visible')
    else true end
    and case when payload ? 'file_surface' then
      payload ->> 'file_surface' in ('material','catalog_manager')
    else true end
    and case when payload ? 'storage_kind' then
      payload ->> 'storage_kind' in ('my_drive','shared_drive','unknown')
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
        'retryable','recovered','success','image_embedding', 'explicit_start_image', 'explicit_end_image','has_audio','marketing_consent',
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
    and case when payload ? 'native_startup_id' then payload ->> 'native_startup_id' ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' else true end
    -- Opaque identifiers.
    and not exists (
      select 1
      from jsonb_each_text(payload) as property
      where property.key in ('native_startup_id','flow_id','parent_flow_id','run_id','study_run_id','attempt_id','workflow_id','revision_id')
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
