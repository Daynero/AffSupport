import { classifyMaterial } from '../../../packages/shared/dist/team/material-category.js';
import {
  CATALOG_SYNC_BOUNDS,
  type CatalogSyncJobKind,
  type CatalogSyncPhase
} from '../../../packages/shared/dist/team/transport.js';
import type { DriveFileMetadata } from '../_shared/drive.ts';
import { TeamFunctionError } from '../_shared/errors.ts';

export type { CatalogSyncPhase };

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
  jobKind?: CatalogSyncJobKind;
  leaseEpoch?: number;
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
  durableScan?: {
    beginFolder: (
      folderId: string,
      restart: boolean
    ) => Promise<{
      generation: string;
      pageToken: string | null;
    }>;
    frontier: () => Promise<
      Array<{
        folderId: string;
        state: 'queued' | 'listing' | 'reconciling';
      }>
    >;
    commitPage: (input: {
      generation: string;
      expectedPageToken: string | null;
      nextPageToken: string | null;
      files: DriveFileMetadata[];
      complete: boolean;
    }) => Promise<boolean>;
    missingCandidates: (generation: string) => Promise<
      Array<{
        fileId: string;
        expectedRevision: string;
      }>
    >;
    resolveCandidate: (input: {
      generation: string;
      fileId: string;
      expectedRevision: string;
      outcome: 'present' | 'trashed' | 'out_of_root' | 'unavailable';
      file: DriveFileMetadata | null;
    }) => Promise<boolean>;
    finishFolder: (generation: string) => Promise<boolean>;
  };
  listChildren: (input: {
    parentId: string;
    pageToken: string | null;
    driveId: string | null;
  }) => Promise<{
    files: DriveFileMetadata[];
    nextPageToken: string | null;
    incompleteSearch?: boolean;
    invalidEntries?: number;
  }>;
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
  assertLease(
    await dependencies.upsertFiles({
      jobId: job.jobId,
      connectionId: job.connectionId,
      parentId,
      files
    })
  );
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
  // A final page is not proof of complete coverage if Drive or our parser
  // omitted entries. Leave the checkpoint intact for an explicit retry.
  if (page.incompleteSearch || (page.invalidEntries ?? 0) > 0) {
    throw new TeamFunctionError('INVALID_RESPONSE', {
      retryable: true,
      details: { reason: 'INCOMPLETE_LISTING' }
    });
  }
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
  assertLease(
    await dependencies.markFolderIndexed({
      jobId: job.jobId,
      connectionId: job.connectionId,
      folderId: parentId
    })
  );

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

  if (job.jobKind && job.jobKind !== 'incremental') {
    assertLease(
      await dependencies.complete({
        jobId: job.jobId,
        connectionId: job.connectionId,
        changeToken: null,
        nextPhase: 'incremental'
      })
    );
    return { phase: 'change_replay', processed: page.files.length };
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
const CHANGE_WALKS_AT_ONCE = CATALOG_SYNC_BOUNDS.providerConcurrency;

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

function assertLease(result: unknown): void {
  if (result === false) throw new CatalogLeaseLostError();
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
  if (job.jobKind && job.jobKind !== 'incremental' && dependencies.durableScan) {
    return runDurableScanJob(job, dependencies, options);
  }
  const now = options.now ?? Date.now;
  const started = now();
  let current = job;
  let processed = 0;
  let slices = 0;
  let phase: CatalogSyncPhase;
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

async function runDurableScanJob(
  job: CatalogSyncJob,
  dependencies: CatalogSyncDependencies,
  options: CatalogSyncRunOptions
): Promise<{ phase: CatalogSyncPhase; processed: number; slices: number; yielded: boolean }> {
  const scan = dependencies.durableScan!;
  const now = options.now ?? Date.now;
  const started = now();
  let processed = 0;
  let slices = 0;
  // This seeds the initial frontier once in the database; subsequent claims
  // read the same durable queue instead of rehydrating a bounded JSON array.
  await scan.beginFolder(job.folderQueue[0] ?? job.rootFolderId, false);
  for (;;) {
    const [next] = await scan.frontier();
    if (!next) {
      assertLease(
        await dependencies.complete({
          jobId: job.jobId,
          connectionId: job.connectionId,
          changeToken: null,
          nextPhase: 'incremental'
        })
      );
      return { phase: 'change_replay', processed, slices, yielded: false };
    }
    const folder = await scan.beginFolder(next.folderId, false);
    if (next.state === 'reconciling') {
      const candidates = await scan.missingCandidates(folder.generation);
      let unavailable = false;
      let incompleteListing = false;
      for (const candidate of candidates) {
        let file: DriveFileMetadata | null = null;
        let outcome: 'present' | 'trashed' | 'out_of_root' | 'unavailable' = 'unavailable';
        try {
          file = await dependencies.getFile(candidate.fileId);
          if (file.trashed) outcome = 'trashed';
          else if (file.parents.includes(next.folderId)) {
            outcome = 'unavailable';
            incompleteListing = true;
          } else if (await dependencies.isHiddenSystemFile(file, job.rootFolderId))
            outcome = 'out_of_root';
          else if (await dependencies.isWithinRoot(file, job.rootFolderId)) outcome = 'present';
          else outcome = 'out_of_root';
        } catch (cause) {
          if (
            !(cause instanceof TeamFunctionError) ||
            !['NOT_FOUND', 'PERMISSION_DENIED'].includes(cause.code)
          )
            throw cause;
        }
        if (outcome === 'unavailable') unavailable = true;
        assertLease(
          await scan.resolveCandidate({
            generation: folder.generation,
            fileId: candidate.fileId,
            expectedRevision: candidate.expectedRevision,
            outcome,
            file
          })
        );
      }
      processed += candidates.length;
      if (unavailable) {
        await scan.beginFolder(next.folderId, true);
        throw new TeamFunctionError(incompleteListing ? 'INVALID_RESPONSE' : 'PERMISSION_DENIED', {
          retryable: true
        });
      }
      if (candidates.length < 100) assertLease(await scan.finishFolder(folder.generation));
    } else {
      let page: Awaited<ReturnType<CatalogSyncDependencies['listChildren']>>;
      try {
        page = await dependencies.listChildren({
          parentId: next.folderId,
          pageToken: folder.pageToken,
          driveId: job.driveId
        });
      } catch (cause) {
        if (
          folder.pageToken &&
          cause instanceof TeamFunctionError &&
          cause.code === 'INVALID_INPUT' &&
          cause.details?.reason === 'PAGE_TOKEN_REJECTED'
        ) {
          await scan.beginFolder(next.folderId, true);
          slices += 1;
          continue;
        }
        throw cause;
      }
      if (page.incompleteSearch || (page.invalidEntries ?? 0) > 0) {
        throw new TeamFunctionError('INVALID_RESPONSE', {
          retryable: true,
          details: { reason: 'INCOMPLETE_LISTING' }
        });
      }
      assertLease(
        await scan.commitPage({
          generation: folder.generation,
          expectedPageToken: folder.pageToken,
          nextPageToken: page.nextPageToken,
          files: page.files.filter(file => file.name !== HIDDEN_SYSTEM_FOLDER),
          complete: page.nextPageToken === null
        })
      );
      processed += page.files.length;
    }
    slices += 1;
    if (now() - started >= options.budgetMs) {
      return { phase: 'initial_scan', processed, slices, yielded: true };
    }
  }
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
