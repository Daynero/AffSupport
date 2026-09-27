import { describe, expect, it, vi } from 'vitest';
import type { FolderPage, TeamMaterialRow } from '@video-compressor/shared';
import {
  confirmWorkspaceCatalog,
  findFolderConflicts
} from '../apps/web/src/team/explorer/catalogPostcondition';

const row = (id: string, name = 'same.txt'): TeamMaterialRow => ({
  id,
  name,
  teamId: 'team',
  kind: 'other',
  category: 'other',
  mimeType: 'text/plain',
  fileExtension: 'txt',
  sizeBytes: 1,
  driveFileId: `drive-${id}`,
  parentFolderId: 'destination',
  modifiedAt: null,
  driveVersion: '1',
  previewState: 'pending',
  thumbnailReady: false
});

describe('authoritative folder checks', () => {
  it('finds a conflict beyond the visible first page without applying UI filters', async () => {
    const client = {
      listFolderPage: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [row('unrelated', 'a.txt')],
          next: { sortKey: 'a', id: 'unrelated' },
          total: 2
        })
        .mockResolvedValueOnce({ rows: [row('conflict')], next: null, total: 2 })
    };
    expect(await findFolderConflicts(client, 'team', 'destination', ['same.txt'])).toEqual(
      new Map([['same.txt', 'conflict']])
    );
    expect(client.listFolderPage.mock.calls[1]).toEqual([
      'team',
      { parentFolderId: 'destination', after: { sortKey: 'a', id: 'unrelated' }, limit: 100 }
    ]);
  });

  it('does not accept an empty or wrong-parent snapshot as confirmation', async () => {
    const client = {
      listFolderPage: vi.fn(
        async (_team: string, input: { parentFolderId: string | null }): Promise<FolderPage> => ({
          rows: input.parentFolderId === 'wrong-parent' ? [row('created')] : [],
          total: 0,
          next: null
        })
      )
    };
    await expect(
      confirmWorkspaceCatalog(client, 'team', [
        { materialId: 'created', driveFolderId: 'destination' }
      ])
    ).rejects.toThrow('CATALOG_POSTCONDITION_FAILED');
  });

  it('confirms each created material in its expected folder, including later pages', async () => {
    const client = {
      listFolderPage: vi
        .fn()
        .mockResolvedValueOnce({ rows: [], next: { sortKey: 'a', id: 'a' }, total: 1 })
        .mockResolvedValueOnce({ rows: [row('created')], next: null, total: 1 })
    };
    await expect(
      confirmWorkspaceCatalog(client, 'team', [
        { materialId: 'created', driveFolderId: 'destination' }
      ])
    ).resolves.toBeUndefined();
    expect(client.listFolderPage).toHaveBeenCalledTimes(2);
  });
});
