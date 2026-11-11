import {
  isCatalogForegroundExecutorSnapshot,
  type CatalogForegroundExecutor,
  type CatalogForegroundExecutorSnapshot
} from './catalog-video-foreground';
import {
  isCatalogCommandUuid,
  type CatalogVideoPublicationRequest
} from '@video-compressor/shared';

export interface CatalogVideoCreationPreferences {
  catalogVideoProtocolVersion: 1;
  restitchEnabled: boolean;
  expectedExecutorId?: string;
  foregroundExecutor?: CatalogForegroundExecutor;
  videoVariationCount: number;
  videoPublication: CatalogVideoPublicationRequest;
  restitchDuration?: {
    finalDurationMode:
      'random-30-40' | 'random-40-50' | 'random-50-60' | 'random-centered' | 'custom';
    customFinalDurationSeconds: number;
    finalDurationRangeSeconds?: readonly [number, number];
  };
}
export interface CatalogVideoPreparingResult {
  outcome: 'preparing_video';
  executor?: CatalogForegroundExecutorSnapshot;
  catalogIntentId: string;
  videoSetId: string;
  requestedCount: number;
  registeredCount: number;
  state: 'preparing' | 'unknown' | 'cancel_requested' | 'canceled';
  /** The agent running this creation stopped heartbeating two minutes ago. */
  agentSilent?: true;
  /**
   * Set by this browser, never by the server: the local agent could not be
   * reached when this read was handed to it. The server state is still current.
   */
  agentUnreachable?: true;
}
/** Pending work is an acknowledged operation, never a completed catalog. */
export function isCatalogVideoPreparingResult(
  value: unknown
): value is CatalogVideoPreparingResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    row.outcome === 'preparing_video' &&
    (row.executor === undefined || isCatalogForegroundExecutorSnapshot(row.executor)) &&
    isCatalogCommandUuid(row.catalogIntentId) &&
    (row.executor === undefined || isCatalogForegroundExecutorSnapshot(row.executor)) &&
    isCatalogCommandUuid(row.videoSetId) &&
    typeof row.requestedCount === 'number' &&
    Number.isInteger(row.requestedCount) &&
    row.requestedCount >= 1 &&
    row.requestedCount <= 400 &&
    typeof row.registeredCount === 'number' &&
    Number.isInteger(row.registeredCount) &&
    row.registeredCount >= 0 &&
    row.registeredCount <= row.requestedCount &&
    ['preparing', 'unknown', 'cancel_requested', 'canceled'].includes(String(row.state)) &&
    (row.agentSilent === undefined || row.agentSilent === true)
  );
}

/** Current output progress is separate from the immutable created catalog receipt. */
export interface CatalogCreatedVideoProgress {
  executor?: CatalogForegroundExecutorSnapshot;
  videoSetId: string;
  requestedCount: number;
  registeredCount: number;
  state: 'preparing' | 'ready' | 'unknown' | 'cancel_requested' | 'canceled';
  catalogVideoCells: 'deferred_blank' | 'assigned';
  providerCas?: 'unsupported';
  publicationHeld?: boolean;
}
export function isCatalogCreatedVideoProgress(
  value: unknown
): value is CatalogCreatedVideoProgress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    (row.executor === undefined || isCatalogForegroundExecutorSnapshot(row.executor)) &&
    isCatalogCommandUuid(row.videoSetId) &&
    Number.isSafeInteger(row.requestedCount) &&
    Number(row.requestedCount) >= 1 &&
    Number(row.requestedCount) <= 400 &&
    Number.isSafeInteger(row.registeredCount) &&
    Number(row.registeredCount) >= 0 &&
    Number(row.registeredCount) <= Number(row.requestedCount) &&
    ['preparing', 'ready', 'unknown', 'cancel_requested', 'canceled'].includes(String(row.state)) &&
    (row.state !== 'ready' || row.registeredCount === row.requestedCount) &&
    ['deferred_blank', 'assigned'].includes(String(row.catalogVideoCells)) &&
    (row.providerCas === undefined || row.providerCas === 'unsupported') &&
    (row.publicationHeld === undefined || typeof row.publicationHeld === 'boolean')
  );
}
