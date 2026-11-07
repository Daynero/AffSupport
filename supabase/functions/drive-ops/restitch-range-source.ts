import { SCREEN_SELECTION_BOUNDS } from '../../../packages/shared/dist/team/restitch-selection.js';
import { GoogleDriveClient, proveLiveAncestry } from '../_shared/drive.ts';
import { refreshGoogleAccessToken } from '../_shared/credentials.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import type { RestitchRangeDependencies } from './restitch-range-reader.ts';

/** Private resolver output: never construct this from HTTP fields or grant claims.
 * Read credentials and frozen candidate context before reserving measured I/O.
 */
export interface FrozenRestitchRangeSource {
  fileId: string;
  resourceKey: string | null;
  parentFolderId: string;
  rootFolderId: string;
  sizeBytes: number;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  checksum: string;
}
type TokenInput = Parameters<typeof refreshGoogleAccessToken>[0];
export interface RestitchRangeSourceCredentials {
  credential: TokenInput['credential'];
  clientId: string;
  clientSecret: string;
  oauthMode: TokenInput['oauthMode'];
  productionSignals: TokenInput['productionSignals'];
}

/** This adapter performs no DB work and cannot select or change a candidate.
 * Both clients are metered by the reserved reader, including token/metadata bodies.
 */
export function createRestitchRangeOpener(
  frozenSource: FrozenRestitchRangeSource,
  credentials: RestitchRangeSourceCredentials
): RestitchRangeDependencies['open'] {
  const source = { ...frozenSource };
  const tokenInput = {
    ...credentials,
    credential: { ...credentials.credential },
    productionSignals: { ...credentials.productionSignals }
  };
  if (
    !source.fileId ||
    source.fileId.length > 1024 ||
    !source.parentFolderId ||
    !source.rootFolderId ||
    !Number.isSafeInteger(source.sizeBytes) ||
    source.sizeBytes < 1 ||
    source.sizeBytes > SCREEN_SELECTION_BOUNDS.screenBytes ||
    !['image/png', 'image/jpeg', 'image/webp'].includes(source.mimeType) ||
    !/^[0-9a-f]{32}$/u.test(source.checksum)
  )
    throw new TeamFunctionError('RESTITCH_SOURCES_INVALID');
  return async (io, range) => {
    const token = await refreshGoogleAccessToken({ ...tokenInput, fetchImpl: io.fetch });
    if (io.signal.aborted) throw new TeamFunctionError('PROCESS_CANCELED');
    const client = new GoogleDriveClient(token.accessToken, io.fetch);
    const metadata = await client.getFile(source.fileId, source.resourceKey);
    if (io.signal.aborted) throw new TeamFunctionError('PROCESS_CANCELED');
    if (
      metadata.trashed ||
      !metadata.capabilities.canDownload ||
      !metadata.parents.includes(source.parentFolderId)
    )
      throw new TeamFunctionError('PERMISSION_DENIED');
    if (
      metadata.id !== source.fileId ||
      metadata.size !== source.sizeBytes ||
      metadata.mimeType !== source.mimeType ||
      metadata.checksum !== source.checksum
    )
      throw new TeamFunctionError('SOURCE_CHANGED');
    await proveLiveAncestry({
      client: {
        getFile: (fileId, resourceKey) =>
          fileId === source.fileId ? Promise.resolve(metadata) : client.getFile(fileId, resourceKey)
      },
      fileId: source.fileId,
      resourceKey: source.resourceKey,
      rootFolderId: source.rootFolderId
    });
    // Content identity is checksum/size/MIME, so metadata-only version changes
    // do not make an unchanged frozen image a new candidate or reset its budget.
    return new GoogleDriveClient(token.accessToken, io.fetchPayload).fetchFileRange({
      fileId: source.fileId,
      resourceKey: source.resourceKey,
      ...range,
      signal: io.signal
    });
  };
}
