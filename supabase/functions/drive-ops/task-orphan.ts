import type { GoogleDriveClient } from '../_shared/drive.ts';

/** Drive's returned file state is the only provider confirmation. */
export async function moveTaskOrphanToTrash(
  drive: Pick<GoogleDriveClient, 'updateFileMetadata'>,
  fileId: string,
  resourceKey: string | null
): Promise<'confirmed' | 'active' | 'unknown'> {
  const result = await drive.updateFileMetadata({ fileId, resourceKey, trashed: true });
  if (result.id !== fileId) return 'unknown';
  return result.trashed === true ? 'confirmed' : 'active';
}
