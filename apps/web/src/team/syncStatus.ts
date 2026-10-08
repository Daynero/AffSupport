/**
 * The status of one manual sync job as the web reads it (028, release B).
 *
 * This lives in the web app on purpose: the agent never consumes it, and a
 * change to `packages/shared` would turn a web-only deploy into a full
 * release. The shape mirrors `get_team_folder_sync_status`; anything the
 * server adds that is not named here is refused at the boundary, so a
 * private queue field can never leak into the screen by accident.
 */

export const FOLDER_SYNC_STATES = [
  'queued',
  'running',
  'retry_wait',
  'blocked',
  'canceling',
  'canceled',
  'succeeded',
  'failed'
] as const;
export type FolderSyncState = (typeof FOLDER_SYNC_STATES)[number];

export const FOLDER_SYNC_PHASES = ['listing', 'reconciling', 'replaying_changes', 'done'] as const;
export type FolderSyncPhase = (typeof FOLDER_SYNC_PHASES)[number];

export const FOLDER_SYNC_BLOCKED_REASONS = [
  'canonical_failed',
  'canonical_retrying',
  'needs_reauth'
] as const;
export type FolderSyncBlockedReason = (typeof FOLDER_SYNC_BLOCKED_REASONS)[number];

export const FOLDER_SYNC_COVERAGE = [
  'complete',
  'partial',
  'permission_limited',
  'unknown'
] as const;
export type FolderSyncCoverage = (typeof FOLDER_SYNC_COVERAGE)[number];

export interface FolderSyncStatus {
  jobId: string;
  requestId: string | null;
  /** `__root__` for the whole space. */
  scopeFolderId: string;
  state: FolderSyncState;
  phase: FolderSyncPhase;
  blockedReason: FolderSyncBlockedReason | null;
  errorCode: string | null;
  errorDetail: string | null;
  nextAttemptAt: string | null;
  startedAt: string | null;
  lastProgressAt: string | null;
  scanCompletedAt: string | null;
  completedAt: string | null;
  filesListed: number;
  filesAdded: number;
  filesUpdated: number;
  filesRemoved: number;
  itemsUnavailable: number;
  foldersDone: number;
  pendingFolders: number | null;
  coverage: FolderSyncCoverage;
  /** Grows with every committed change; the screen refreshes when it moves. */
  progressRevision: number;
  cancelable: boolean;
  /** How many other people's requests share this job. */
  sharedWith: number;
}

export const TERMINAL_SYNC_STATES: ReadonlySet<FolderSyncState> = new Set([
  'succeeded',
  'failed',
  'canceled'
]);

const KNOWN_KEYS = new Set([
  'jobId',
  'requestId',
  'scopeFolderId',
  'state',
  'phase',
  'blockedReason',
  'errorCode',
  'errorDetail',
  'nextAttemptAt',
  'startedAt',
  'lastProgressAt',
  'scanCompletedAt',
  'completedAt',
  'filesListed',
  'filesAdded',
  'filesUpdated',
  'filesRemoved',
  'itemsUnavailable',
  'foldersDone',
  'pendingFolders',
  'coverage',
  'progressRevision',
  'cancelable',
  'sharedWith',
  // Kept by the server for the older contract; read as aliases, never surfaced.
  'discoveredFiles',
  'completedFolders'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const nullableText = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined =>
  values.find(candidate => candidate === value);

export function parseFolderSyncStatus(value: unknown): FolderSyncStatus | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some(key => !KNOWN_KEYS.has(key))) return null;
  const state = oneOf(FOLDER_SYNC_STATES, value.state);
  const phase = oneOf(FOLDER_SYNC_PHASES, value.phase);
  const blockedReason =
    value.blockedReason === null || value.blockedReason === undefined
      ? null
      : oneOf(FOLDER_SYNC_BLOCKED_REASONS, value.blockedReason);
  const coverage = oneOf(FOLDER_SYNC_COVERAGE, value.coverage ?? 'unknown');
  const counters = {
    filesListed: value.filesListed ?? value.discoveredFiles ?? 0,
    filesAdded: value.filesAdded ?? 0,
    filesUpdated: value.filesUpdated ?? 0,
    filesRemoved: value.filesRemoved ?? 0,
    itemsUnavailable: value.itemsUnavailable ?? 0,
    foldersDone: value.foldersDone ?? value.completedFolders ?? 0,
    progressRevision: value.progressRevision ?? 0,
    sharedWith: value.sharedWith ?? 0
  };
  if (
    !state ||
    !phase ||
    blockedReason === undefined ||
    !coverage ||
    typeof value.jobId !== 'string' ||
    !value.jobId ||
    !nullableText(value.requestId ?? null) ||
    typeof value.scopeFolderId !== 'string' ||
    !value.scopeFolderId ||
    !nullableText(value.errorCode ?? null) ||
    !nullableText(value.errorDetail ?? null) ||
    !nullableText(value.nextAttemptAt ?? null) ||
    !nullableText(value.startedAt ?? null) ||
    !nullableText(value.lastProgressAt ?? null) ||
    !nullableText(value.scanCompletedAt ?? null) ||
    !nullableText(value.completedAt ?? null) ||
    !Object.values(counters).every(count) ||
    !(
      value.pendingFolders === null ||
      value.pendingFolders === undefined ||
      count(value.pendingFolders)
    ) ||
    !(value.cancelable === undefined || typeof value.cancelable === 'boolean')
  ) {
    return null;
  }
  return {
    jobId: value.jobId,
    requestId: (value.requestId as string | null | undefined) ?? null,
    scopeFolderId: value.scopeFolderId,
    state,
    phase,
    blockedReason,
    errorCode: (value.errorCode as string | null | undefined) ?? null,
    errorDetail: (value.errorDetail as string | null | undefined) ?? null,
    nextAttemptAt: (value.nextAttemptAt as string | null | undefined) ?? null,
    startedAt: (value.startedAt as string | null | undefined) ?? null,
    lastProgressAt: (value.lastProgressAt as string | null | undefined) ?? null,
    scanCompletedAt: (value.scanCompletedAt as string | null | undefined) ?? null,
    completedAt: (value.completedAt as string | null | undefined) ?? null,
    ...(counters as {
      filesListed: number;
      filesAdded: number;
      filesUpdated: number;
      filesRemoved: number;
      itemsUnavailable: number;
      foldersDone: number;
      progressRevision: number;
      sharedWith: number;
    }),
    pendingFolders: (value.pendingFolders as number | null | undefined) ?? null,
    coverage,
    cancelable: value.cancelable === true
  };
}

/** What the person is told once the job is over: counts, not adjectives. */
export type FolderSyncSummary =
  | { kind: 'changes'; added: number; updated: number; removed: number; unavailable: number }
  | { kind: 'none'; unavailable: number }
  | { kind: 'partial'; added: number; updated: number; removed: number; unavailable: number };

export function summarize(status: FolderSyncStatus): FolderSyncSummary {
  const changed = status.filesAdded + status.filesUpdated + status.filesRemoved;
  const partial =
    status.itemsUnavailable > 0 ||
    status.coverage === 'partial' ||
    status.coverage === 'permission_limited';
  if (partial) {
    return {
      kind: 'partial',
      added: status.filesAdded,
      updated: status.filesUpdated,
      removed: status.filesRemoved,
      unavailable: status.itemsUnavailable
    };
  }
  if (changed === 0) return { kind: 'none', unavailable: 0 };
  return {
    kind: 'changes',
    added: status.filesAdded,
    updated: status.filesUpdated,
    removed: status.filesRemoved,
    unavailable: 0
  };
}
