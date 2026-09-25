import { describe, expect, it, vi } from 'vitest';
import { TeamFunctionError } from '../supabase/functions/_shared/errors.ts';
import { resolveUploadFolder } from '../supabase/functions/drive-ops/upload-folder.ts';

function folder(id: string, parentId: string, name = 'Assets') {
  return {
    id,
    name,
    parents: [parentId],
    trashed: false,
    mimeType: 'application/vnd.google-apps.folder',
    resourceKey: null,
    appProperties: { 'soty.upload.folder': 'request-key' }
  };
}

describe('upload folder resolution', () => {
  it('reuses the marked folder after a lost response, without another create', async () => {
    const created = folder('drive-folder', 'parent');
    const drive = {
      findFolderByAppProperty: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(created),
      createFolder: vi.fn().mockResolvedValue(created)
    };
    const input = {
      drive,
      parentDriveId: 'parent',
      name: 'Assets',
      idempotencyKey: 'request-key'
    };
    expect(await resolveUploadFolder(input)).toMatchObject({ folder: created, created: true });
    expect(await resolveUploadFolder(input)).toMatchObject({ folder: created, created: false });
    expect(drive.createFolder).toHaveBeenCalledTimes(1);
  });

  it('refuses to reuse a marked folder moved out of the authorized parent', async () => {
    const drive = {
      findFolderByAppProperty: vi.fn().mockResolvedValue(folder('drive-folder', 'elsewhere')),
      createFolder: vi.fn()
    };
    await expect(
      resolveUploadFolder({
        drive,
        parentDriveId: 'parent',
        name: 'Assets',
        idempotencyKey: 'request-key'
      })
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' } satisfies Partial<TeamFunctionError>);
    expect(drive.createFolder).not.toHaveBeenCalled();
  });

  it('refuses a key replay for a different folder name', async () => {
    const drive = {
      findFolderByAppProperty: vi.fn().mockResolvedValue(folder('drive-folder', 'parent')),
      createFolder: vi.fn()
    };
    await expect(
      resolveUploadFolder({
        drive,
        parentDriveId: 'parent',
        name: 'Different',
        idempotencyKey: 'request-key'
      })
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(drive.createFolder).not.toHaveBeenCalled();
  });
});
