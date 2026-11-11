import type { CatalogVideoForegroundProgressExecutor } from './catalog-video-foreground.js';
import { isCatalogCommandUuid } from './catalog-command.js';

/** Registered outputs are preparation progress, never proof of sheet publication. */
export interface CatalogVideoRowProgress {
  setId: string;
  requestedCount: number;
  registeredCount: number;
  state: 'accepted' | 'preparing' | 'ready' | 'cancel_requested' | 'canceled' | 'unknown';
  activeChildOperationId?: string | null;
  executor?: CatalogVideoForegroundProgressExecutor;
  /** Why an accepted variant round has not started: the manager says it instead of a bare "0 of N". */
  waitReason?: CatalogVideoRowWaitReason;
  /**
   * This computer's background work exists but has not picked the round up
   * since it was accepted (1.4.3): the manager offers to restart it instead of
   * an endless "waiting for video preparation".
   */
  backgroundStalled?: true;
}

export const CATALOG_VIDEO_ROW_WAIT_REASONS = [
  'AGENT_REQUIRED',
  'AGENT_ID_CONFLICT',
  'PERMISSION_DENIED',
  'SOURCE_CHANGED',
  'RESTITCH_INVALID',
  'PROCESS_RESULT_UNCERTAIN'
] as const;
export type CatalogVideoRowWaitReason = (typeof CATALOG_VIDEO_ROW_WAIT_REASONS)[number];

export function parseCatalogVideoRowProgress(value: unknown): CatalogVideoRowProgress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    !isCatalogCommandUuid(row.setId) ||
    !Number.isSafeInteger(row.requestedCount) ||
    Number(row.requestedCount) < 1 ||
    Number(row.requestedCount) > 400 ||
    !Number.isSafeInteger(row.registeredCount) ||
    Number(row.registeredCount) < 0 ||
    Number(row.registeredCount) > Number(row.requestedCount) ||
    !['accepted', 'preparing', 'ready', 'cancel_requested', 'canceled', 'unknown'].includes(
      String(row.state)
    ) ||
    (row.state === 'ready' && row.registeredCount !== row.requestedCount) ||
    (row.activeChildOperationId != null && !isCatalogCommandUuid(row.activeChildOperationId)) ||
    (row.waitReason !== undefined &&
      !CATALOG_VIDEO_ROW_WAIT_REASONS.includes(row.waitReason as CatalogVideoRowWaitReason)) ||
    (row.executor !== undefined &&
      (!row.executor ||
        typeof row.executor !== 'object' ||
        Array.isArray(row.executor) ||
        (row.executor as Record<string, unknown>).mode !== 'paired_session' ||
        !isCatalogCommandUuid((row.executor as Record<string, unknown>).enrollmentId) ||
        !isCatalogCommandUuid((row.executor as Record<string, unknown>).nativeInstanceId)))
  )
    return null;
  return {
    ...(row.executor === undefined
      ? {}
      : {
          executor: {
            mode: 'paired_session' as const,
            enrollmentId: (row.executor as Record<string, unknown>).enrollmentId as string,
            nativeInstanceId: (row.executor as Record<string, unknown>).nativeInstanceId as string
          }
        }),
    setId: row.setId,
    requestedCount: Number(row.requestedCount),
    registeredCount: Number(row.registeredCount),
    state: row.state as CatalogVideoRowProgress['state'],
    ...(row.activeChildOperationId !== undefined
      ? { activeChildOperationId: row.activeChildOperationId as string | null }
      : {}),
    ...(row.waitReason !== undefined
      ? { waitReason: row.waitReason as CatalogVideoRowWaitReason }
      : {}),
    // Anything but `true` is ignored rather than refused: it is advisory only.
    ...(row.backgroundStalled === true ? { backgroundStalled: true as const } : {})
  };
}
