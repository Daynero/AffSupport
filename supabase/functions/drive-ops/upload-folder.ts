import { TeamFunctionError } from '../_shared/errors.ts';
import type { DriveFileMetadata, GoogleDriveClient } from '../_shared/drive.ts';

export const UPLOAD_FOLDER_MARK = 'soty.upload.folder';

type UploadFolderDrive = Pick<GoogleDriveClient, 'findFolderByAppProperty' | 'createFolder'>;

/** A request key identifies one intended directory, even if its first response is lost. */
export async function resolveUploadFolder(input: {
  drive: UploadFolderDrive;
  parentDriveId: string;
  driveId?: string | null;
  name: string;
  idempotencyKey: string;
}): Promise<{ folder: DriveFileMetadata; created: boolean }> {
  const found = await input.drive.findFolderByAppProperty({
    key: UPLOAD_FOLDER_MARK,
    value: input.idempotencyKey,
    driveId: input.driveId
  });
  if (found) {
    if (
      found.trashed ||
      found.mimeType !== 'application/vnd.google-apps.folder' ||
      !found.parents.includes(input.parentDriveId) ||
      found.name !== input.name ||
      found.appProperties[UPLOAD_FOLDER_MARK] !== input.idempotencyKey
    ) {
      throw new TeamFunctionError('SOURCE_CHANGED', { retryable: false });
    }
    return { folder: found, created: false };
  }
  const folder = await input.drive.createFolder({
    name: input.name,
    parentId: input.parentDriveId,
    appProperties: { [UPLOAD_FOLDER_MARK]: input.idempotencyKey }
  });
  return { folder, created: true };
}
