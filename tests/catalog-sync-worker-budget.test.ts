import { describe, expect, it, vi } from 'vitest';
import {
  runCatalogSyncJob,
  type CatalogSyncDependencies,
  type CatalogSyncJob
} from '../supabase/functions/catalog-sync/engine';
import { catalogFile } from './fixtures/catalog-sync';

/**
 * 028, release D — a scheduler invocation stops at its budget between
 * provider reads, a replay page is checkpointed before its transcripts are
 * downloaded, and a hidden cache row in a folder does not restart the listing.
 */

function dependencies(overrides: Partial<CatalogSyncDependencies> = {}): CatalogSyncDependencies {
  return {
    listChildren: vi.fn(),
    listChanges: vi.fn(),
    getFile: vi.fn(),
    isWithinRoot: vi.fn().mockResolvedValue(true),
    isHiddenSystemFile: vi.fn().mockResolvedValue(false),
    invalidateLandingRenders: vi.fn(),
    upsertFiles: vi.fn().mockResolvedValue(true),
    enqueueDiscoveredFolder: vi.fn().mockResolvedValue(true),
    tombstoneFiles: vi.fn(),
    requeueTranscripts: vi.fn(),
    checkpoint: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue(true),
    reconcile: vi.fn(),
    markFolderIndexed: vi.fn(),
    markRootState: vi.fn(),
    touchReconciled: vi.fn(),
    ...overrides
  };
}

const finite: CatalogSyncJob = {
  jobId: 'job',
  connectionId: 'connection',
  phase: 'initial_scan',
  jobKind: 'user_subtree',
  leaseEpoch: 1,
  rootFolderId: 'root',
  driveId: null,
  folderQueue: ['root'],
  pageToken: null,
  changeToken: 'change-0',
  attempts: 1,
  discoveredFolderIds: []
};

describe('reconciliation stays inside its budget', () => {
  it('yields with a checkpoint when the budget is exhausted mid-batch and resumes from the unresolved candidates', async () => {
    let clock = 0;
    const now = () => clock;
    const candidates = Array.from({ length: 5 }, (_, index) => ({
      fileId: `missing-${index}`,
      expectedRevision: '1'
    }));
    const scan = {
      beginFolder: vi.fn().mockResolvedValue({ generation: 'g1', pageToken: null }),
      frontier: vi
        .fn()
        .mockResolvedValueOnce([{ folderId: 'root', state: 'reconciling' }])
        .mockResolvedValueOnce([{ folderId: 'root', state: 'reconciling' }]),
      commitPage: vi.fn().mockResolvedValue(true),
      missingCandidates: vi.fn().mockResolvedValue(candidates),
      resolveCandidate: vi.fn().mockResolvedValue(true),
      finishFolder: vi.fn().mockResolvedValue(true)
    };
    const deps = dependencies({
      durableScan: scan,
      // Each provider read costs 5 "ms"; the budget is 12: two candidates fit.
      getFile: vi.fn(async (id: string) => {
        clock += 5;
        return catalogFile({ id, parents: ['elsewhere'] });
      })
    });
    const result = await runCatalogSyncJob(finite, deps, { budgetMs: 12, now });
    expect(result.yielded).toBe(true);
    expect(scan.resolveCandidate).toHaveBeenCalledTimes(3);
    expect(scan.finishFolder).not.toHaveBeenCalled();
  });

  it('a hidden cache row in the folder is out of root, not an incomplete listing', async () => {
    const scan = {
      beginFolder: vi.fn().mockResolvedValue({ generation: 'g1', pageToken: null }),
      frontier: vi
        .fn()
        .mockResolvedValueOnce([{ folderId: 'root', state: 'reconciling' }])
        .mockResolvedValueOnce([]),
      commitPage: vi.fn().mockResolvedValue(true),
      missingCandidates: vi.fn().mockResolvedValue([{ fileId: 'cache', expectedRevision: '1' }]),
      resolveCandidate: vi.fn().mockResolvedValue(true),
      finishFolder: vi.fn().mockResolvedValue(true)
    };
    const deps = dependencies({
      durableScan: scan,
      getFile: vi.fn().mockResolvedValue(catalogFile({ id: 'cache', parents: ['root'] })),
      isHiddenSystemFile: vi.fn().mockResolvedValue(true)
    });
    const result = await runCatalogSyncJob(finite, deps, { budgetMs: 1_000 });
    expect(result.yielded).toBe(false);
    expect(scan.resolveCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'cache', outcome: 'out_of_root' })
    );
    // No restart: beginFolder is never asked to abandon the generation.
    expect(scan.beginFolder).not.toHaveBeenCalledWith('root', true);
    expect(scan.finishFolder).toHaveBeenCalledTimes(1);
  });
});

describe('a replay page checkpoints before its transcripts', () => {
  it('the checkpoint is written before any transcript is requeued', async () => {
    const order: string[] = [];
    const transcript = catalogFile({ id: 'notes', name: 'notes.txt', mimeType: 'text/plain' });
    const deps = dependencies({
      listChanges: vi.fn().mockResolvedValue({
        changes: [{ fileId: 'notes', removed: false, file: transcript }],
        nextPageToken: 'page-2',
        newStartPageToken: null
      }),
      checkpoint: vi.fn(async () => {
        order.push('checkpoint');
        return true;
      }),
      requeueTranscripts: vi.fn(async () => {
        order.push('transcripts');
      }),
      upsertFiles: vi.fn(async () => {
        order.push('upsert');
        return true;
      })
    });
    const incremental: CatalogSyncJob = {
      ...finite,
      jobKind: 'incremental',
      phase: 'incremental',
      pageToken: 'page-1'
    };
    await runCatalogSyncJob(incremental, deps, { budgetMs: 1_000 });
    expect(order).toEqual(['upsert', 'checkpoint', 'transcripts']);
  });
});
