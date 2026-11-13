import type { LaunchSummary } from '@video-compressor/shared';
import type { TranslationKey } from '../../i18n.js';
export type LaunchCardState =
  'draft' | 'queued' | 'running' | 'ready' | 'failed' | 'partial' | 'canceled' | 'unknown';
export function launchCardState(
  value: Pick<LaunchSummary, 'generation' | 'generationState' | 'hasResult'>
): LaunchCardState {
  const state = value.generation?.state ?? value.generationState;
  const video = value.generation?.videoGeneration;
  if (state === 'failed' || state === 'interrupted') return 'failed';
  if (state === 'partial') return 'partial';
  if (state === 'canceled') return 'canceled';
  if (video && video.state !== 'ready') {
    if (video.state === 'canceled') return 'partial';
    if (video.state === 'unknown' || video.backgroundStalled) return 'partial';
    return 'running';
  }
  if (state === 'succeeded') return 'ready';
  if (state === 'accepted') return 'queued';
  if (state) return 'running';
  return value.hasResult === true ? 'ready' : value.hasResult === false ? 'draft' : 'unknown';
}
export const launchCardLabels: Record<LaunchCardState, TranslationKey> = {
  draft: 'launchesDraft',
  queued: 'launchesBulkQueued',
  running: 'launchesBusy',
  ready: 'launchesReady',
  failed: 'launchesBulkFailed',
  partial: 'launchesBulkPartial',
  canceled: 'launchesProgressStopped',
  unknown: 'launchesProgressUnconfirmed'
};
export function launchCardProgress(value: LaunchSummary): number | undefined {
  const video = value.generation?.videoGeneration;
  if (video) return (video.registeredCount / video.requestedCount) * 100;
  const progress = value.generation?.progress;
  return progress && progress.total > 0 ? (progress.completed / progress.total) * 100 : undefined;
}
