import { analytics } from '../analytics/service';

export type StitchInputStage = 'picker' | 'drop_resolve' | 'input_probe' | 'settings_read';
const SAFE_CODES = new Set([
  'SOURCE_STAT_FAILED',
  'PROBE_SPAWN_FAILED',
  'PROBE_EXIT_FAILED',
  'PROBE_JSON_INVALID',
  'PROBE_METADATA_INVALID',
  'NATIVE_PICKER_UNAVAILABLE',
  'NATIVE_PICKER_TIMEOUT',
  'NATIVE_FILE_PICKER_UNSUPPORTED',
  'STITCH_DROPPED_NOT_FOUND',
  'STITCH_PATH_INVALID',
  'PATH_NOT_GRANTED',
  'MEDIA_TOOL_UNAVAILABLE',
  'CONNECTION_FAILED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'video-codec',
  'audio-codec',
  'variable-frame-rate',
  'container',
  'unreadable'
]);

/** Never export arbitrary exception text: it can include a local path or a token. */
export function recordStitchInputFailure(stage: StitchInputStage, flowId: string, code: string) {
  const safeCode = SAFE_CODES.has(code) ? code : 'STITCH_INPUT_FAILED';
  analytics.track('error_occurred', {
    tool_identifier: 'stitcher',
    flow_id: flowId,
    error_stage: stage,
    error_code: safeCode,
    error_fingerprint: `stitcher:${stage}:${safeCode}`,
    outcome: 'failure'
  });
}

export async function observeStitchInput<T>(
  stage: StitchInputStage,
  flowId: string,
  action: () => Promise<T>,
  outcome?: (result: T) => 'success' | 'cancelled'
): Promise<T> {
  const started = Date.now();
  const base = { tool_identifier: 'stitcher' as const, flow_id: flowId, flow_step: stage };
  analytics.track('operation_stage_started', base);
  try {
    const result = await action();
    analytics.track('operation_stage_completed', {
      ...base,
      duration_ms: Date.now() - started,
      ...(outcome ? { outcome: outcome(result) } : {})
    });
    return result;
  } catch (error) {
    recordStitchInputFailure(stage, flowId, error instanceof Error ? error.message : 'unknown');
    throw error;
  }
}
