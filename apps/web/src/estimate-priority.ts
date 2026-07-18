import type { CompressionJob } from '@video-compressor/shared';

export type EstimatePriorityAction = 'prioritize' | 'cancel' | null;

export function estimatePriorityAction(job: CompressionJob, compressionRunning: boolean): EstimatePriorityAction {
  if (job.status !== 'queued') return null;
  const status = job.estimateStatus ?? 'waiting';
  if (job.estimatePriorityOrder != null && ['waiting', 'estimating'].includes(status)) return 'cancel';
  if (compressionRunning && ['waiting', 'cancelled'].includes(status)) return 'prioritize';
  return null;
}
