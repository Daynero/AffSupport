import { launchCardState, type LaunchCardState } from './launchPresentation.js';
import { LAUNCH_BATCH_MAX_ITEMS, type LaunchSummary } from '@video-compressor/shared';
export const LAUNCH_BATCH_CONCURRENCY = 2;
export type BatchItemState =
  | 'queued'
  | 'dispatching'
  | 'accepted'
  | 'completed'
  | 'blocked'
  | 'uncertain'
  | 'deferred'
  | 'partial'
  | 'canceled'
  | 'stopped';
export const batchPending = (state: BatchItemState) =>
  ['queued', 'dispatching', 'accepted', 'uncertain', 'deferred'].includes(state);
export interface LaunchBatchItem {
  source: LaunchSummary;
  state: BatchItemState;
  flowId: string;
}
export function batchEligible(item: LaunchSummary): boolean {
  return item.hasResult === false && item.generationState === null;
}
/** Locality only: native verified content and recipe remain cache authority. */
export function planLaunchBatch(items: readonly LaunchSummary[]): LaunchBatchItem[] {
  return [...new Map(items.filter(batchEligible).map(item => [item.id, item])).values()]
    .slice(0, LAUNCH_BATCH_MAX_ITEMS)
    .sort((a, b) => (a.sourceMaterialId ?? a.id).localeCompare(b.sourceMaterialId ?? b.id))
    .map(source => ({ source, state: 'queued', flowId: crypto.randomUUID() }));
}
export function admitBatchItems(
  items: readonly LaunchBatchItem[],
  stopped: boolean
): LaunchBatchItem[] {
  let slots =
    LAUNCH_BATCH_CONCURRENCY -
    items.filter(i => ['dispatching', 'accepted', 'uncertain'].includes(i.state)).length;
  return items.map(item =>
    item.state !== 'queued'
      ? item
      : stopped
        ? { ...item, state: 'stopped' }
        : slots-- > 0
          ? { ...item, state: 'dispatching' }
          : item
  );
}

/** Local admission receipts bridge a stale list until its authoritative generation arrives. */
export function batchCardState(
  value: LaunchSummary,
  item: LaunchBatchItem | undefined
): LaunchCardState | undefined {
  if (!item || item.state === 'stopped') return undefined;
  if (value.generation?.requestKey && value.generation.requestKey !== item.flowId) return undefined;
  if (item.state === 'queued') return 'queued';
  if (item.state === 'dispatching') return 'running';
  if (item.state === 'uncertain' || item.state === 'deferred') return 'unknown';
  if (launchCardState(value) !== 'draft') return undefined;
  if (item.state === 'partial' || item.state === 'canceled') return item.state;
  return item.state === 'accepted' ? 'running' : item.state === 'completed' ? 'ready' : 'failed';
}
