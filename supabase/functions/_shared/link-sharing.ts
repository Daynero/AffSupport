import type { GoogleDriveClient } from './drive.ts';
import { TeamFunctionError } from './errors.ts';

type SharingClient = Pick<GoogleDriveClient, 'listAnyonePermissions' | 'createAnyoneReaderPermission'>;

/**
 * Makes a Drive file viewable by anyone with its link, and proves it did (022).
 *
 * Adding the permission and trusting the response is not enough: a domain policy can accept the
 * request and still not grant it, and a catalog handed out with a link nobody can open is the
 * failure the owner would find first. So the permission list is read back.
 */
export async function ensureAnyoneReader(
  drive: SharingClient,
  fileId: string
): Promise<{ added: boolean }> {
  // Any `anyone` grant lets a link holder view; a commenter or writer link is not narrowed.
  const current = await drive.listAnyonePermissions(fileId);
  if (current.length > 0) return { added: false };
  await drive.createAnyoneReaderPermission(fileId);
  const verified = await drive.listAnyonePermissions(fileId);
  if (!verified.some(permission => permission.role === 'reader')) {
    throw new TeamFunctionError('SHARE_NOT_ALLOWED', { retryable: false });
  }
  return { added: true };
}
