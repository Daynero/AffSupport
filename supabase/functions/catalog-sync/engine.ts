import { classifyMaterial } from '../../../packages/shared/dist/team/material-category.js';
import type { DriveFileMetadata } from '../_shared/drive.ts';

export type CatalogSyncPhase = 'initial_scan' | 'change_replay' | 'incremental' | 'reconcile';

export interface CatalogSyncJob {
  jobId: string;
  connectionId: string;
  phase: CatalogSyncPhase;
  rootFolderId: string;
  driveId: string | null;
  folderQueue: string[];
  pageToken: string | null;
  changeToken: string | null;
  attempts: number;
  /** Child folders found on earlier pages of the folder currently being scanned. */
  discoveredFolderIds?: string[];
  /**
   * Every picked folder of the connection (011). Ancestry proofs accept any of
   * them; a change to one of them is a change to the space's storage, not a
   * material.
   */
  selectionFolderIds?: string[];
}

export interface CatalogDriveChange {
  fileId: string;
  removed: boolean;
  file: DriveFileMetadata | null;
}

export interface CatalogSyncDependencies {
  listChildren: (input: {
    parentId: string;
    pageToken: string | null;
    driveId: string | null;
  }) => Promise<{ files: DriveFileMetadata[]; nextPageToken: string | null }>;
  listChanges: (input: { pageToken: string; driveId: string | null }) => Promise<{
    changes: CatalogDriveChange[];
    nextPageToken: string | null;
    newStartPageToken: string | null;
  }>;
  getFile: (fileId: string) => Promise<DriveFileMetadata>;
  isWithinRoot: (file: DriveFileMetadata, rootFolderId: string) => Promise<boolean>;
  isHiddenSystemFile: (file: DriveFileMetadata, rootFolderId: string) => Promise<boolean>;
  invalidateLandingRenders: (input: {
    jobId: string;
    connectionId: string;
    fileIds: string[];
  }) => Promise<unknown>;
  upsertFiles: (input: {
    jobId: string;
    connectionId: string;
    parentId: string | null;
    files: DriveFileMetadata[];
  }) => Promise<unknown>;
  tombstoneFiles: (input: {
    jobId: string;
    connectionId: string;
    items: Array<{
      fileId: string;
      lifecycle: 'trashed' | 'missing';
      reason?: 'removed' | 'out_of_root';
    }>;
    preserveProvenance: true;
  }) => Promise<unknown>;
  requeueTranscripts: (input: {
    jobId: string;
    connectionId: string;
    files: DriveFileMetadata[];
  }) => Promise<unknown>;
  checkpoint: (input: {
    jobId: string;
    connectionId: string;
    phase: CatalogSyncPhase;
    folderQueue: string[];
    discoveredFolderIds: string[];
    pageToken: string | null;
    changeToken: string | null;
  }) => Promise<unknown>;
  complete: (input: {
    jobId: string;
    connectionId: string;
    changeToken: string | null;
    nextPhase: 'incremental' | 'reconcile';
  }) => Promise<unknown>;
  reconcile: (input: {
    jobId: string;
    connectionId: string;
    rootFolderId: string;
    driveId: string | null;
  }) => Promise<unknown>;
  /** The last page of a folder landed: it is openable from now on (011). */
  markFolderIndexed: (input: {
    jobId: string;
    connectionId: string;
    folderId: string;
  }) => Promise<unknown>;
  /** The root itself was renamed, moved, trashed or removed (011). */
  markRootState: (input: {
    jobId: string;
    connectionId: string;
    state: 'connected' | 'root_missing';
    rootName: string | null;
  }) => Promise<unknown>;
  /** A change page completed against the provider; the chip shows the time (011). */
  touchReconciled: (input: { jobId: string; connectionId: string }) => Promise<unknown>;
}

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const HIDDEN_SYSTEM_FOLDER = '.soty';

function fileExtension(name: string): string | null {
  const index = name.lastIndexOf('.');
  return index > 0 && index < name.length - 1 ? name.slice(index + 1) : null;
}

