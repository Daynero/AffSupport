import { describe, expect, it, vi } from 'vitest';
import {
  catalogRetryDelayMs,
  runCatalogSyncSlice,
  type CatalogSyncDependencies,
  type CatalogSyncJob
} from '../supabase/functions/catalog-sync/engine';

const folderMime = 'application/vnd.google-apps.folder';

function file(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file-1',
    name: 'creative.mp4',
    mimeType: 'video/mp4',
    parents: ['root'],
    trashed: false,
    driveId: null,
    resourceKey: null,
    shortcutTargetId: null,
    shortcutTargetResourceKey: null,
    capabilities: {
      canDownload: true,
      canListChildren: false,
      canAddChildren: false,
      canRename: true,
      canMoveItemWithinDrive: true,
      canMoveItemOutOfDrive: true,
      canModifyContent: true,
      canTrash: true,
      canUntrash: true
    },
    size: 10,
    modifiedAt: '2026-08-01T12:00:00.000Z',
    version: '7',
    checksum: 'checksum-7',
    ...overrides
  };
}

function dependencies(overrides: Partial<CatalogSyncDependencies> = {}): CatalogSyncDependencies {
  return {
    listChildren: vi.fn(),
    listChanges: vi.fn(),
    getFile: vi.fn(),
    isWithinRoot: vi.fn().mockResolvedValue(true),
    upsertFiles: vi.fn(),
    tombstoneFiles: vi.fn(),
    requeueTranscripts: vi.fn(),
    checkpoint: vi.fn(),
    complete: vi.fn(),
    reconcile: vi.fn(),
    ...overrides
  };
}

const baseJob: CatalogSyncJob = {
  jobId: 'job-id',
  connectionId: 'connection-id',
  phase: 'initial_scan',
  rootFolderId: 'root',
  driveId: null,
  folderQueue: ['root'],
  pageToken: null,
  changeToken: 'change-0',
  attempts: 1
};

describe('durable catalog synchronization', () => {
  it('checkpoints each initial page and resumes without repeating an upsert', async () => {
    const first = dependencies({
      listChildren: vi.fn().mockResolvedValue({
        files: [file({ id: 'folder-a', name: 'A', mimeType: folderMime })],
        nextPageToken: 'root-page-2'
      })
    });
    await runCatalogSyncSlice(baseJob, first);
    expect(first.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({ folderQueue: ['root'], pageToken: 'root-page-2' })
    );

    const resumed = dependencies({
      listChildren: vi
        .fn()
        .mockResolvedValue({ files: [file({ id: 'file-2' })], nextPageToken: null })
    });
    await runCatalogSyncSlice({ ...baseJob, pageToken: 'root-page-2' }, resumed);
    expect(resumed.listChildren).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: 'root', pageToken: 'root-page-2' })
    );
    expect(resumed.upsertFiles).toHaveBeenCalledOnce();
  });

  it('replays every change page and commits the new start token only after the final page', async () => {
    const deps = dependencies({
      listChanges: vi
        .fn()
        .mockResolvedValueOnce({
          changes: [{ fileId: 'file-1', removed: false, file: file() }],
          nextPageToken: 'changes-page-2',
          newStartPageToken: null
        })
        .mockResolvedValueOnce({
          changes: [{ fileId: 'file-2', removed: false, file: file({ id: 'file-2' }) }],
          nextPageToken: null,
          newStartPageToken: 'change-9'
        })
    });
    const replay = { ...baseJob, phase: 'change_replay' as const, pageToken: 'change-0' };
    await runCatalogSyncSlice(replay, deps);
    expect(deps.checkpoint).toHaveBeenLastCalledWith(
      expect.objectContaining({ pageToken: 'changes-page-2', changeToken: 'change-0' })
    );
    await runCatalogSyncSlice({ ...replay, pageToken: 'changes-page-2' }, deps);
    expect(deps.complete).toHaveBeenCalledWith(
      expect.objectContaining({ changeToken: 'change-9', nextPhase: 'incremental' })
    );
  });

  it('tombstones removed/out-of-root changes, restores returned files, and keeps provenance rows', async () => {
    const deps = dependencies({
      listChanges: vi.fn().mockResolvedValue({
        changes: [
          { fileId: 'removed', removed: true, file: null },
          { fileId: 'trashed', removed: false, file: file({ id: 'trashed', trashed: true }) },
          { fileId: 'outside', removed: false, file: file({ id: 'outside' }) },
          { fileId: 'restored', removed: false, file: file({ id: 'restored', trashed: false }) }
        ],
        nextPageToken: null,
        newStartPageToken: 'change-10'
      }),
      isWithinRoot: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    });
    await runCatalogSyncSlice(
      { ...baseJob, phase: 'incremental', pageToken: 'change-9', changeToken: 'change-9' },
      deps
    );
    expect(deps.tombstoneFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        items: expect.arrayContaining([
          { fileId: 'removed', lifecycle: 'missing' },
          { fileId: 'trashed', lifecycle: 'trashed' },
          { fileId: 'outside', lifecycle: 'missing' }
        ]),
        preserveProvenance: true
      })
    );
    expect(deps.upsertFiles).toHaveBeenCalledWith(
      expect.objectContaining({ files: [expect.objectContaining({ id: 'restored' })] })
    );
  });

  it('requeues classifier/transcript work on source identity change and reconciles explicitly', async () => {
    const changed = file({
      id: 'transcript-1',
      name: 'captions.VTT',
      mimeType: 'text/vtt',
      version: '8',
      checksum: 'checksum-8'
    });
    const deps = dependencies({
      listChanges: vi.fn().mockResolvedValue({
        changes: [{ fileId: changed.id, removed: false, file: changed }],
        nextPageToken: null,
        newStartPageToken: 'change-11'
      })
    });
    await runCatalogSyncSlice(
      { ...baseJob, phase: 'incremental', pageToken: 'change-10', changeToken: 'change-10' },
      deps
    );
    expect(deps.requeueTranscripts).toHaveBeenCalledWith(
      expect.objectContaining({ files: [expect.objectContaining({ id: 'transcript-1' })] })
    );

    const reconcile = dependencies();
    await runCatalogSyncSlice({ ...baseJob, phase: 'reconcile' }, reconcile);
    expect(reconcile.reconcile).toHaveBeenCalledOnce();
  });

  it('uses bounded exponential retry/backoff that permits expired-lease recovery', () => {
    expect(catalogRetryDelayMs(1, () => 0)).toBe(1_000);
    expect(catalogRetryDelayMs(5, () => 0)).toBe(16_000);
    expect(catalogRetryDelayMs(20, () => 1)).toBeLessThanOrEqual(15 * 60_000);
  });
});
