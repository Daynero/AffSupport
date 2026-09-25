import { TeamFunctionError } from '../_shared/errors.ts';
import type { DriveFileMetadata, GoogleDriveClient } from '../_shared/drive.ts';

export const UPLOAD_FOLDER_MARK = 'soty.upload.folder';

type UploadFolderDrive = Pick<GoogleDriveClient, 'findFolderByAppProperty' | 'createFolder'>;
type FolderResolution = { folder: DriveFileMetadata; created: boolean };
const inFlight = new Map<string, Promise<FolderResolution>>();

function assertSameIntent(
  folder: DriveFileMetadata,
  input: { parentDriveId: string; name: string; idempotencyKey: string }
): void {
  if (
    folder.trashed ||
    folder.mimeType !== 'application/vnd.google-apps.folder' ||
    !folder.parents.includes(input.parentDriveId) ||
    folder.name !== input.name ||
    folder.appProperties[UPLOAD_FOLDER_MARK] !== input.idempotencyKey
  ) {
    throw new TeamFunctionError('SOURCE_CHANGED', { retryable: false });
  }
}

/** A request key identifies one intended directory, even if its first response is lost. */
export async function resolveUploadFolder(input: {
  drive: UploadFolderDrive;
  parentDriveId: string;
  driveId?: string | null;
  name: string;
  idempotencyKey: string;
  allowCreate?: boolean;
}): Promise<FolderResolution> {
  const active = inFlight.get(input.idempotencyKey);
  if (active) {
    const result = await active;
    assertSameIntent(result.folder, input);
    return { folder: result.folder, created: false };
  }
  const work = (async (): Promise<FolderResolution> => {
    const found = await input.drive.findFolderByAppProperty({
      key: UPLOAD_FOLDER_MARK,
      value: input.idempotencyKey,
      driveId: input.driveId
    });
    if (found) {
      assertSameIntent(found, input);
      return { folder: found, created: false };
    }
    if (input.allowCreate === false) {
      throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
    }
    const folder = await input.drive.createFolder({
      name: input.name,
      parentId: input.parentDriveId,
      appProperties: { [UPLOAD_FOLDER_MARK]: input.idempotencyKey }
    });
    return { folder, created: true };
  })();
  inFlight.set(input.idempotencyKey, work);
  try {
    return await work;
  } finally {
    inFlight.delete(input.idempotencyKey);
  }
}
