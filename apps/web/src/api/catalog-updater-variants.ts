import {
  isCatalogForegroundExecutorSnapshot,
  type CatalogForegroundExecutorSnapshot
} from './catalog-video-foreground';
import {
  TEAM_ERROR_CODES,
  type TeamErrorCode,
  type CatalogPublicationSnapshot,
  isCatalogCommandUuid
} from '@video-compressor/shared';
export interface CatalogUpdaterVariantsSnapshot {
  requestId: string;
  executor?: CatalogForegroundExecutorSnapshot;
  setId: string;
  state: 'accepted' | 'preparing' | 'ready' | 'cancel_requested' | 'canceled' | 'unknown';
  requestedCount: number;
  registeredCount: number;
  recipeRevision: number;
  profileVersion: number;
  serverNow: number;
  lastProvenStage?: 'admitted' | 'source_proven' | 'set_admitted';
  failureCode?: TeamErrorCode | null;
  publicationState?: NonNullable<CatalogPublicationSnapshot['job']>['state'] | null;
  publicationBlockedReason?: NonNullable<CatalogPublicationSnapshot['job']>['blockedReason'];
}
export function isCatalogUpdaterVariantsSnapshot(
  value: unknown
): value is CatalogUpdaterVariantsSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    (row.executor === undefined || isCatalogForegroundExecutorSnapshot(row.executor)) &&
    isCatalogCommandUuid(row.requestId) &&
    isCatalogCommandUuid(row.setId) &&
    ['accepted', 'preparing', 'ready', 'cancel_requested', 'canceled', 'unknown'].includes(
      String(row.state)
    ) &&
    Number.isSafeInteger(row.requestedCount) &&
    Number(row.requestedCount) >= 1 &&
    Number(row.requestedCount) <= 400 &&
    Number.isSafeInteger(row.registeredCount) &&
    Number(row.registeredCount) >= 0 &&
    Number(row.registeredCount) <= Number(row.requestedCount) &&
    (row.state !== 'ready' || row.registeredCount === row.requestedCount) &&
    Number.isSafeInteger(row.recipeRevision) &&
    Number(row.recipeRevision) >= 1 &&
    Number.isSafeInteger(row.profileVersion) &&
    Number(row.profileVersion) >= 1 &&
    (row.lastProvenStage === undefined ||
      ['admitted', 'source_proven', 'set_admitted'].includes(String(row.lastProvenStage))) &&
    (row.failureCode == null ||
      (TEAM_ERROR_CODES as readonly unknown[]).includes(row.failureCode)) &&
    (row.publicationState == null ||
      [
        'waiting',
        'preparing',
        'applying',
        'verifying',
        'retry_wait',
        'unknown',
        'blocked',
        'cancel_requested',
        'published',
        'superseded',
        'held'
      ].includes(String(row.publicationState))) &&
    (row.publicationBlockedReason == null ||
      [
        'writer_unsupported',
        'legacy_adoption_required',
        'target_unavailable',
        'job_blocked',
        'stale_job',
        'clock_unavailable',
        'invalid_due'
      ].includes(String(row.publicationBlockedReason))) &&
    Number.isSafeInteger(row.serverNow) &&
    Number(row.serverNow) > 0
  );
}
