import type { Json } from '../lib/database.types';
import type { BrowserFamily } from '../lib/browser';
import {
  CREATIVE_LIBRARY_CONTRIBUTION_ACTIONS,
  CREATIVE_LIBRARY_CONTRIBUTION_CATEGORIES,
  MATERIAL_CATEGORIES,
  TEAM_ANALYTICS_ACTIONS,
  TEAM_ANALYTICS_CACHE_STATES,
  TEAM_ANALYTICS_COUNT_MAX,
  TEAM_ANALYTICS_CUES,
  TEAM_ANALYTICS_EVENT_NAMES,
  TEAM_ANALYTICS_OUTCOMES,
  TEAM_ANALYTICS_PROPERTY_ENUMS,
  TEAM_ANALYTICS_SIZE_BUCKETS,
  TEAM_ANALYTICS_STAGES,
  TEAM_ANALYTICS_STORAGES,
  TEAM_STORAGE_ATTENTION_REASONS,
  sanitizeTeamAnalyticsProperties,
  type MaterialCategory,
  type TeamAnalyticsAction,
  type TeamAnalyticsCacheState,
  type TeamAnalyticsEventName,
  type TeamAnalyticsOutcome,
  type TeamAnalyticsProperties,
  type TeamAnalyticsSizeBucket,
  type TeamAnalyticsStage,
  type TeamAnalyticsStorage,
  type TeamStorageAttentionReason
} from '@video-compressor/shared';

export const analyticsEventNames = [
  'session_started',
  'user_signed_in',
  'user_signed_out',
  'home_viewed',
  'screen_viewed',
  'tool_impression',
  'tool_open_clicked',
  'tool_opened',
  'feature_impression',
  'feature_enabled',
  'feature_disabled',
  'feature_help_opened',
  'tooltip_opened',
  'settings_section_opened',
  'setting_changed',
  'preset_selected',
  'settings_reset',
  'validation_message_shown',
  'blocked_action_attempted',
  'onboarding_started',
  'onboarding_step_completed',
  'onboarding_skipped',
  'onboarding_completed',
  'local_app_check_started',
  'local_app_check_completed',
  'setup_prompt_shown',
  'install_download_clicked',
  'install_detected',
  'local_app_launch_clicked',
  'pairing_started',
  'pairing_completed',
  'pairing_failed',
  'compatibility_checked',
  'tool_blocked_incompatible',
  'agent_connected',
  'agent_disconnected',
  'agent_update_required',
  // 032 — the browser ↔ Agent link lifecycle (FR-025/026).
  'link_check_started',
  'link_check_completed',
  'link_lost',
  'link_recovered',
  'reconnect_clicked',
  'blocked_by_browser_detected',
  'link_inconsistency',
  'update_available',
  'update_prompt_shown',
  'update_started',
  'update_download_completed',
  'update_verification_failed',
  'update_deferred_busy',
  'update_draining_started',
  'update_restart_started',
  'update_completed',
  'update_failed',
  'update_dismissed',
  'input_add_started',
  'input_add_completed',
  'input_add_rejected',
  'videos_added',
  'estimate_started',
  'estimate_completed',
  'estimate_failed',
  'compression_batch_started',
  // The stitcher's run lifecycle: a job accepted by the local app (014) and
  // its terminal, both carrying the same `run_id` (031 FR-050).
  'stitch_started',
  'stitch_completed',
  'stitch_failed',
  'compression_started',
  'compression_completed',
  'compression_failed',
  'operation_start_clicked',
  'operation_started',
  'operation_stage_started',
  'operation_stage_completed',
  'operation_completed',
  'operation_failed',
  'operation_cancelled',
  'operation_retried',
  'result_opened',
  'result_revealed',
  'result_removed',
  'image_embedding_enabled',
  'transcription_interest_clicked',
  'landing_loaded',
  'landing_optimization_started',
  'landing_optimization_completed',
  'landing_optimization_failed',
  'language_changed',
  'marketing_consent_changed',
  'support_opened',
  'support_donation_clicked',
  'support_feedback_started',
  'diagnostics_copied',
  'power_panel_opened',
  'power_limit_changed',
  'error_occurred',
  // 031 — readiness after `tool_opened` (FR-051) and the client's own delivery
  // losses, counted and reported rather than silently dropped (FR-049).
  'tool_ready',
  'analytics_delivery_report',
  ...TEAM_ANALYTICS_EVENT_NAMES
] as const;

