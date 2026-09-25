import { describe, expect, it, vi } from 'vitest';
import {
  catalogRetryDelayMs,
  runCatalogSyncJob,
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
    enqueueDiscoveredFolder: vi.fn().mockResolvedValue(true),
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
  it('commits each finite listing page with one generation and leaves the canonical cursor alone', async () => {
    const frontier = vi
      .fn()
      .mockResolvedValueOnce([{ folderId: 'root', state: 'queued' }])
      .mockResolvedValueOnce([{ folderId: 'root', state: 'listing' }])
      .mockResolvedValueOnce([{ folderId: 'root', state: 'reconciling' }])
      .mockResolvedValueOnce([]);
    const scan = {
      beginFolder: vi
        .fn()
        .mockResolvedValueOnce({ generation: 'generation-1', pageToken: null })
        .mockResolvedValueOnce({ generation: 'generation-1', pageToken: null })
        .mockResolvedValueOnce({ generation: 'generation-1', pageToken: 'page-2' })
        .mockResolvedValueOnce({ generation: 'generation-1', pageToken: null }),
      frontier,
      commitPage: vi.fn().mockResolvedValue(true),
      missingCandidates: vi.fn().mockResolvedValue([]),
      resolveCandidate: vi.fn().mockResolvedValue(true),
      finishFolder: vi.fn().mockResolvedValue(true)
    };
    const deps = dependencies({
      durableScan: scan,
      listChildren: vi
        .fn()
        .mockResolvedValueOnce({ files: [file()], nextPageToken: 'page-2' })
        .mockResolvedValueOnce({ files: [], nextPageToken: null }),
      complete: vi.fn().mockResolvedValue(true)
    });
    const result = await runCatalogSyncJob({ ...baseJob, jobKind: 'user_subtree' }, deps, {
      budgetMs: 10_000
    });
    expect(result).toMatchObject({ phase: 'change_replay', yielded: false });
    expect(scan.commitPage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        generation: 'generation-1',
        expectedPageToken: null,
        nextPageToken: 'page-2',
        complete: false
      })
    );
    expect(scan.commitPage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        generation: 'generation-1',
        expectedPageToken: 'page-2',
        nextPageToken: null,
        complete: true
      })
    );
    expect(deps.complete).toHaveBeenCalledWith(expect.objectContaining({ changeToken: null }));
    expect(deps.checkpoint).not.toHaveBeenCalled();
    expect(deps.listChanges).not.toHaveBeenCalled();
  });

  it('abandons a rejected page token before restarting with a fresh generation', async () => {
    const rejected = new (await import('../supabase/functions/_shared/errors')).TeamFunctionError(
      'INVALID_INPUT',
      { retryable: true, details: { reason: 'PAGE_TOKEN_REJECTED' } }
    );
    const scan = {
      beginFolder: vi
        .fn()
        .mockResolvedValueOnce({ generation: 'old', pageToken: 'expired' })
        .mockResolvedValueOnce({ generation: 'old', pageToken: 'expired' })
        .mockResolvedValueOnce({ generation: 'fresh', pageToken: null })
        .mockResolvedValueOnce({ generation: 'fresh', pageToken: null })
        .mockResolvedValueOnce({ generation: 'fresh', pageToken: null }),
      frontier: vi
        .fn()
        .mockResolvedValueOnce([{ folderId: 'root', state: 'listing' }])
        .mockResolvedValueOnce([{ folderId: 'root', state: 'listing' }])
        .mockResolvedValueOnce([{ folderId: 'root', state: 'reconciling' }])
        .mockResolvedValueOnce([]),
      commitPage: vi.fn().mockResolvedValue(true),
      missingCandidates: vi.fn().mockResolvedValue([]),
      resolveCandidate: vi.fn().mockResolvedValue(true),
      finishFolder: vi.fn().mockResolvedValue(true)
    };
    const deps = dependencies({
      durableScan: scan,
      listChildren: vi
        .fn()
        .mockRejectedValueOnce(rejected)
        .mockResolvedValueOnce({ files: [], nextPageToken: null }),
      complete: vi.fn().mockResolvedValue(true)
    });
    await runCatalogSyncJob({ ...baseJob, jobKind: 'user_subtree' }, deps, { budgetMs: 10_000 });
    expect(scan.beginFolder).toHaveBeenCalledWith('root', true);
    expect(scan.commitPage).toHaveBeenCalledOnce();
    expect(scan.commitPage).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: 'fresh',
        expectedPageToken: null
      })
    );
  });

  it('records ambiguous candidate access as unavailable without claiming absence', async () => {
    const { TeamFunctionError } = await import('../supabase/functions/_shared/errors');
    const scan = {
      beginFolder: vi.fn().mockResolvedValue({ generation: 'generation-1', pageToken: null }),
      frontier: vi
        .fn()
        .mockResolvedValueOnce([{ folderId: 'root', state: 'reconciling' }])
        .mockResolvedValueOnce([]),
      commitPage: vi.fn().mockResolvedValue(true),
      missingCandidates: vi
        .fn()
        .mockResolvedValueOnce([{ fileId: 'inaccessible', expectedRevision: '123' }]),
      resolveCandidate: vi.fn().mockResolvedValue(true),
      finishFolder: vi.fn().mockResolvedValue(true)
    };
    const deps = dependencies({
      durableScan: scan,
      getFile: vi.fn().mockRejectedValue(new TeamFunctionError('PERMISSION_DENIED')),
      complete: vi.fn().mockResolvedValue(true)
    });
    await expect(
      runCatalogSyncJob({ ...baseJob, jobKind: 'user_subtree' }, deps, { budgetMs: 10_000 })
    ).rejects.toThrow('PERMISSION_DENIED');
    expect(scan.resolveCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: 'inaccessible',
        outcome: 'unavailable',
        file: null
      })
    );
    expect(deps.tombstoneFiles).not.toHaveBeenCalled();
    expect(scan.beginFolder).toHaveBeenCalledWith('root', true);
  });

  it('does not call a listing complete when a missing candidate still lives in that folder', async () => {
    const scan = {
      beginFolder: vi.fn().mockResolvedValue({ generation: 'generation-1', pageToken: null }),
      frontier: vi.fn().mockResolvedValue([{ folderId: 'root', state: 'reconciling' }]),
      commitPage: vi.fn().mockResolvedValue(true),
      missingCandidates: vi.fn().mockResolvedValue([{ fileId: 'file-1', expectedRevision: '123' }]),
      resolveCandidate: vi.fn().mockResolvedValue(true),
      finishFolder: vi.fn().mockResolvedValue(true)
    };
    const deps = dependencies({
      durableScan: scan,
      getFile: vi.fn().mockResolvedValue(file()),
      complete: vi.fn().mockResolvedValue(true)
    });
    await expect(
      runCatalogSyncJob({ ...baseJob, jobKind: 'user_subtree' }, deps, { budgetMs: 10_000 })
    ).rejects.toThrow('INVALID_RESPONSE');
    expect(scan.resolveCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: 'file-1',
        outcome: 'unavailable'
      })
    );
    expect(scan.beginFolder).toHaveBeenCalledWith('root', true);
    expect(scan.finishFolder).not.toHaveBeenCalled();
  });

  it('stops a finite scan on a stale page lease without marking the folder or job complete', async () => {
    const scan = {
      beginFolder: vi.fn().mockResolvedValue({ generation: 'generation-1', pageToken: null }),
      frontier: vi.fn().mockResolvedValue([{ folderId: 'root', state: 'listing' }]),
      commitPage: vi.fn().mockResolvedValue(false),
      missingCandidates: vi.fn(),
      resolveCandidate: vi.fn(),
      finishFolder: vi.fn()
    };
    const deps = dependencies({
      durableScan: scan,
      listChildren: vi.fn().mockResolvedValue({ files: [file()], nextPageToken: null }),
      complete: vi.fn()
    });
    await expect(
      runCatalogSyncJob({ ...baseJob, jobKind: 'user_subtree' }, deps, { budgetMs: 10_000 })
    ).rejects.toThrow('CATALOG_LEASE_LOST');
    expect(scan.finishFolder).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it.each(['initial', 'user_subtree', 'discovered_subtree', 'reconcile'] as const)(
    'hands a completed %s scan to the canonical replay barrier without reading the feed',
    async jobKind => {
      const deps = dependencies({
        listChildren: vi.fn().mockResolvedValue({ files: [], nextPageToken: null }),
        complete: vi.fn().mockResolvedValue(true)
      });
      const result = await runCatalogSyncJob({ ...baseJob, jobKind }, deps, { budgetMs: 1_000 });
      expect(result).toMatchObject({ phase: 'change_replay', yielded: false });
      expect(deps.complete).toHaveBeenCalledWith(expect.objectContaining({ changeToken: null }));
      expect(deps.listChanges).not.toHaveBeenCalled();
      expect(deps.touchReconciled).not.toHaveBeenCalled();
    }
  );

  it.each([
    { incompleteSearch: true, invalidEntries: 0 },
    { incompleteSearch: false, invalidEntries: 1 }
  ])('refuses to confirm a directory after an incomplete provider page', async coverage => {
    const deps = dependencies({
      listChildren: vi.fn().mockResolvedValue({
        files: [file()],
        nextPageToken: null,
        ...coverage
      })
    });
    await expect(runCatalogSyncSlice(baseJob, deps)).rejects.toThrow('INVALID_RESPONSE');
    expect(deps.markFolderIndexed).not.toHaveBeenCalled();
    expect(deps.checkpoint).not.toHaveBeenCalled();
    expect(deps.tombstoneFiles).not.toHaveBeenCalled();
  });

  it('stops immediately if a catalog write loses its lease', async () => {
    const deps = dependencies({
      listChildren: vi.fn().mockResolvedValue({ files: [file()], nextPageToken: null }),
      upsertFiles: vi.fn().mockResolvedValue(false)
    });
    await expect(runCatalogSyncJob(baseJob, deps, { budgetMs: 1_000 })).rejects.toThrow(
      'CATALOG_LEASE_LOST'
    );
    expect(deps.markFolderIndexed).not.toHaveBeenCalled();
    expect(deps.checkpoint).not.toHaveBeenCalled();
  });

  it('does not finish after an expired folder-index lease', async () => {
    const deps = dependencies({
      listChildren: vi.fn().mockResolvedValue({ files: [], nextPageToken: null }),
      markFolderIndexed: vi.fn().mockResolvedValue(false)
    });
    await expect(runCatalogSyncJob(baseJob, deps, { budgetMs: 1_000 })).rejects.toThrow(
      'CATALOG_LEASE_LOST'
    );
    expect(deps.checkpoint).not.toHaveBeenCalled();
  });

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
          // 024 US24: the reason travels with the state — a file moved out of the watched
          // folder is alive, and its catalog and text must not be cleared.
          { fileId: 'removed', lifecycle: 'missing', reason: 'removed' },
          { fileId: 'trashed', lifecycle: 'trashed' },
          { fileId: 'outside', lifecycle: 'missing', reason: 'out_of_root' }
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

  it('places the changes of a page side by side, and writes them in the page’s own order (024)', async () => {
    // Each placement is a walk up the file's parents in Drive. A hundred in a row outlasted the
    // job's lease on the beta, and the same page was begun again every minute for twelve hours.
    let walking = 0;
    let most = 0;
    const ids = Array.from({ length: 40 }, (_, index) => `f${index}`);
    const deps = dependencies({
      listChanges: vi.fn().mockResolvedValue({
        changes: ids.map(id => ({ fileId: id, removed: false, file: file({ id }) })),
        nextPageToken: null,
        newStartPageToken: 'change-10'
      }),
      isWithinRoot: vi.fn().mockImplementation(async (metadata: { id: string }) => {
        walking += 1;
        most = Math.max(most, walking);
        // The first walks are the slowest, so a naive gather would come back out of order.
        await new Promise(resolve => setTimeout(resolve, metadata.id === 'f0' ? 15 : 1));
        walking -= 1;
        return true;
      })
    });
    await runCatalogSyncSlice(
      { ...baseJob, phase: 'incremental', pageToken: 'change-9', changeToken: 'change-9' },
      deps
    );
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(6);
    const written = vi
      .mocked(deps.upsertFiles)
      .mock.calls.flatMap(([input]) => input.files.map(entry => entry.id));
    expect(written).toEqual(ids);
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
      expect.objectContaining({
        items: [{ fileId: 'segment-0', lifecycle: 'missing', reason: 'out_of_root' }]
      })
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
      expect.objectContaining({
        items: [{ fileId: 'unreadable', lifecycle: 'missing', reason: 'removed' }]
      })
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

describe('one scheduler tick, many slices (011, findings I3)', () => {
  it('stops immediately when the database refuses a checkpoint', async () => {
    const deps = dependencies({
      listChildren: vi.fn().mockResolvedValue({
        files: [file({ id: 'child', mimeType: folderMime })],
        nextPageToken: null
      }),
      checkpoint: vi.fn().mockResolvedValue(false)
    });
    await expect(runCatalogSyncJob(baseJob, deps, { budgetMs: 8_000 })).rejects.toThrow(
      'CATALOG_LEASE_LOST'
    );
    expect(deps.listChildren).toHaveBeenCalledOnce();
    expect(deps.complete).not.toHaveBeenCalled();
  });
  it('keeps walking the same job until the budget runs out, then hands over at the checkpoint', async () => {
    const listChildren = vi
      .fn()
      // root: two folders, one page
      .mockResolvedValueOnce({
        files: [
          file({ id: 'folder-a', name: 'A', mimeType: folderMime }),
          file({ id: 'folder-b', name: 'B', mimeType: folderMime })
        ],
        nextPageToken: null
      })
      // folder-a: a file
      .mockResolvedValueOnce({
        files: [file({ id: 'file-a', parents: ['folder-a'] })],
        nextPageToken: null
      })
      // folder-b: a file
      .mockResolvedValueOnce({
        files: [file({ id: 'file-b', parents: ['folder-b'] })],
        nextPageToken: null
      });
    let clock = 0;
    const deps = dependencies({ listChildren });
    const result = await runCatalogSyncJob(baseJob, deps, { budgetMs: 10_000, now: () => clock });
    // Three folders walked in one tick, the queue then handed to the change feed.
    expect(result).toMatchObject({ phase: 'change_replay', slices: 3 });
    expect(listChildren).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ parentId: 'folder-a' })
    );
    expect(listChildren).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ parentId: 'folder-b' })
    );
    expect(deps.markFolderIndexed).toHaveBeenCalledTimes(3);

    // The budget stops the loop at a checkpoint; the next tick resumes from it.
    const spent = dependencies({
      listChildren: vi.fn().mockResolvedValue({
        files: [file({ id: 'folder-c', name: 'C', mimeType: folderMime })],
        nextPageToken: null
      })
    });
    clock = 0;
    const stopped = await runCatalogSyncJob(baseJob, spent, {
      budgetMs: 1,
      now: () => (clock += 1_000)
    });
    expect(stopped).toMatchObject({ phase: 'initial_scan', slices: 1 });
    expect(spent.checkpoint).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'initial_scan', folderQueue: ['folder-c'] })
    );
  });
});