function transcriptFiles(files: DriveFileMetadata[]): DriveFileMetadata[] {
  return files.filter(file => {
    const kind = file.shortcutTargetId
      ? ('shortcut' as const)
      : file.mimeType === FOLDER_MIME_TYPE
        ? ('folder' as const)
        : ('file' as const);
    return (
      classifyMaterial({
        kind,
        mimeType: file.mimeType,
        fileExtension: fileExtension(file.name),
        sourceVersion: file.version
      }).category === 'transcript'
    );
  });
}

async function persistActiveFiles(
  job: CatalogSyncJob,
  dependencies: CatalogSyncDependencies,
  files: DriveFileMetadata[],
  parentId: string | null
): Promise<void> {
  if (files.length === 0) return;
  await dependencies.upsertFiles({
    jobId: job.jobId,
    connectionId: job.connectionId,
    parentId,
    files
  });
  const transcripts = transcriptFiles(files);
  if (transcripts.length > 0) {
    await dependencies.requeueTranscripts({
      jobId: job.jobId,
      connectionId: job.connectionId,
      files: transcripts
    });
  }
}

async function runInitialScan(
  job: CatalogSyncJob,
  dependencies: CatalogSyncDependencies
): Promise<{ phase: CatalogSyncPhase; processed: number }> {
  const parentId = job.folderQueue[0] ?? job.rootFolderId;
  const page = await dependencies.listChildren({
    parentId,
    pageToken: job.pageToken,
    driveId: job.driveId
  });
  const visibleFiles = page.files.filter(file => file.name !== HIDDEN_SYSTEM_FOLDER);
  await persistActiveFiles(job, dependencies, visibleFiles, parentId);

  const newFolders = visibleFiles
    .filter(file => !file.trashed && file.mimeType === FOLDER_MIME_TYPE && !file.shortcutTargetId)
    .map(file => file.id);
  const discovered = [...new Set([...(job.discoveredFolderIds ?? []), ...newFolders])];
  const remaining = job.folderQueue.length > 0 ? job.folderQueue.slice(1) : [];

  if (page.nextPageToken) {
    await dependencies.checkpoint({
      jobId: job.jobId,
      connectionId: job.connectionId,
      phase: 'initial_scan',
      folderQueue: [parentId, ...remaining],
      discoveredFolderIds: discovered,
      pageToken: page.nextPageToken,
      changeToken: job.changeToken
    });
    return { phase: 'initial_scan', processed: page.files.length };
  }

  // No further page for this folder: everything under it is in the catalog.
  await dependencies.markFolderIndexed({
    jobId: job.jobId,
    connectionId: job.connectionId,
    folderId: parentId
  });

  const folderQueue = [...remaining, ...discovered];
  if (folderQueue.length > 0) {
    await dependencies.checkpoint({
      jobId: job.jobId,
      connectionId: job.connectionId,
      phase: 'initial_scan',
      folderQueue,
      discoveredFolderIds: [],
      pageToken: null,
      changeToken: job.changeToken
    });
    return { phase: 'initial_scan', processed: page.files.length };
  }

  await dependencies.checkpoint({
    jobId: job.jobId,
    connectionId: job.connectionId,
    phase: 'change_replay',
    folderQueue: [],
    discoveredFolderIds: [],
    pageToken: job.changeToken,
    changeToken: job.changeToken
  });
  return { phase: 'change_replay', processed: page.files.length };
}