export type AnalyticsEventName = (typeof analyticsEventNames)[number];
// `two-factor`, never anything with "token" in it: the database guard
// `analytics_properties_are_safe_v2` rejects any property value matching
// `bearer|oauth|token=|authorization`, and a rejected event is a silently lost
// event rather than a loud one.
export type AnalyticsTool =
  | 'compressor'
  | 'landing-optimizer'
  | 'landing-preview'
  | 'transcription'
  | 'stitcher'
  | 'two-factor';
export type CompressionMode = 'optimal' | 'custom';
export type RateControl = 'crf' | 'bitrate';

/* ---------------------------------------------------------------------------
 * 032 — closed vocabularies of the link lifecycle. The database guard
 * (`analytics_properties_are_safe_v2`, migration 20261110100000) repeats each
 * list verbatim; a value outside it is dropped here so the event still
 * arrives, and rejected there so a tampered value never lands.
 * ------------------------------------------------------------------------- */

export const LINK_TRIGGERS = [
  'boot',
  'visibility',
  'pageshow',
  'online',
  'manual',
  'stream_lost',
  'request_failed',
  'token_changed',
  'retry'
] as const;
export type LinkTrigger = (typeof LINK_TRIGGERS)[number];

export const LINK_ORIGINS = ['hosted', 'local_copy'] as const;
export type LinkOrigin = (typeof LINK_ORIGINS)[number];

export const BROWSER_FAMILIES = ['safari', 'chrome', 'firefox', 'edge', 'other'] as const;

export const LINK_REASONS = [
  'not_running',
  'not_installed',
  'blocked_by_browser',
  'pairing_rejected',
  'agent_too_old',
  'web_too_old',
  'account_check_required',
  'account_check_unavailable',
  'update_in_progress',
  'timeout',
  'unknown'
] as const;
export type LinkReasonProp = (typeof LINK_REASONS)[number];

export const LINK_STAGES = [
  'probe',
  'token',
  'health',
  'entitlement',
  'snapshot',
  'stream'
] as const;
export type LinkStage = (typeof LINK_STAGES)[number];

export const LINK_TRANSPORTS = ['stream', 'request', 'watchdog'] as const;
export type LinkTransport = (typeof LINK_TRANSPORTS)[number];

export const RECOVERY_MODES = ['auto', 'manual', 'local_copy'] as const;
export type RecoveryMode = (typeof RECOVERY_MODES)[number];

/** Every surface of FR-010 that renders a "Reconnect" action. */
export const RECONNECT_SURFACES = [
  'header_badge',
  'home',
  'account',
  'compressor',
  'transcription',
  'stitcher',
  'landing_optimizer',
  'landing_preview',
  'power',
  'team_shell',
  'team_actions',
  'team_process_dialog',
  'team_library_dialog',
  'team_preview',
  'team_landings'
] as const;
export type ReconnectSurface = (typeof RECONNECT_SURFACES)[number];

export const PAIRING_METHODS = ['fragment', 'handshake', 'navigation'] as const;
export type PairingMethod = (typeof PAIRING_METHODS)[number];

/** One day: the longest break the link analytics will describe as a duration. */
export const LINK_DURATION_MAX_MS = 86_400_000;

export const ANALYTICS_TOOLS = [
  'compressor',
  'landing-optimizer',
  'landing-preview',
  'transcription',
  'stitcher',
  'two-factor'
] as const satisfies readonly AnalyticsTool[];

/* ---------------------------------------------------------------------------
 * 031 — `error_stage` is a closed vocabulary per tool (FR-052), so an
 * `error_fingerprint = <tool>:<stage>:<code>` never carries a free string. The
 * readiness stages belong to `tool_ready` (FR-051); the link stages are 032's.
 * The database guard repeats the flattened union.
 * ------------------------------------------------------------------------- */

export const READINESS_STAGES = ['initial_read', 'subscribe'] as const;
export type ReadinessStage = (typeof READINESS_STAGES)[number];

