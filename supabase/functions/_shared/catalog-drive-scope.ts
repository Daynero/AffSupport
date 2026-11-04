import type { DriveFileMetadata, GoogleDriveClient } from './drive.ts';

/** One HTTP attempt only. Never retain credentials/proofs between requests. */
export function catalogDriveScope(create: (credentialId: string) => Promise<GoogleDriveClient>) {
  const drives = new Map<string, Promise<GoogleDriveClient>>();
  const ancestors = new Map<string, Map<string, Promise<DriveFileMetadata>>>();
  const driveFor = (credentialId: string): Promise<GoogleDriveClient> => {
    let known = drives.get(credentialId);
    if (!known) {
      known = create(credentialId);
      drives.set(credentialId, known);
    }
    return known;
  };
  const ancestorFor = (credentialId: string) => (id: string) => {
    let cache = ancestors.get(credentialId);
    if (!cache) {
      cache = new Map();
      ancestors.set(credentialId, cache);
    }
    let known = cache.get(id);
    if (!known) {
      known = driveFor(credentialId).then(client => client.getFile(id));
      cache.set(id, known);
    }
    return known;
  };
  return { driveFor, ancestorFor };
}
