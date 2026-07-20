import type { Json } from '../lib/database.types';

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
  'support_feedback_started',
  'diagnostics_copied',
  'error_occurred'
] as const;

export type AnalyticsEventName = (typeof analyticsEventNames)[number];
export type AnalyticsTool = 'compressor' | 'landing-optimizer' | 'transcription';
export type CompressionMode = 'optimal' | 'custom';
export type RateControl = 'crf' | 'bitrate';

export type AnalyticsProperties = {
  flow_id?: string;
  run_id?: string;
  tool_identifier?: AnalyticsTool;
  feature_identifier?: string;
  screen_identifier?: string;
  action_identifier?: string;
  flow_step?: string;
  outcome?: 'success' | 'failure' | 'cancelled' | 'blocked' | 'skipped';
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
  error_stage?: string;
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
  rate_control?: RateControl;
  output_fps?: number;
  target_resolution?: number;
  image_embedding?: boolean;
  has_audio?: boolean;
  language?: 'en' | 'uk';
  marketing_consent?: boolean;
};

export type AnalyticsEventProperties = Record<AnalyticsEventName, AnalyticsProperties>;

const allowedPropertyKeys = new Set<keyof AnalyticsProperties>([
  'flow_id',
  'run_id',
  'tool_identifier',
  'feature_identifier',
  'screen_identifier',
  'action_identifier',
  'flow_step',
  'outcome',
  'source_kind',
  'input_method',
  'format',
  'video_codec',
  'audio_codec',
  'image_codec',
  'pixel_format',
  'setting_name',
  'setting_value',
  'error_category',
  'error_code',
  'error_stage',
  'error_fingerprint',
  'retryable',
  'recovered',
  'success',
  'video_count',
  'file_count',
  'total_input_bytes',
  'total_output_bytes',
  'saving_percent',
  'processing_duration_ms',
  'duration_ms',
  'queue_wait_ms',
  'attempt_number',
  'width',
  'height',
  'mode',
  'crf',
  'rate_control',
  'output_fps',
  'target_resolution',
  'image_embedding',
  'has_audio',
  'language',
  'marketing_consent'
]);

const numericRanges: Partial<Record<keyof AnalyticsProperties, readonly [number, number]>> = {
  video_count: [0, 10_000],
  file_count: [0, 1_000_000],
  total_input_bytes: [0, Number.MAX_SAFE_INTEGER],
  total_output_bytes: [0, Number.MAX_SAFE_INTEGER],
  saving_percent: [-10_000, 100],
  processing_duration_ms: [0, 31_536_000_000],
  duration_ms: [0, 31_536_000_000],
  queue_wait_ms: [0, 31_536_000_000],
  attempt_number: [0, 10_000],
  width: [0, 131_072],
  height: [0, 131_072],
  crf: [0, 63],
  output_fps: [1, 1000],
  target_resolution: [16, 32_768]
};

const safeToken = /^[a-z0-9][a-z0-9._:-]{0,95}$/i;
const booleans = new Set<keyof AnalyticsProperties>([
  'retryable',
  'recovered',
  'success',
  'image_embedding',
  'has_audio',
  'marketing_consent'
]);

export function isAnalyticsEventName(value: string): value is AnalyticsEventName {
  return (analyticsEventNames as readonly string[]).includes(value);
}

export function sanitizeAnalyticsProperties(input: unknown): Record<string, Json> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const output: Record<string, Json> = {};
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    const typedKey = key as keyof AnalyticsProperties;
    if (!allowedPropertyKeys.has(typedKey)) continue;
    const range = numericRanges[typedKey];
    if (
      range &&
      typeof raw === 'number' &&
      Number.isFinite(raw) &&
      raw >= range[0] &&
      raw <= range[1]
    ) {
      output[key] = Math.round(raw);
      continue;
    }
    if (booleans.has(typedKey) && typeof raw === 'boolean') {
      output[key] = raw;
      continue;
    }
    if (typedKey === 'setting_value' && (typeof raw === 'number' || typeof raw === 'boolean')) {
      output[key] = raw;
      continue;
    }
    if (typedKey === 'mode' && (raw === 'optimal' || raw === 'custom')) output[key] = raw;
    else if (typedKey === 'rate_control' && (raw === 'crf' || raw === 'bitrate')) output[key] = raw;
    else if (typedKey === 'language' && (raw === 'en' || raw === 'uk')) output[key] = raw;
    else if (
      typedKey === 'outcome' &&
      ['success', 'failure', 'cancelled', 'blocked', 'skipped'].includes(String(raw))
    )
      output[key] = raw as Json;
    else if (
      typedKey === 'tool_identifier' &&
      ['compressor', 'landing-optimizer', 'transcription'].includes(String(raw))
    )
      output[key] = raw as Json;
    else if (typeof raw === 'string' && safeToken.test(raw)) output[key] = raw;
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
