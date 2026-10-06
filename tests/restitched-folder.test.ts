import { describe, expect, it, vi } from 'vitest';
import { resolveRestitchedFolder } from '../supabase/functions/drive-ops/restitched-folder';
import type { DriveFileMetadata } from '../supabase/functions/_shared/drive';

function folder(id: string, parent: string): DriveFileMetadata {
  return { id, name: 'Restitched', parents: [parent], trashed: false } as DriveFileMetadata;
}

describe('catalog restitch cache destination', () => {
  it('uses the connected cache instead of a marked folder belonging to another root', async () => {
    const findFolderByAppProperty = vi.fn(async ({ parentId }: { parentId?: string }) =>
      parentId === 'cache-a' ? folder('copy-a', 'cache-a') : folder('copy-b', 'cache-b')
    );
    const createFolder = vi.fn();
    const result = await resolveRestitchedFolder({
      teamId: 'team',
      rootFolderId: 'cache-a',
      legacyRootFolderId: 'root-a',
      drive: { findFolderByAppProperty, createFolder } as never
    });
    expect(result.folder.id).toBe('copy-a');
    expect(findFolderByAppProperty).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: 'cache-a' })
    );
    expect(createFolder).not.toHaveBeenCalled();
  });

  it('migrates only a marked folder directly under the connected root', async () => {
    const findFolderByAppProperty = vi.fn(async ({ parentId }: { parentId?: string }) =>
      parentId === 'root-a' ? folder('legacy-a', 'root-a') : null
    );
    const result = await resolveRestitchedFolder({
      teamId: 'team',
      rootFolderId: 'cache-a',
      legacyRootFolderId: 'root-a',
      drive: { findFolderByAppProperty, createFolder: vi.fn() } as never
    });
    expect(result.folder.id).toBe('legacy-a');
    expect(findFolderByAppProperty).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ parentId: 'root-a' })
    );
  });

  it('creates a new folder when neither connected location has the marker', async () => {
    const createFolder = vi.fn(async () => folder('new-copy', 'cache-a'));
    const result = await resolveRestitchedFolder({
      teamId: 'team',
      rootFolderId: 'cache-a',
      legacyRootFolderId: 'root-a',
      drive: { findFolderByAppProperty: vi.fn(async () => null), createFolder } as never
    });
    expect(result).toMatchObject({ folder: { id: 'new-copy' }, created: true });
    expect(createFolder).toHaveBeenCalledWith(
      expect.objectContaining({
        parentId: 'cache-a',
        appProperties: { 'soty.restitched': 'team:restitched' }
      })
    );
  });
});