async function runChanges(
  job: CatalogSyncJob,
  dependencies: CatalogSyncDependencies
): Promise<{ phase: CatalogSyncPhase; processed: number }> {
  const token = job.pageToken ?? job.changeToken;
  if (!token) throw new Error('CATALOG_CHANGE_TOKEN_REQUIRED');
  const page = await dependencies.listChanges({ pageToken: token, driveId: job.driveId });
  const active: DriveFileMetadata[] = [];
  const tombstones: Array<{
    fileId: string;
    lifecycle: 'trashed' | 'missing';
    reason?: 'removed' | 'out_of_root';
  }> = [];

  if (page.changes.length > 0) {
    await dependencies.invalidateLandingRenders({
      jobId: job.jobId,
      connectionId: job.connectionId,
      fileIds: [...new Set(page.changes.map(change => change.fileId))]
    });
  }

  /*
   * Where each change belongs, several at a time (024): every one of these is a walk up the file's
   * parents in Drive, and a hundred of them in a row outlasted the job's lease. The answers are
   * gathered in the page's own order, so what is written afterwards does not depend on which walk
   * came back first.
   */
  type Placed =
    | { kind: 'skip' }
    | { kind: 'active'; file: DriveFileMetadata }
    | {
        kind: 'tombstone';
        item: {
          fileId: string;
          lifecycle: 'trashed' | 'missing';
          reason?: 'removed' | 'out_of_root';
        };
      };
  const place = async (change: (typeof page.changes)[number]): Promise<Placed> => {
    if (change.fileId === job.rootFolderId) {
      // The root is not a material. Trashed or gone, the space says so and
      // keeps everything; renamed or moved, the space follows (FR-006).
      const missing = change.removed || !change.file || change.file.trashed;
      await dependencies.markRootState({
        jobId: job.jobId,
        connectionId: job.connectionId,
        state: missing ? 'root_missing' : 'connected',
        rootName: missing ? null : change.file!.name
      });
      return { kind: 'skip' };
    }
    if (job.selectionFolderIds?.includes(change.fileId)) {
      // A picked folder other than the root: its descendants stay cataloged
      // until reconciliation proves otherwise; the folder row itself is kept.
      return { kind: 'skip' };
    }
    if (change.removed || !change.file) {
      return {
        kind: 'tombstone',
        item: { fileId: change.fileId, lifecycle: 'missing', reason: 'removed' }
      };
    }
    if (change.file.trashed) {
      return { kind: 'tombstone', item: { fileId: change.fileId, lifecycle: 'trashed' } };
    }
    if (await dependencies.isHiddenSystemFile(change.file, job.rootFolderId)) {
      return {
        kind: 'tombstone',
        item: { fileId: change.fileId, lifecycle: 'missing', reason: 'out_of_root' }
      };
    }
    /* Moved somewhere Soty does not watch: the file is alive, so its companions are left
       alone (024, US24). Only a deletion lets the cleanup touch them. */
    if (!(await dependencies.isWithinRoot(change.file, job.rootFolderId))) {
      return {
        kind: 'tombstone',
        item: { fileId: change.fileId, lifecycle: 'missing', reason: 'out_of_root' }
      };
    }
    return { kind: 'active', file: change.file };
  };
  for (const placed of await inOrder(page.changes, CHANGE_WALKS_AT_ONCE, place)) {
    if (placed.kind === 'active') active.push(placed.file);
    else if (placed.kind === 'tombstone') tombstones.push(placed.item);
  }

  if (tombstones.length > 0) {
    await dependencies.tombstoneFiles({
      jobId: job.jobId,
      connectionId: job.connectionId,
      items: tombstones,
      preserveProvenance: true
    });
  }
  await persistActiveFiles(job, dependencies, active, null);

  if (page.nextPageToken) {
    await dependencies.checkpoint({
      jobId: job.jobId,
      connectionId: job.connectionId,
      phase: job.phase,
      folderQueue: [],
      discoveredFolderIds: [],
      pageToken: page.nextPageToken,
      changeToken: job.changeToken
    });
    return { phase: job.phase, processed: page.changes.length };
  }

  const committedToken = page.newStartPageToken ?? job.changeToken;
  await dependencies.touchReconciled({ jobId: job.jobId, connectionId: job.connectionId });
  await dependencies.complete({
    jobId: job.jobId,
    connectionId: job.connectionId,
    changeToken: committedToken,
    nextPhase: 'incremental'
  });
  return { phase: 'incremental', processed: page.changes.length };
}

/** Few enough that Drive does not throttle the space, enough that a page takes seconds. */
const CHANGE_WALKS_AT_ONCE = 6;

