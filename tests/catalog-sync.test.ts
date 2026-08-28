import { describe, expect, it, vi } from 'vitest';
import {
  catalogRetryDelayMs,
  runCatalogSyncSlice,
  type CatalogSyncDependencies,
  type CatalogSyncJob
} from '../supabase/functions/catalog-sync/engine';
import { GoogleDriveClient } from '../supabase/functions/_shared/drive';

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
    isHiddenSystemFile: vi.fn().mockResolvedValue(false),
    invalidateLandingRenders: vi.fn(),
    upsertFiles: vi.fn(),
    tombstoneFiles: vi.fn(),
    requeueTranscripts: vi.fn(),
    checkpoint: vi.fn(),
    complete: vi.fn(),
    reconcile: vi.fn(),
    markFolderIndexed: vi.fn(),
    markRootState: vi.fn(),
    touchReconciled: vi.fn(),
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

  it('never catalogs or traverses the hidden render-artifact namespace', async () => {
    const deps = dependencies({
      listChildren: vi.fn().mockResolvedValue({
        files: [
          file({ id: 'system', name: '.soty', mimeType: folderMime }),
          file({ id: 'visible', name: 'campaign.html', mimeType: 'text/html' })
        ],
        nextPageToken: null
      })
    });
    await runCatalogSyncSlice(baseJob, deps);
    expect(deps.upsertFiles).toHaveBeenCalledWith(
      expect.objectContaining({ files: [expect.objectContaining({ id: 'visible' })] })
    );
    expect(deps.checkpoint).not.toHaveBeenCalledWith(
      expect.objectContaining({ folderQueue: expect.arrayContaining(['system']) })
    );
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
    expect(deps.invalidateLandingRenders).toHaveBeenCalledWith(
      expect.objectContaining({
        fileIds: expect.arrayContaining(['removed', 'trashed', 'outside', 'restored'])
      })
    );
    expect(vi.mocked(deps.invalidateLandingRenders).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.tombstoneFiles).mock.invocationCallOrder[0]
    );
  });

  it('tombstones a changed artifact descendant instead of ingesting it', async () => {
    const hidden = file({ id: 'segment-0', name: '0.webp', mimeType: 'image/webp' });
    const deps = dependencies({
      listChanges: vi.fn().mockResolvedValue({
        changes: [{ fileId: hidden.id, removed: false, file: hidden }],
        nextPageToken: null,
        newStartPageToken: 'change-hidden'
      }),
      isHiddenSystemFile: vi.fn().mockResolvedValue(true)
    });
    await runCatalogSyncSlice(
      { ...baseJob, phase: 'incremental', pageToken: 'change-11', changeToken: 'change-11' },
      deps
    );
    expect(deps.upsertFiles).not.toHaveBeenCalled();
    expect(deps.tombstoneFiles).toHaveBeenCalledWith(
      expect.objectContaining({ items: [{ fileId: 'segment-0', lifecycle: 'missing' }] })
    );
  });

  it('tombstones a change with unreadable metadata instead of blocking all later changes', async () => {
    const deps = dependencies({
      listChanges: vi.fn().mockResolvedValue({
        changes: [{ fileId: 'unreadable', removed: false, file: null }],
        nextPageToken: null,
        newStartPageToken: 'change-unreadable'
      })
    });
    await runCatalogSyncSlice(
      {
        ...baseJob,
        phase: 'incremental',
        pageToken: 'change-previous',
        changeToken: 'change-previous'
      },
      deps
    );
    expect(deps.tombstoneFiles).toHaveBeenCalledWith(
      expect.objectContaining({ items: [{ fileId: 'unreadable', lifecycle: 'missing' }] })
    );
    expect(deps.complete).toHaveBeenCalledWith(
      expect.objectContaining({ changeToken: 'change-unreadable', nextPhase: 'incremental' })
    );
  });

  it('normalizes incomplete Drive change metadata to an unavailable change record', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          changes: [{ fileId: 'partial-file', removed: false, file: { id: 'partial-file' } }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const drive = new GoogleDriveClient(
      'test-access-token-with-enough-entropy',
      fetchImpl as unknown as typeof fetch
    );

    await expect(drive.listChanges({ pageToken: 'change-token' })).resolves.toMatchObject({
      changes: [{ fileId: 'partial-file', removed: false, file: null }]
    });
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

describe('011 — folder markers, root changes and reconciliation stamps', () => {
  it('marks a folder indexed only when its last page lands', async () => {
    const paged = dependencies({
      listChildren: vi
        .fn()
        .mockResolvedValue({ files: [file({ id: 'file-1' })], nextPageToken: 'more' })
    });
    await runCatalogSyncSlice(baseJob, paged);
    expect(paged.markFolderIndexed).not.toHaveBeenCalled();

    const last = dependencies({
      listChildren: vi.fn().mockResolvedValue({ files: [], nextPageToken: null })
    });
    await runCatalogSyncSlice({ ...baseJob, folderQueue: ['folder-a'], pageToken: 'more' }, last);
    expect(last.markFolderIndexed).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'connection-id', folderId: 'folder-a' })
    );
    // An empty folder is indexed too — nothing was upserted, but it is listed.
    expect(last.upsertFiles).not.toHaveBeenCalled();
  });

  it('reports a trashed root as missing and a renamed root as followed, never as a material', async () => {
    const trashed = dependencies({
      listChanges: vi.fn().mockResolvedValue({
        changes: [
          {
            fileId: 'root',
            removed: false,
            file: file({ id: 'root', name: 'Root', trashed: true })
          }
        ],
        nextPageToken: null,
        newStartPageToken: 'change-1'
      })
    });
    await runCatalogSyncSlice({ ...baseJob, phase: 'incremental' }, trashed);
    expect(trashed.markRootState).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'root_missing', rootName: null })
    );
    expect(trashed.tombstoneFiles).not.toHaveBeenCalled();
    expect(trashed.upsertFiles).not.toHaveBeenCalled();

    const renamed = dependencies({
      listChanges: vi.fn().mockResolvedValue({
        changes: [
          { fileId: 'root', removed: false, file: file({ id: 'root', name: 'Campaigns 2026' }) },
          { fileId: 'file-9', removed: false, file: file({ id: 'file-9' }) }
        ],
        nextPageToken: null,
        newStartPageToken: 'change-2'
      })
    });
    await runCatalogSyncSlice({ ...baseJob, phase: 'incremental' }, renamed);
    expect(renamed.markRootState).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'connected', rootName: 'Campaigns 2026' })
    );
    expect(renamed.upsertFiles).toHaveBeenCalledWith(
      expect.objectContaining({ files: [expect.objectContaining({ id: 'file-9' })] })
    );
  });

  it('leaves a picked folder alone in change replay and stamps reconciliation on completion', async () => {
    const deps = dependencies({
      listChanges: vi.fn().mockResolvedValue({
        changes: [
          { fileId: 'picked', removed: false, file: file({ id: 'picked', name: 'Picked' }) }
        ],
        nextPageToken: null,
        newStartPageToken: 'change-3'
      })
    });
    await runCatalogSyncSlice(
      { ...baseJob, phase: 'incremental', selectionFolderIds: ['root', 'picked'] },
      deps
    );
    expect(deps.upsertFiles).not.toHaveBeenCalled();
    expect(deps.tombstoneFiles).not.toHaveBeenCalled();
    expect(deps.touchReconciled).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'connection-id' })
    );
    expect(deps.complete).toHaveBeenCalledWith(
      expect.objectContaining({ changeToken: 'change-3' })
    );
  });
});
