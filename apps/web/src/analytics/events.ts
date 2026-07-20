import type { Json } from '../lib/database.types';

export const analyticsEventNames = [
  'user_signed_in',
  'user_signed_out',
  'home_viewed',
  'tool_opened',
  'agent_connected',
  'agent_disconnected',
  'agent_update_required',
  'videos_added',
  'estimate_started',
  'estimate_completed',
  'compression_batch_started',
  'compression_started',
  'compression_completed',
  'compression_failed',
  'image_embedding_enabled',
  'transcription_interest_clicked',
  'landing_loaded',
  'landing_optimization_started',
  'language_changed',
  'marketing_consent_changed',
  'support_opened',
  'support_feedback_started'
] as const;

export type AnalyticsEventName = (typeof analyticsEventNames)[number];
export type CompressionMode = 'optimal' | 'custom';
export type RateControl = 'crf' | 'bitrate';

type CompressionProperties = {
  video_count?: number;
  total_input_bytes?: number;
  total_output_bytes?: number;
  saving_percent?: number;
  processing_duration_ms?: number;
  mode?: CompressionMode;
  crf?: number;
  rate_control?: RateControl;
  output_fps?: number;
  target_resolution?: number;
  image_embedding?: boolean;
  success?: boolean;
  error_category?: string;
  tool_identifier?: 'compressor' | 'landing-optimizer';
};

export type AnalyticsEventProperties = {
  user_signed_in: Record<string, never>;
  user_signed_out: Record<string, never>;
  home_viewed: Record<string, never>;
  tool_opened: { tool_identifier: 'compressor' | 'landing-optimizer' };
  agent_connected: Record<string, never>;
  agent_disconnected: { error_category?: string };
  agent_update_required: Record<string, never>;
  videos_added: Pick<CompressionProperties, 'video_count' | 'total_input_bytes'>;
  estimate_started: CompressionProperties;
  estimate_completed: CompressionProperties;
  compression_batch_started: CompressionProperties;
  compression_started: CompressionProperties;
  compression_completed: CompressionProperties;
  compression_failed: CompressionProperties;
  image_embedding_enabled: { image_embedding: true };
  transcription_interest_clicked: { tool_identifier: 'transcription' };
  landing_loaded: { tool_identifier: 'landing-optimizer' };
  landing_optimization_started: { tool_identifier: 'landing-optimizer' };
  language_changed: { language: 'en' | 'uk' };
  marketing_consent_changed: { marketing_consent: boolean };
  support_opened: Record<string, never>;
  support_feedback_started: Record<string, never>;
};

const allowedPropertyKeys = new Set([
  'video_count',
  'total_input_bytes',
  'total_output_bytes',
  'saving_percent',
  'processing_duration_ms',
  'mode',
  'crf',
  'rate_control',
  'output_fps',
  'target_resolution',
  'image_embedding',
  'success',
  'error_category',
  'tool_identifier',
  'language',
  'marketing_consent'
]);

const safeErrorCategories = new Set([
  'agent_unavailable',
  'agent_disconnected',
  'unsupported_media',
  'source_unavailable',
  'insufficient_space',
  'output_validation',
  'image_processing',
  'cancelled',
  'network',
  'unknown'
]);

function finiteNumber(value: unknown, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

export function isAnalyticsEventName(value: string): value is AnalyticsEventName {
  return (analyticsEventNames as readonly string[]).includes(value);
}

export function sanitizeAnalyticsProperties(input: unknown): Record<string, Json> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const source = input as Record<string, unknown>;
  const output: Record<string, Json> = {};

  for (const [key, raw] of Object.entries(source)) {
    if (!allowedPropertyKeys.has(key)) continue;
    if (
      (key === 'video_count' && finiteNumber(raw, 0, 10_000)) ||
      ((key === 'total_input_bytes' || key === 'total_output_bytes') &&
        finiteNumber(raw, 0, Number.MAX_SAFE_INTEGER)) ||
      (key === 'saving_percent' && finiteNumber(raw, -10_000, 100)) ||
      (key === 'processing_duration_ms' && finiteNumber(raw, 0, 31_536_000_000)) ||
      (key === 'crf' && finiteNumber(raw, 0, 63)) ||
      (key === 'output_fps' && finiteNumber(raw, 1, 1000)) ||
      (key === 'target_resolution' && finiteNumber(raw, 16, 32_768))
    ) {
      output[key] = Math.round(raw as number);
      continue;
    }
    if (key === 'mode' && (raw === 'optimal' || raw === 'custom')) output[key] = raw;
    if (key === 'rate_control' && (raw === 'crf' || raw === 'bitrate')) output[key] = raw;
    if (
      (key === 'image_embedding' || key === 'success' || key === 'marketing_consent') &&
      typeof raw === 'boolean'
    )
      output[key] = raw;
    if (key === 'language' && (raw === 'en' || raw === 'uk')) output[key] = raw;
    if (
      key === 'tool_identifier' &&
      (raw === 'compressor' || raw === 'transcription' || raw === 'landing-optimizer')
    )
      output[key] = raw;
    if (key === 'error_category' && typeof raw === 'string' && safeErrorCategories.has(raw))
      output[key] = raw;
  }

  return output;
}

export function analyticsTool(
  name: AnalyticsEventName,
  properties: Record<string, Json>
): string | null {
  if (name === 'tool_opened' || name === 'transcription_interest_clicked')
    return typeof properties.tool_identifier === 'string' ? properties.tool_identifier : null;
  if (name.startsWith('landing')) return 'landing-optimizer';
  if (name.startsWith('compression') || name.startsWith('estimate') || name === 'videos_added')
    return 'compressor';
  return null;
}
