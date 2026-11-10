import { describe, expect, it, vi } from 'vitest';
import { catalogPublicationSourceIdentity } from '../packages/shared/src/team/catalog-publication-source';
import { resolveCatalogReadyLinks } from '../supabase/functions/drive-ops/catalog-initial-video-authority.ts';

const ROOT = 'root-folder';
const FILE = 'video-file';

// 1.4.2 regression: a restitched catalog of 100 products proved the one video
// file 100 times in a row and outlived the function's wall clock, so the
// catalog never finished after the video was ready.
describe('resolveCatalogReadyLinks', () => {
  it('proves each distinct video output once however many rows it serves', async () => {
    const live = {
      id: FILE,
      parents: [ROOT],
      trashed: false,
      shortcutTargetId: null,
      checksum: 'a'.repeat(32),
      mimeType: 'video/mp4',
      size: 1000,
      version: '7',
      resourceKey: null,
      capabilities: { canDownload: true, canShare: true }
    };
    const sourceVersion = await catalogPublicationSourceIdentity(
      {
        materialId: '11111111-1111-4111-8111-111111111111',
        connectionId: '22222222-2222-4222-8222-222222222222',
        fileId: FILE,
        checksum: live.checksum,
        mimeType: live.mimeType,
        sizeBytes: live.size,
        driveVersion: live.version
      },
      false
    );
    const rowIds = Array.from({ length: 100 }, (_, index) => `row-${index}`);
    const service = {
      rpc: vi.fn().mockResolvedValue({
        data: rowIds.map(rowId => ({
          rowId,
          materialId: '11111111-1111-4111-8111-111111111111',
          connectionId: '22222222-2222-4222-8222-222222222222',
          sourceVersion,
          fileId: FILE,
          credentialId: 'credential-1',
          rootFolderId: ROOT
        })),
        error: null
      })
    };
    const drive = {
      getFile: vi.fn().mockResolvedValue(live),
      listAnyonePermissions: vi.fn().mockResolvedValue([{ id: 'anyone', role: 'reader' }]),
      createAnyoneReaderPermission: vi.fn()
    };
    const driveFor = vi.fn().mockResolvedValue(drive);

    const links = await resolveCatalogReadyLinks(
      service as never,
      { teamId: 'team', actorId: 'actor' },
      driveFor as never,
      'set',
      1,
      rowIds
    );

    expect(links).toHaveLength(100);
    expect(new Set(links).size).toBe(1);
    expect(driveFor).toHaveBeenCalledTimes(1);
    expect(drive.listAnyonePermissions).toHaveBeenCalledTimes(1);
    // One ancestry read plus one live read for the single distinct file.
    expect(drive.getFile).toHaveBeenCalledTimes(2);
  });
});