export const ERROR_STAGES_BY_TOOL = {
  compressor: ['input', 'estimate', 'encode', 'output', 'image_embedding'],
  transcription: ['input', 'model', 'transcribe', 'translate', 'save'],
  'landing-optimizer': ['upload', 'optimize', 'package'],
  'landing-preview': ['open', 'render', 'refresh'],
  team: ['transfer', 'process', 'download', 'library'],
  stitcher: ['picker', 'drop_resolve', 'input_probe', 'settings_read', 'stitch', 'output'],
  readiness: READINESS_STAGES,
  link: LINK_STAGES
} as const;

export type ErrorStage = (typeof ERROR_STAGES_BY_TOOL)[keyof typeof ERROR_STAGES_BY_TOOL][number];
export const ERROR_STAGES: readonly ErrorStage[] = Object.freeze([
  ...new Set(Object.values(ERROR_STAGES_BY_TOOL).flatMap((stages): ErrorStage[] => [...stages]))
]);

/* ---------------------------------------------------------------------------
 * 031 — the client's own delivery losses (FR-049). Counters are bounded, and
 * the two event-name lists are comma-joined names from the allowlist above,
 * never free text.
 * ------------------------------------------------------------------------- */

export const DELIVERY_REPORT_COUNT_MAX = 100_000;
export const DELIVERY_REPORT_EVENT_LIST_MAX = 10;
export const DELIVERY_REPORT_WINDOW_MAX_MS = 86_400_000;
/** The database guard refuses any property value longer than this. */
const PROPERTY_VALUE_MAX_LENGTH = 128;

export type AnalyticsProperties = {
  flow_id?: string;
  run_id?: string;
  tool_identifier?: AnalyticsTool;
  feature_identifier?: string;
  screen_identifier?: string;
  action_identifier?: string;
  flow_step?: string;
  outcome?: TeamAnalyticsOutcome;
  source_kind?: string;
  input_method?: string;
  format?: string;
  video_codec?: string;
  audio_codec?: string;
  image_codec?: string;
  pixel_format?: string;
  setting_name?: string;
  setting_value?: string | number | boolean;
  error_category?: string;
  error_code?: string;
  error_stage?: ErrorStage;
  error_fingerprint?: string;
  retryable?: boolean;
  recovered?: boolean;
  success?: boolean;
  video_count?: number;
  file_count?: number;
  total_input_bytes?: number;
  total_output_bytes?: number;
  saving_percent?: number;
  processing_duration_ms?: number;
  duration_ms?: number;
  queue_wait_ms?: number;
  attempt_number?: number;
  width?: number;
  height?: number;
  mode?: CompressionMode;
  crf?: number;
  /** Settled power-limit percentage, never an intermediate drag position. */
  limit_percent?: number;
  rate_control?: RateControl;
  output_fps?: number;
  target_resolution?: number;
  image_embedding?: boolean;
  has_audio?: boolean;
  language?: 'en' | 'uk';
  marketing_consent?: boolean;
  // 032 — link lifecycle (FR-024…FR-026).
  link_trigger?: LinkTrigger;
  link_origin?: LinkOrigin;
  browser_family?: BrowserFamily;
  link_reason?: LinkReasonProp;
  link_stage?: LinkStage;
  link_transport?: LinkTransport;
  recovery_mode?: RecoveryMode;
  surface?: ReconnectSurface;
  instance_changed?: boolean;
  token_changed?: boolean;
  pairing_method?: PairingMethod;
  link_stream_open?: boolean;
  // 031 — `analytics_delivery_report` (FR-049).
  rejected_count?: number;
  evicted_count?: number;
  expired_count?: number;
  rejected_events?: string;
  evicted_events?: string;
  report_window_ms?: number;
} & TeamAnalyticsProperties;

export interface TeamFileAttemptStartedProperties {
  attempt_id: string;
  action: TeamAnalyticsAction;
  storage_kind: TeamAnalyticsStorage;
  size_bucket: TeamAnalyticsSizeBucket;
  cache_state: TeamAnalyticsCacheState;
  attempt_number: number;
  stage: TeamAnalyticsStage;
}

