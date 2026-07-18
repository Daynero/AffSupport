import type { AgentSettings, CompressionJob } from '@video-compressor/shared';

export type JobTransitionEventName =
  | 'estimate_started'
  | 'estimate_completed'
  | 'compression_started'
  | 'compression_completed'
  | 'compression_failed';

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
  if (previous.status !== 'processing' && current.status === 'processing')
    events.push('compression_started');
  if (previous.status !== 'completed' && current.status === 'completed')
    events.push('compression_completed');
  if (previous.status !== 'failed' && current.status === 'failed')
    events.push('compression_failed');
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

export function safeBatchProperties(settings: AgentSettings, jobs: CompressionJob[]) {
  return {
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
