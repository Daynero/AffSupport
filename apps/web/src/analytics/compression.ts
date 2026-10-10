import type { AgentSettings, CompressionJob } from '@video-compressor/shared';
import { safeErrorCode, toolErrorProperties, type ToolErrorStage } from './errors';
import type { AnalyticsProperties } from './events';

export type JobTransitionEventName =
  | 'estimate_started'
  | 'estimate_completed'
  | 'estimate_failed'
  | 'compression_started'
  | 'compression_completed'
  | 'compression_failed'
  // The compressor's fourth ending. It reuses the tool-neutral name the other
  // tools emit, so one query counts cancellations the same way for every tool.
  | 'operation_cancelled';

export function jobTransitionEventNames(
  previous: CompressionJob | undefined,
  current: CompressionJob
): JobTransitionEventName[] {
  if (!previous) return [];
  const events: JobTransitionEventName[] = [];
  if (previous.estimateStatus !== 'estimating' && current.estimateStatus === 'estimating')
    events.push('estimate_started');
  if (previous.estimateStatus !== 'estimated' && current.estimateStatus === 'estimated')
    events.push('estimate_completed');
  if (previous.estimateStatus !== 'unavailable' && current.estimateStatus === 'unavailable')
    events.push('estimate_failed');
  if (previous.status !== 'processing' && current.status === 'processing')
    events.push('compression_started');
  if (previous.status !== 'completed' && current.status === 'completed')
    events.push('compression_completed');
  if (previous.status !== 'failed' && current.status === 'failed')
    events.push('compression_failed');
  if (previous.status !== 'cancelled' && current.status === 'cancelled')
    events.push('operation_cancelled');
  return events;
}

export function safeCompressionProperties(job: CompressionJob) {
  const duration =
    job.startedAt && job.finishedAt ? Math.max(0, job.finishedAt - job.startedAt) : undefined;
  const saving =
    job.finalSize === null || job.originalSize <= 0
      ? undefined
      : ((job.originalSize - job.finalSize) / job.originalSize) * 100;
  return {
    run_id: job.id,
    video_count: 1,
    total_input_bytes: Math.max(0, job.originalSize),
    ...(job.finalSize === null ? {} : { total_output_bytes: Math.max(0, job.finalSize) }),
    ...(saving === undefined ? {} : { saving_percent: saving }),
    ...(duration === undefined ? {} : { processing_duration_ms: duration }),
    mode: job.encoding.mode,
    rate_control: job.encoding.rateControl,
    ...(job.encoding.rateControl === 'crf' ? { crf: job.encoding.crf } : {}),
    ...(job.finalFrameRate || job.encoding.frameRate
      ? { output_fps: job.finalFrameRate || job.encoding.frameRate || undefined }
      : {}),
    ...(job.encoding.resolutionLimit ? { target_resolution: job.encoding.resolutionLimit } : {}),
    image_embedding: Boolean(job.imageEmbedding),
    tool_identifier: 'compressor' as const
  };
}

export function safeBatchProperties(
  settings: AgentSettings,
  jobs: CompressionJob[],
  runId?: string
) {
  return {
    ...(runId ? { run_id: runId } : {}),
    video_count: jobs.length,
    total_input_bytes: jobs.reduce((total, job) => total + Math.max(0, job.originalSize), 0),
    mode: settings.mode,
    rate_control: settings.rateControl,
    ...(settings.rateControl === 'crf' ? { crf: settings.crf } : {}),
    ...(settings.frameRate ? { output_fps: settings.frameRate } : {}),
    ...(settings.resolutionLimit ? { target_resolution: settings.resolutionLimit } : {}),
    image_embedding: settings.imageEmbedding.enabled,
    tool_identifier: 'compressor' as const
  };
}

export function compressionErrorCategory(error: string | null) {
  const value = (error ?? '').toLowerCase();
  if (/cancel/.test(value)) return 'cancelled';
  if (/source|access|missing|enoent/.test(value)) return 'source_unavailable';
  if (/space|disk/.test(value)) return 'insufficient_space';
  if (/unsupported|damaged|probe/.test(value)) return 'unsupported_media';
  if (/image|filter/.test(value)) return 'image_processing';
  if (/validat|mp4/.test(value)) return 'output_validation';
  if (/connect|agent/.test(value)) return 'agent_unavailable';
  return 'unknown';
}

/**
 * 031 FR-052 — the agent's own code for a failed compression (`CompressionJob.errorCode`),
 * never a reading of the sentence beside it. An agent older than the field gives `unknown`.
 */
export function compressionErrorCode(job: Pick<CompressionJob, 'errorCode'>): string {
  return safeErrorCode(job.errorCode ?? null);
}

const COMPRESSION_CODE_STAGES: Readonly<Record<string, ToolErrorStage<'compressor'>>> = {
  UNSUPPORTED_MEDIA: 'input',
  SOURCE_NOT_FOUND: 'input',
  DISK_FULL: 'output',
  DESTINATION_NOT_WRITABLE: 'output',
  OUTPUT_VALIDATION_FAILED: 'output',
  IMAGE_DAMAGED: 'image_embedding',
  IMAGE_UNAVAILABLE: 'image_embedding',
  IMAGE_FILTER_GRAPH_INVALID: 'image_embedding',
  IMAGE_ADAPT_FAILED: 'image_embedding'
};

/** Which part of the compressor a code belongs to; anything unnamed failed in the encode. */
export function compressionErrorStage(code: string): ToolErrorStage<'compressor'> {
  return COMPRESSION_CODE_STAGES[code] ?? 'encode';
}

/** `error_occurred` for a compression that just failed, correlated by its `run_id`. */
export function compressionFailureError(job: CompressionJob): AnalyticsProperties {
  const code = compressionErrorCode(job);
  return toolErrorProperties({
    tool: 'compressor',
    stage: compressionErrorStage(code),
    code,
    runId: job.id
  });
}

/**
 * 033 FR-007 — the agent's own code for a failed estimate (`CompressionJob.estimateErrorCode`),
 * never a reading of the message beside it. An agent older than the field, or a failure the
 * estimator could not name, gives `unknown`.
 */
export function estimateErrorCode(job: Pick<CompressionJob, 'estimateErrorCode'>): string {
  return safeErrorCode(job.estimateErrorCode ?? null);
}

/** `error_occurred` for an estimate that just failed, correlated by its `run_id`. */
export function estimateFailureError(job: CompressionJob): AnalyticsProperties {
  return toolErrorProperties({
    tool: 'compressor',
    stage: 'estimate',
    code: estimateErrorCode(job),
    runId: job.id
  });
}