export interface TeamFileAttemptCompletedProperties extends TeamFileAttemptStartedProperties {
  duration_ms: number;
  outcome: TeamAnalyticsOutcome;
  retryable: boolean;
  production_completed: boolean;
}

export interface TeamWorkflowStartedProperties {
  workflow_id: string;
  category: MaterialCategory;
  cache_state: TeamAnalyticsCacheState;
  attempt_number: number;
  stage: TeamAnalyticsStage;
}

export interface TeamWorkflowCompletedProperties extends TeamWorkflowStartedProperties {
  duration_ms: number;
  outcome: TeamAnalyticsOutcome;
  retryable: boolean;
  production_completed: boolean;
}

export interface TeamStorageConnectedProperties {
  selection_count: number;
  storage_kind: TeamAnalyticsStorage;
}

export interface TeamIndexCompletedProperties {
  folder_count: number;
  file_count: number;
  duration_ms: number;
}

export interface TeamPreviewsReadyProperties {
  ready_count: number;
  unavailable_count: number;
  duration_ms: number;
}

export interface TeamStorageAttentionProperties {
  attention_reason: TeamStorageAttentionReason;
}

export interface CreativeLibraryContributionEventProperties {
  contribution_category: TeamAnalyticsProperties['contribution_category'];
  contribution_action: TeamAnalyticsProperties['contribution_action'];
  outcome: TeamAnalyticsOutcome;
  item_count?: number;
}

/** `tool_ready` — readiness after `tool_opened` (031 FR-051). */
export interface ToolReadyProperties {
  tool_identifier: AnalyticsTool;
  outcome: 'success' | 'failure' | 'skipped';
  duration_ms: number;
  error_stage?: ReadinessStage;
  error_code?: string;
}

/** `analytics_delivery_report` — the client's own losses, counted (031 FR-049). */
export interface AnalyticsDeliveryReportProperties {
  rejected_count: number;
  evicted_count: number;
  expired_count: number;
  rejected_events?: string;
  evicted_events?: string;
  report_window_ms: number;
}

type TeamEventProperties<Event extends TeamAnalyticsEventName> =
  Event extends 'team_file_attempt_started'
    ? TeamFileAttemptStartedProperties
    : Event extends 'team_file_attempt_completed'
      ? TeamFileAttemptCompletedProperties
      : Event extends 'team_workflow_started'
        ? TeamWorkflowStartedProperties
        : Event extends 'team_workflow_completed'
          ? TeamWorkflowCompletedProperties
          : Event extends
                | 'team_library_batch_completed'
                | 'team_library_processing_completed'
                | 'team_task_completed'
            ? CreativeLibraryContributionEventProperties
            : Event extends 'team_storage_connected'
              ? TeamStorageConnectedProperties
              : Event extends 'team_index_completed'
                ? TeamIndexCompletedProperties
                : Event extends 'team_previews_ready'
                  ? TeamPreviewsReadyProperties
                  : Event extends 'team_storage_attention'
                    ? TeamStorageAttentionProperties
                    : TeamAnalyticsProperties;

export type AnalyticsEventProperties = {
  [Event in AnalyticsEventName]: Event extends TeamAnalyticsEventName
    ? TeamEventProperties<Event>
    : Event extends 'tool_ready'
      ? ToolReadyProperties
      : Event extends 'analytics_delivery_report'
        ? AnalyticsDeliveryReportProperties
        : AnalyticsProperties;
};

/* ---------------------------------------------------------------------------
 * The allowlist. One rule per property; `sanitizeAnalyticsProperties` reads
 * this table and nothing else, and the four exported views below are derived
 * from it, so the database guard (`analytics_properties_are_safe_v2`) is tested
 * against a single client source (031 FR-048, tests/analytics-guard-contract).
 *
 * - `token`: a short safe string, `^[a-z0-9][a-z0-9._:-]{0,95}$` (case-insensitive).
 * - `id`: an opaque identifier, the database's `^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$`.
 * - `boolean`: a boolean or nothing — never the string "true".
 * - `number`: finite and inside the closed range, rounded to an integer.
 * - `enum`: a value outside the vocabulary is dropped, never passed through.
 * - `setting_value`: a token, a number or a boolean.
 * - `event_list`: comma-joined event names from `analyticsEventNames`, at most
 *   `DELIVERY_REPORT_EVENT_LIST_MAX` of them and never longer than the guard's
 *   128-character value limit.
 * ------------------------------------------------------------------------- */