/** `items` mapped a few at a time, answers in the order of the questions. */
async function inOrder<Item, Answer>(
  items: readonly Item[],
  atOnce: number,
  answer: (item: Item) => Promise<Answer>
): Promise<Answer[]> {
  const answers = new Array<Answer>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(atOnce, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      answers[index] = await answer(items[index]!);
    }
  });
  await Promise.all(lanes);
  return answers;
}

type CheckpointInput = Parameters<CatalogSyncDependencies['checkpoint']>[0];

export class CatalogLeaseLostError extends Error {
  constructor() {
    super('CATALOG_LEASE_LOST');
  }
}

export interface CatalogSyncRunOptions {
  /** Wall-clock budget for one scheduler invocation, in milliseconds. */
  budgetMs: number;
  now?: () => number;
}

/**
 * Slices of one job, back to back, until the budget is spent or the walk hands
 * over to the change feed. One page per scheduler tick — the shape before —
 * made a fifty-folder tree an hour's wait, because the tick is a minute
 * (findings I3). Each slice still checkpoints before the next begins, so a
 * worker stopped mid-budget resumes exactly where the last checkpoint left it.
 */
export async function runCatalogSyncJob(
  job: CatalogSyncJob,
  dependencies: CatalogSyncDependencies,
  options: CatalogSyncRunOptions
): Promise<{ phase: CatalogSyncPhase; processed: number; slices: number; yielded: boolean }> {
  const now = options.now ?? Date.now;
  const started = now();
  let current = job;
  let processed = 0;
  let slices = 0;
  let phase = job.phase;
  // Held in an object: the closure below writes it, and a plain `let` would be
  // narrowed to `null` by the assignment before the loop.
  const seen: { checkpoint: CheckpointInput | null } = { checkpoint: null };
  // Read through a call so the assignment above is not narrowed to `null`.
  const lastCheckpoint = (): CheckpointInput | null => seen.checkpoint;
  const observed: CatalogSyncDependencies = {
    ...dependencies,
    checkpoint: async input => {
      const saved = await dependencies.checkpoint(input);
      if (saved === false) throw new CatalogLeaseLostError();
      seen.checkpoint = input;
      return saved;
    }
  };
  for (;;) {
    seen.checkpoint = null;
    const result = await runCatalogSyncSlice(current, observed);
    slices += 1;
    processed += result.processed;
    phase = result.phase;
    const checkpoint = lastCheckpoint();
    if (result.phase !== 'initial_scan' || !checkpoint) break;
    if (now() - started >= options.budgetMs) break;
    current = {
      ...current,
      phase: 'initial_scan',
      folderQueue: checkpoint.folderQueue,
      pageToken: checkpoint.pageToken,
      changeToken: checkpoint.changeToken,
      discoveredFolderIds: checkpoint.discoveredFolderIds
    };
  }
  return { phase, processed, slices, yielded: lastCheckpoint() !== null };
}

export async function runCatalogSyncSlice(
  job: CatalogSyncJob,
  dependencies: CatalogSyncDependencies
): Promise<{ phase: CatalogSyncPhase; processed: number }> {
  if (job.phase === 'initial_scan') return runInitialScan(job, dependencies);
  if (job.phase === 'change_replay' || job.phase === 'incremental') {
    return runChanges(job, dependencies);
  }
  await dependencies.reconcile({
    jobId: job.jobId,
    connectionId: job.connectionId,
    rootFolderId: job.rootFolderId,
    driveId: job.driveId
  });
  await dependencies.touchReconciled({ jobId: job.jobId, connectionId: job.connectionId });
  await dependencies.complete({
    jobId: job.jobId,
    connectionId: job.connectionId,
    changeToken: job.changeToken,
    nextPhase: 'incremental'
  });
  return { phase: 'incremental', processed: 0 };
}

export function catalogRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, Math.min(20, Math.trunc(attempt) - 1));
  const base = Math.min(15 * 60_000, 1_000 * 2 ** exponent);
  const jitter = Math.max(0, Math.min(1, random())) * Math.min(base * 0.25, 30_000);
  return Math.min(15 * 60_000, Math.round(base + jitter));
}
