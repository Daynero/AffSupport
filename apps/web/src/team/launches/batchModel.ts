import type { LaunchSummary } from '@video-compressor/shared';
export function batchEligible(item: LaunchSummary): boolean {
  return item.hasResult === false && item.generationState === null;
}
