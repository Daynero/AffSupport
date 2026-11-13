import type {
  DurableLaunchBatch,
  DurableLaunchBatchItem,
  LaunchSummary
} from '@video-compressor/shared';
import { launchCardState, type LaunchCardState } from './launchPresentation.js';

export function durableItemState(item: DurableLaunchBatchItem): LaunchCardState {
  if (item.admission === 'pending') return 'queued';
  if (item.admission === 'refused') return 'failed';
  if (!item.generation) return 'unknown';
  return launchCardState({
    generation: item.generation,
    generationState: item.generation.state,
    hasResult: false
  });
}
export function durableItemPending(item: DurableLaunchBatchItem): boolean {
  if (item.cancelPending) return true;
  if (item.admission === 'refused') return false;
  const g = item.generation;
  if (!g) return true;
  if (['failed', 'partial', 'canceled'].includes(g.state)) return false;
  if (g.state === 'interrupted')
    return [
      'DRIVE_UNAVAILABLE',
      'RATE_LIMITED',
      'LAUNCH_INTERNAL_ERROR',
      'LAUNCH_RESULT_UNCERTAIN',
      'GROUP_RECONCILING',
      'LEASE_MISMATCH',
      'UNKNOWN',
      'PROCESS_RESULT_UNCERTAIN'
    ].includes(g.errorCode ?? 'UNKNOWN');
  if (g.state === 'succeeded')
    return Boolean(g.videoGeneration && !['ready', 'canceled'].includes(g.videoGeneration.state));
  return true;
}
export const durableBatchPending = (batch: DurableLaunchBatch) =>
  batch.items.some(durableItemPending);

export function durableCardValue(
  value: LaunchSummary,
  item?: DurableLaunchBatchItem
): LaunchSummary {
  if (
    !item?.generation ||
    (value.generation && value.generation.id !== item.generationId) ||
    (!value.generation && value.version !== item.expectedVersion) ||
    (value.generation &&
      BigInt(value.generation.stateVersion) > BigInt(item.generation.stateVersion))
  )
    return value;
  return { ...value, generation: item.generation, generationState: item.generation.state };
}

/** Late list/read replies cannot undo a canonical generation or cancellation receipt. */
export function mergeDurableBatch(
  old: DurableLaunchBatch | undefined,
  next: DurableLaunchBatch
): DurableLaunchBatch {
  if (!old || old.id !== next.id) return next;
  return {
    ...next,
    cancelRequestedAt: next.cancelRequestedAt ?? old.cancelRequestedAt,
    items: next.items.map(item => {
      const previous = old.items.find(
        row => row.launchId === item.launchId && row.childRequestKey === item.childRequestKey
      );
      // Admission settles once. A slower history read must not put an already
      // accepted or refused child back into source preparation.
      if (previous && previous.admission !== 'pending' && item.admission === 'pending')
        return previous;
      let generation = item.generation;
      if (
        previous?.generation &&
        generation &&
        previous.generation.id === generation.id &&
        BigInt(previous.generation.stateVersion) > BigInt(generation.stateVersion)
      )
        generation = previous.generation;
      const before = previous?.generation?.videoGeneration;
      const after = item.generation?.videoGeneration;
      if (generation && before && after && before.setId === after.setId) {
        // Video checkpoints advance independently of the parent generation.
        // Registered outputs and terminal set states cannot be undone by a late read.
        generation = {
          ...generation,
          videoGeneration: {
            ...after,
            registeredCount: Math.max(before.registeredCount, after.registeredCount),
            state: ['ready', 'canceled'].includes(before.state) ? before.state : after.state
          }
        };
      }
      return generation === item.generation ? item : { ...item, generation };
    })
  };
}
