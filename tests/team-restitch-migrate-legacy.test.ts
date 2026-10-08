import { describe, expect, it, vi } from 'vitest';
import type { TeamRestitchDefaults } from '@video-compressor/shared';

/**
 * Feature 030, US5: the old pictures leave the bucket for the space. Each is read, uploaded
 * into `Re-stitch images/<slot>`, and the slot's pool gains that folder; a picture the bucket
 * lost is counted; nothing is ever written back to the bucket.
 */

vi.mock('../apps/web/src/lib/supabase', () => ({
  withFreshSession: <T>(run: () => PromiseLike<T>) => run(),
  requireSupabaseClient: () => ({ rpc: vi.fn(), storage: { from: vi.fn() } }),
  getSupabaseClient: () => ({ rpc: vi.fn() })
}));
vi.mock('../apps/web/src/api/client', () => ({
  importTeamRestitchImage: vi.fn(),
  agentCanRestitchFromSpace: vi.fn()
}));
vi.mock('../apps/web/src/team/catalog/material-actions-client', () => ({
  uploadTeamFile: vi.fn()
}));

const { transferLegacyRestitchImages, LEGACY_TRANSFER_FOLDER } =
  await import('../apps/web/src/team/restitch/migrate-legacy');

const TEAM = '30000000-0000-4000-8000-0000000000aa';
const defaults: TeamRestitchDefaults = {
  operation: 'restitch',
  startImageIds: ['s1', 's2'],
  endImageIds: ['e1'],
  fitMode: 'cover',
  finalDurationMode: 'random-40-50',
  customFinalDurationSeconds: 2700,
  sourceMode: 'legacy',
  configured: true,
  updatedAt: '',
  updatedBy: 'owner'
};

function deps(overrides: Partial<Parameters<typeof transferLegacyRestitchImages>[3]> = {}) {
  const folders = new Map<string, { folderId: string; materialId: string }>();
  return {
    sourceUserId: vi.fn().mockResolvedValue('owner'),
    download: vi.fn(async (_team: string, _user: string, _slot: string, id: string) =>
      id === 's2' ? null : { blob: new Blob([id]), extension: '.png' as const }
    ),
    ensureFolder: vi.fn(async (_team: string, name: string, parent: string | null) => {
      const key = `${parent ?? 'root'}/${name}`;
      if (!folders.has(key))
        folders.set(key, { folderId: `drive-${key}`, materialId: `mat-${key}` });
      return folders.get(key)!;
    }),
    upload: vi.fn().mockResolvedValue(undefined),
    listSources: vi.fn().mockResolvedValue({
      sourceMode: 'legacy',
      legacyImageCount: 3,
      pools: {
        start: {
          state: 'empty',
          overLimit: false,
          eligibleCount: 0,
          sources: [
            {
              materialId: 'kept',
              driveFileId: null,
              kind: 'file',
              name: 'kept.png',
              availability: 'available',
              imageCount: 1,
              skipped: { format: 0, size: 0, animated: 0 }
            }
          ]
        },
        end: { state: 'empty', overLimit: false, eligibleCount: 0, sources: [] }
      }
    }),
    setSources: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as NonNullable<Parameters<typeof transferLegacyRestitchImages>[3]>;
}

describe('moving the old pictures into the space', () => {
  it('uploads each picture into its slot folder, keeps the pool it had, and counts what is gone', async () => {
    const d = deps();
    const progress: Array<[number, number]> = [];
    const report = await transferLegacyRestitchImages(
      TEAM,
      defaults,
      (done, total) => progress.push([done, total]),
      d
    );
    expect(report).toEqual({ moved: 2, missing: 1 });
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3]
    ]);
    expect(d.ensureFolder).toHaveBeenCalledWith(TEAM, LEGACY_TRANSFER_FOLDER, null);
    expect(d.ensureFolder).toHaveBeenCalledWith(
      TEAM,
      'start',
      `mat-root/${LEGACY_TRANSFER_FOLDER}`
    );
    expect(d.ensureFolder).toHaveBeenCalledWith(TEAM, 'end', `mat-root/${LEGACY_TRANSFER_FOLDER}`);
    expect(
      vi
        .mocked(d.upload)
        .mock.calls.map(call => [call[0].destinationFolderId, (call[0].file as File).name])
    ).toEqual([
      [`drive-mat-root/${LEGACY_TRANSFER_FOLDER}/start`, 's1.png'],
      [`drive-mat-root/${LEGACY_TRANSFER_FOLDER}/end`, 'e1.png']
    ]);
    expect(d.setSources).toHaveBeenCalledWith(TEAM, 'start', [
      { materialId: 'kept' },
      { materialId: `mat-mat-root/${LEGACY_TRANSFER_FOLDER}/start` }
    ]);
    // The end slot had nothing: it gains the folder alone.
    expect(d.setSources).toHaveBeenCalledWith(TEAM, 'end', [
      { materialId: `mat-mat-root/${LEGACY_TRANSFER_FOLDER}/end` }
    ]);
  });

  it('does nothing for a space that names no old pictures', async () => {
    const d = deps();
    expect(
      await transferLegacyRestitchImages(
        TEAM,
        { ...defaults, startImageIds: [], endImageIds: [] },
        () => {},
        d
      )
    ).toEqual({ moved: 0, missing: 0 });
    expect(d.ensureFolder).not.toHaveBeenCalled();
    expect(d.setSources).not.toHaveBeenCalled();
  });
});
