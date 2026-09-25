import { describe, expect, it, vi } from 'vitest';
import {
  runCatalogSyncJob,
  runCatalogSyncSlice,
  type CatalogSyncDependencies,
  type CatalogSyncJob
} from '../supabase/functions/catalog-sync/engine';
import { catalogFile } from './fixtures/catalog-sync';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';

const job: CatalogSyncJob = {
  jobId: 'canonical',
  connectionId: 'connection',
  phase: 'incremental',
  rootFolderId: 'root',
  driveId: null,
  folderQueue: [],
  pageToken: null,
  changeToken: 'change-1',
  attempts: 0,
  jobKind: 'incremental'
};

function dependencies(
  changes: Awaited<ReturnType<CatalogSyncDependencies['listChanges']>>['changes']
) {
  const enqueueDiscoveredFolder = vi.fn().mockResolvedValue(true);
  const upsertFiles = vi.fn().mockResolvedValue(true);
  const complete = vi.fn().mockResolvedValue(true);
  const deps = {
    listChildren: vi.fn(),
    listChanges: vi.fn().mockResolvedValue({
      changes,
      nextPageToken: null,
      newStartPageToken: 'change-2'
    }),
    getFile: vi.fn(),
    isWithinRoot: vi.fn().mockResolvedValue(true),
    isHiddenSystemFile: vi.fn().mockResolvedValue(false),
    invalidateLandingRenders: vi.fn(),
    upsertFiles,
    tombstoneFiles: vi.fn(),
    requeueTranscripts: vi.fn(),
    checkpoint: vi.fn(),
    complete,
    reconcile: vi.fn(),
    markFolderIndexed: vi.fn(),
    markRootState: vi.fn(),
    touchReconciled: vi.fn(),
    enqueueDiscoveredFolder
  } as CatalogSyncDependencies & { enqueueDiscoveredFolder: typeof enqueueDiscoveredFolder };
  return { deps, enqueueDiscoveredFolder, upsertFiles, complete };
}

describe('catalog completeness', () => {
  it('walks all 50,000 initial files before finite completion', async () => {
    let token: string | null = null;
    let state: 'listing' | 'reconciling' | 'done' = 'listing';
    const seen = new Set<string>();
    const scan: NonNullable<CatalogSyncDependencies['durableScan']> = {
      beginFolder: vi.fn().mockImplementation(async () => ({ generation: 'g', pageToken: token })),
      frontier: vi
        .fn()
        .mockImplementation(async () => (state === 'done' ? [] : [{ folderId: 'root', state }])),
      commitPage: vi
        .fn()
        .mockImplementation(
          async (
            input: Parameters<NonNullable<CatalogSyncDependencies['durableScan']>['commitPage']>[0]
          ) => {
            expect(input.expectedPageToken).toBe(token);
            input.files.forEach(file => seen.add(file.id));
            token = input.nextPageToken;
            if (input.complete) state = 'reconciling';
            return true;
          }
        ),
      missingCandidates: vi.fn().mockResolvedValue([]),
      resolveCandidate: vi.fn(),
      finishFolder: vi.fn().mockImplementation(async () => {
        state = 'done';
        return true;
      })
    };
    const { deps, complete } = dependencies([]);
    deps.durableScan = scan;
    deps.listChildren = vi.fn().mockImplementation(async ({ pageToken }) => {
      const page = pageToken ? Number(pageToken.slice(5)) : 0;
      return {
        files: Array.from({ length: 100 }, (_, offset) =>
          catalogFile({ id: `file-${page * 100 + offset}` })
        ),
        nextPageToken: page < 499 ? `page-${page + 1}` : null
      };
    });
    const result = await runCatalogSyncJob(
      { ...job, phase: 'initial_scan', jobKind: 'initial', folderQueue: ['root'] },
      deps,
      { budgetMs: 10_000, now: () => 0 }
    );
    expect(result).toMatchObject({ phase: 'change_replay', processed: 50_000, yielded: false });
    expect(seen.size).toBe(50_000);
    expect(scan.commitPage).toHaveBeenCalledTimes(500);
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ changeToken: null }));
  });

  it('hands an in-root folder change to durable subtree scheduling before cursor completion', async () => {
    const folder = catalogFile({
      id: 'folder',
      name: 'Imported',
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['root']
    });
    const { deps, enqueueDiscoveredFolder, upsertFiles, complete } = dependencies([
      { fileId: folder.id, removed: false, file: folder }
    ]);
    await runCatalogSyncSlice(job, deps);
    expect(enqueueDiscoveredFolder).toHaveBeenCalledWith({
      jobId: job.jobId,
      connectionId: job.connectionId,
      folderId: folder.id,
      parentFolderId: 'root'
    });
    expect(enqueueDiscoveredFolder.mock.invocationCallOrder[0]).toBeLessThan(
      upsertFiles.mock.invocationCallOrder[0]!
    );
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ changeToken: 'change-2' }));
  });

  it.each(['moved-in', 'restored'])(
    'schedules a %s folder before advancing the cursor',
    async () => {
      const folder = catalogFile({
        id: 'nested-folder',
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['root'],
        trashed: false
      });
      const { deps, enqueueDiscoveredFolder, complete } = dependencies([
        { fileId: folder.id, removed: false, file: folder }
      ]);
      await runCatalogSyncSlice(job, deps);
      expect(enqueueDiscoveredFolder).toHaveBeenCalledWith(
        expect.objectContaining({ folderId: folder.id, parentFolderId: 'root' })
      );
      expect(enqueueDiscoveredFolder.mock.invocationCallOrder[0]).toBeLessThan(
        complete.mock.invocationCallOrder[0]!
      );
    }
  );

  it('does not complete a finite scan from a rejected page token until a fresh generation lands', async () => {
    let generation = 'old';
    let pageToken: string | null = 'expired';
    let state: 'listing' | 'reconciling' | 'done' = 'listing';
    const scan: NonNullable<CatalogSyncDependencies['durableScan']> = {
      beginFolder: vi.fn().mockImplementation(async (_folderId: string, restart: boolean) => {
        if (restart) {
          generation = 'fresh';
          pageToken = null;
        }
        return { generation, pageToken };
      }),
      frontier: vi
        .fn()
        .mockImplementation(async () => (state === 'done' ? [] : [{ folderId: 'root', state }])),
      commitPage: vi.fn().mockImplementation(async input => {
        expect(input.generation).toBe('fresh');
        expect(input.expectedPageToken).toBeNull();
        state = 'reconciling';
        return true;
      }),
      missingCandidates: vi.fn().mockResolvedValue([]),
      resolveCandidate: vi.fn(),
      finishFolder: vi.fn().mockImplementation(async () => {
        state = 'done';
        return true;
      })
    };
    const { deps, complete } = dependencies([]);
    deps.durableScan = scan;
    deps.listChildren = vi
      .fn()
      .mockRejectedValueOnce(
        new TeamFunctionError('INVALID_INPUT', {
          retryable: true,
          details: { reason: 'PAGE_TOKEN_REJECTED' }
        })
      )
      .mockResolvedValueOnce({ files: [catalogFile()], nextPageToken: null });
    await runCatalogSyncJob(
      { ...job, phase: 'initial_scan', jobKind: 'user_subtree', folderQueue: ['root'] },
      deps,
      { budgetMs: 10_000, now: () => 0 }
    );
    expect(scan.beginFolder).toHaveBeenCalledWith('root', true);
    expect(scan.commitPage).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledAfter(scan.commitPage as ReturnType<typeof vi.fn>);
  });
});
