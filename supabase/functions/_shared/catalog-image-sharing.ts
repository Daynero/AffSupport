import type { GoogleDriveClient } from './drive.ts';
import { ensureAnyoneReader } from './link-sharing.ts';

type SharingClient = Pick<
  GoogleDriveClient,
  'listAnyonePermissions' | 'createAnyoneReaderPermission'
>;

const PARALLEL = 8;

/**
 * One catalog attempt's image checks. Reuse only within that attempt (for growth followed by
 * refresh), never across credentials, retries or updater rounds. Each permission mutation
 * still includes ensureAnyoneReader's read-back, including durable permission receipts.
 */
export function createCatalogImageSharer(drive: SharingClient) {
  const verified = new Set<string>();
  return async (images: ReadonlyArray<{ driveFileId: string }>): Promise<void> => {
    const queue = [...new Set(images.map(image => image.driveFileId))].filter(
      id => !verified.has(id)
    );
    let failure: { error: unknown } | undefined;
    const workers = Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
      while (!failure) {
        const fileId = queue.shift();
        if (fileId === undefined) return;
        try {
          await ensureAnyoneReader(drive, fileId);
          verified.add(fileId);
        } catch (error) {
          failure ??= { error };
        }
      }
    });
    // A fail-fast Promise.all would let other workers keep changing permissions after
    // the caller records interruption or releases the attempt. Drain every started check.
    await Promise.all(workers);
    if (failure) throw failure.error;
  };
}
