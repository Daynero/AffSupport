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
  /**
   * Why an accepted variant round has not started: the manager says it instead of a bare "0 of N".
   * Usually one of CATALOG_VIDEO_ROW_WAIT_REASONS; a code a newer server adds is kept as it came
   * (072): the manager says it in general words instead of losing the whole row's progress.
   */
  waitReason?: CatalogVideoRowWaitReason | (string & {});
  /** The raw code behind a waiting round, when the server reads one it may not name (072, П1). */
  waitCode?: string;
  /**
   * This computer's background work exists but has not picked the round up
   * since it was accepted (1.4.3): the manager offers to restart it instead of
   * an endless "waiting for video preparation".
   */
  backgroundStalled?: true;
  /** 062: with several videos, the first creative whose restitch did not settle. */
  failedOrdinal?: number;
  /**
   * 057 T119: the variation sets of an R2 space's Launch (one per video), which the page hands to
   * the member's open Soty itself. A Drive generation never has them.
   */
  spaceSets?: CatalogVideoSpaceSet[];
}

export interface CatalogVideoSpaceSet {
  setId: string;
  requestedCount: number;
  registeredCount: number;
}

function spaceSets(value: unknown): CatalogVideoSpaceSet[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 400) return null;
  const sets: CatalogVideoSpaceSet[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const set = entry as Record<string, unknown>;
    if (
      !isCatalogCommandUuid(set.setId) ||
      !Number.isSafeInteger(set.requestedCount) ||
      Number(set.requestedCount) < 1 ||
      Number(set.requestedCount) > 400 ||
      !Number.isSafeInteger(set.registeredCount) ||
      Number(set.registeredCount) < 0 ||
      Number(set.registeredCount) > Number(set.requestedCount)
    )
      return null;
    sets.push({
      setId: set.setId,
      requestedCount: Number(set.requestedCount),
      registeredCount: Number(set.registeredCount)
    });
  }
  return sets;
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

function isWaitCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z_]{1,63}$/u.test(value);
}

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
    // Advisory: an unknown code is kept, a malformed one dropped — never the whole progress (072).
    ...(isWaitCode(row.waitReason) ? { waitReason: row.waitReason } : {}),
    ...(isWaitCode(row.waitCode) ? { waitCode: row.waitCode } : {}),
    // Anything but `true` is ignored rather than refused: it is advisory only.
    ...(row.backgroundStalled === true ? { backgroundStalled: true as const } : {}),
    // Advisory as well: an out-of-range ordinal is dropped, not refused.
    ...(Number.isSafeInteger(row.failedOrdinal) &&
    Number(row.failedOrdinal) >= 0 &&
    Number(row.failedOrdinal) < 400
      ? { failedOrdinal: Number(row.failedOrdinal) }
      : {}),
    // 057 T119: advisory too: malformed sets are dropped (the page then hands nothing over).
    ...(row.spaceSets !== undefined && spaceSets(row.spaceSets)
      ? { spaceSets: spaceSets(row.spaceSets)! }
      : {})
  };
}