export type AnalyticsPropertyRule =
  | { kind: 'token' }
  | { kind: 'id' }
  | { kind: 'boolean' }
  | { kind: 'number'; range: readonly [number, number] }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'setting_value' }
  | { kind: 'event_list' };

const ONE_YEAR_MS = 31_536_000_000;

export const ANALYTICS_PROPERTY_RULES: Readonly<
  Record<keyof AnalyticsProperties, AnalyticsPropertyRule>
> = {
  flow_id: { kind: 'id' },
  run_id: { kind: 'id' },
  tool_identifier: { kind: 'enum', values: ANALYTICS_TOOLS },
  feature_identifier: { kind: 'token' },
  screen_identifier: { kind: 'token' },
  action_identifier: { kind: 'token' },
  flow_step: { kind: 'token' },
  outcome: { kind: 'enum', values: TEAM_ANALYTICS_OUTCOMES },
  source_kind: { kind: 'token' },
  input_method: { kind: 'token' },
  format: { kind: 'token' },
  video_codec: { kind: 'token' },
  audio_codec: { kind: 'token' },
  image_codec: { kind: 'token' },
  pixel_format: { kind: 'token' },
  setting_name: { kind: 'token' },
  setting_value: { kind: 'setting_value' },
  error_category: { kind: 'token' },
  error_code: { kind: 'token' },
  error_stage: { kind: 'enum', values: ERROR_STAGES },
  error_fingerprint: { kind: 'token' },
  retryable: { kind: 'boolean' },
  recovered: { kind: 'boolean' },
  success: { kind: 'boolean' },
  video_count: { kind: 'number', range: [0, 10_000] },
  file_count: { kind: 'number', range: [0, 1_000_000] },
  total_input_bytes: { kind: 'number', range: [0, Number.MAX_SAFE_INTEGER] },
  total_output_bytes: { kind: 'number', range: [0, Number.MAX_SAFE_INTEGER] },
  saving_percent: { kind: 'number', range: [-10_000, 100] },
  processing_duration_ms: { kind: 'number', range: [0, ONE_YEAR_MS] },
  // The link lifecycle clamps a break to one day (032); the team sanitizer and
  // the database guard allow a year. A larger value is dropped here so the
  // event still arrives without it, instead of being refused at ingestion.
  duration_ms: { kind: 'number', range: [0, LINK_DURATION_MAX_MS] },
  queue_wait_ms: { kind: 'number', range: [0, ONE_YEAR_MS] },
  attempt_number: { kind: 'number', range: [1, 10_000] },
  width: { kind: 'number', range: [0, 131_072] },
  height: { kind: 'number', range: [0, 131_072] },
  mode: { kind: 'enum', values: ['optimal', 'custom'] },
  crf: { kind: 'number', range: [0, 63] },
  limit_percent: { kind: 'number', range: [20, 100] },
  rate_control: { kind: 'enum', values: ['crf', 'bitrate'] },
  output_fps: { kind: 'number', range: [1, 1000] },
  target_resolution: { kind: 'number', range: [16, 32_768] },
  image_embedding: { kind: 'boolean' },
  has_audio: { kind: 'boolean' },
  language: { kind: 'enum', values: ['en', 'uk'] },
  marketing_consent: { kind: 'boolean' },
  // Team keys a non-team event may carry: the same closed sets the shared
  // sanitizer applies, so a value the guard would refuse never leaves here.
  study_run_id: { kind: 'id' },
  attempt_id: { kind: 'id' },
  workflow_id: { kind: 'id' },
  category: { kind: 'enum', values: MATERIAL_CATEGORIES },
  cue_category: { kind: 'enum', values: TEAM_ANALYTICS_CUES },
  action: { kind: 'enum', values: TEAM_ANALYTICS_ACTIONS },
  storage_kind: { kind: 'enum', values: TEAM_ANALYTICS_STORAGES },
  size_bucket: { kind: 'enum', values: TEAM_ANALYTICS_SIZE_BUCKETS },
  cache_state: { kind: 'enum', values: TEAM_ANALYTICS_CACHE_STATES },
  stage: { kind: 'enum', values: TEAM_ANALYTICS_STAGES },
  assisted: { kind: 'boolean' },
  invite_persisted: { kind: 'boolean' },
  root_confirmed: { kind: 'boolean' },
  sync_queued: { kind: 'boolean' },
  workspace_session: { kind: 'boolean' },
  discovery_completed: { kind: 'boolean' },
  production_completed: { kind: 'boolean' },
  window_index: { kind: 'number', range: [1, 4] },
  item_count: { kind: 'number', range: [0, TEAM_ANALYTICS_COUNT_MAX] },
  ready_count: { kind: 'number', range: [0, TEAM_ANALYTICS_COUNT_MAX] },
  tile_state: { kind: 'enum', values: TEAM_ANALYTICS_PROPERTY_ENUMS.tile_state },
  had_agent: { kind: 'boolean' },
  reason: { kind: 'enum', values: TEAM_ANALYTICS_PROPERTY_ENUMS.reason },
  contribution_category: { kind: 'enum', values: CREATIVE_LIBRARY_CONTRIBUTION_CATEGORIES },
  contribution_action: { kind: 'enum', values: CREATIVE_LIBRARY_CONTRIBUTION_ACTIONS },
  selection_count: { kind: 'number', range: [0, TEAM_ANALYTICS_COUNT_MAX] },
  folder_count: { kind: 'number', range: [0, TEAM_ANALYTICS_COUNT_MAX] },
  unavailable_count: { kind: 'number', range: [0, TEAM_ANALYTICS_COUNT_MAX] },
  attention_reason: { kind: 'enum', values: TEAM_STORAGE_ATTENTION_REASONS },
  // 032 — link lifecycle.
  link_trigger: { kind: 'enum', values: LINK_TRIGGERS },
  link_origin: { kind: 'enum', values: LINK_ORIGINS },
  browser_family: { kind: 'enum', values: BROWSER_FAMILIES },
  link_reason: { kind: 'enum', values: LINK_REASONS },
  link_stage: { kind: 'enum', values: LINK_STAGES },
  link_transport: { kind: 'enum', values: LINK_TRANSPORTS },
  recovery_mode: { kind: 'enum', values: RECOVERY_MODES },
  surface: { kind: 'enum', values: RECONNECT_SURFACES },
  instance_changed: { kind: 'boolean' },
  token_changed: { kind: 'boolean' },
  pairing_method: { kind: 'enum', values: PAIRING_METHODS },
  link_stream_open: { kind: 'boolean' },
  // 031 — delivery report.
  rejected_count: { kind: 'number', range: [0, DELIVERY_REPORT_COUNT_MAX] },
  evicted_count: { kind: 'number', range: [0, DELIVERY_REPORT_COUNT_MAX] },
  expired_count: { kind: 'number', range: [0, DELIVERY_REPORT_COUNT_MAX] },
  rejected_events: { kind: 'event_list' },
  evicted_events: { kind: 'event_list' },
  report_window_ms: { kind: 'number', range: [0, DELIVERY_REPORT_WINDOW_MAX_MS] }
};

type AnalyticsPropertyKey = keyof AnalyticsProperties;

const ruleEntries = Object.entries(ANALYTICS_PROPERTY_RULES) as [
  AnalyticsPropertyKey,
  AnalyticsPropertyRule
][];

export const ANALYTICS_PROPERTY_KEYS: readonly string[] = Object.freeze(
  ruleEntries.map(([key]) => key)
);
export const ANALYTICS_PROPERTY_ENUMS: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(
    ruleEntries.flatMap(([key, rule]) => (rule.kind === 'enum' ? [[key, rule.values]] : []))
  )
);
export const ANALYTICS_BOOLEAN_KEYS: readonly string[] = Object.freeze(
  ruleEntries.flatMap(([key, rule]) => (rule.kind === 'boolean' ? [key] : []))
);
export const ANALYTICS_NUMERIC_RANGES: Readonly<Record<string, [number, number]>> = Object.freeze(
  Object.fromEntries(
    ruleEntries.flatMap(([key, rule]): [string, [number, number]][] =>
      rule.kind === 'number' ? [[key, [rule.range[0], rule.range[1]]]] : []
    )
  )
);

const safeToken = /^[a-z0-9][a-z0-9._:-]{0,95}$/i;
const safeOpaqueId = /^[a-z0-9][a-z0-9_-]{0,95}$/i;
/**
 * A value ending in a file extension — `holiday.mov`, `contract.pdf`, `clip.mp4.part`.
 *
 * `safeToken` allows `.` so that versions and dotted vocabulary survive, which also let a bare
 * file name through any free-form slot (`format`, `source_kind`, `error_code`, …): a caller
 * that passed `file.name` where a token belonged shipped the user's file name to analytics
 * (SC-009, FR-029). No vocabulary value ends in a lettered extension, so the shape is refused;
 * `1.2.6` still passes, because an extension needs a letter.
 */
const fileNameShaped = /\.[a-z0-9]*[a-z][a-z0-9]*$/i;

function safeTokenValue(raw: unknown): raw is string {
  return typeof raw === 'string' && safeToken.test(raw) && !fileNameShaped.test(raw);
}

export function isAnalyticsEventName(value: string): value is AnalyticsEventName {
  return (analyticsEventNames as readonly string[]).includes(value);
}

function isAnalyticsPropertyKey(key: string): key is AnalyticsPropertyKey {
  return Object.prototype.hasOwnProperty.call(ANALYTICS_PROPERTY_RULES, key);
}

/**
 * Keeps the known event names of a comma-joined list, in order and without
 * repeats, up to the list limit and the guard's value length.
 */
export function sanitizeAnalyticsEventList(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const names: string[] = [];
  for (const part of value.split(',')) {
    const name = part.trim();
    if (!isAnalyticsEventName(name) || names.includes(name)) continue;
    if (names.length >= DELIVERY_REPORT_EVENT_LIST_MAX) break;
    if ([...names, name].join(',').length > PROPERTY_VALUE_MAX_LENGTH) break;
    names.push(name);
  }
  return names.length ? names.join(',') : undefined;
}

function sanitizeAnalyticsValue(rule: AnalyticsPropertyRule, raw: unknown): Json | undefined {
  switch (rule.kind) {
    case 'token':
      return safeTokenValue(raw) ? raw : undefined;
    case 'id':
      return typeof raw === 'string' && safeOpaqueId.test(raw) ? raw : undefined;
    case 'boolean':
      return typeof raw === 'boolean' ? raw : undefined;
    case 'number':
      return typeof raw === 'number' &&
        Number.isFinite(raw) &&
        raw >= rule.range[0] &&
        raw <= rule.range[1]
        ? Math.round(raw)
        : undefined;
    case 'enum':
      return typeof raw === 'string' && rule.values.includes(raw) ? raw : undefined;
    case 'setting_value':
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
      if (typeof raw === 'boolean') return raw;
      return safeTokenValue(raw) ? raw : undefined;
    case 'event_list':
      return sanitizeAnalyticsEventList(raw);
  }
}

export function sanitizeAnalyticsProperties(
  input: unknown,
  eventName?: AnalyticsEventName
): Record<string, Json> {
  if (eventName && (TEAM_ANALYTICS_EVENT_NAMES as readonly string[]).includes(eventName)) {
    return sanitizeTeamAnalyticsProperties(input) as Record<string, Json>;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const output: Record<string, Json> = {};
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!isAnalyticsPropertyKey(key)) continue;
    const clean = sanitizeAnalyticsValue(ANALYTICS_PROPERTY_RULES[key], raw);
    if (clean !== undefined) output[key] = clean;
  }
  return output;
}

export function analyticsTool(
  name: AnalyticsEventName,
  properties: Record<string, Json>
): AnalyticsTool | null {
  if (typeof properties.tool_identifier === 'string')
    return properties.tool_identifier as AnalyticsTool;
  if (name.startsWith('landing')) return 'landing-optimizer';
  if (name.startsWith('compression') || name.startsWith('estimate') || name === 'videos_added')
    return 'compressor';
  if (name.startsWith('transcription')) return 'transcription';
  return null;
}
