import { TeamFunctionError } from './errors.ts';
import {
  classifyThumbnailResponse,
  thumbnailCachePath,
  type ThumbnailUnavailableReason
} from './thumbnails.ts';

/**
 * One pass of the preview warm worker (011, FR-014): for each pending
 * material, fetch the provider's thumbnail into the cache and record the
 * outcome against the version it was fetched for. Provider pressure (rate
 * limit, outage, lost authorization) stops the pass and leaves the rest
 * pending; their leases lapse and the next tick picks them up.
 */
export interface PreviewWarmRow {
  materialId: string;
  teamId: string;
  connectionId: string;
  credentialId: string;
  driveFileId: string;
  resourceKey: string | null;
  driveVersion: string | null;
  mimeType: string | null;
}

export interface PreviewWarmLiveFile {
  trashed: boolean;
  mimeType: string;
  version: string | null;
  checksum: string | null;
  thumbnailLink: string | null;
}

export type PreviewWarmCommit =
  | { state: 'ready'; version: string }
  | { state: 'unavailable'; reason: ThumbnailUnavailableReason };

export interface PreviewWarmDependencies {
  getFile: (row: PreviewWarmRow) => Promise<PreviewWarmLiveFile>;
  fetchThumbnail: (
    row: PreviewWarmRow,
    thumbnailLink: string
  ) => Promise<{ status: number; mimeType: string; bytes: Uint8Array }>;
  store: (path: string, bytes: Uint8Array, mimeType: string) => Promise<void>;
  commit: (row: PreviewWarmRow, outcome: PreviewWarmCommit) => Promise<void>;
}

export interface PreviewWarmSummary {
  ready: number;
  unavailable: number;
  /** Left pending because the provider pushed back; retried on the next tick. */
  deferred: number;
  stoppedEarly: 'RATE_LIMITED' | 'DRIVE_UNAVAILABLE' | 'NEEDS_REAUTH' | null;
}

const STOP_CODES = new Set(['RATE_LIMITED', 'DRIVE_UNAVAILABLE', 'NEEDS_REAUTH']);

export async function runPreviewWarmSlice(
  rows: PreviewWarmRow[],
  dependencies: PreviewWarmDependencies
): Promise<PreviewWarmSummary> {
  const summary: PreviewWarmSummary = {
    ready: 0,
    unavailable: 0,
    deferred: 0,
    stoppedEarly: null
  };
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    try {
      const outcome = await warmOne(row, dependencies);
      await dependencies.commit(row, outcome);
      if (outcome.state === 'ready') summary.ready += 1;
      else summary.unavailable += 1;
    } catch (cause) {
      const code = cause instanceof TeamFunctionError ? cause.code : null;
      if (code && STOP_CODES.has(code)) {
        summary.stoppedEarly = code as PreviewWarmSummary['stoppedEarly'];
        summary.deferred += rows.length - index;
        return summary;
      }
      // Anything else is this one file's problem, not the provider's: the
      // catalog says so and moves on rather than retrying it forever.
      await dependencies.commit(row, { state: 'unavailable', reason: 'provider_missing' });
      summary.unavailable += 1;
    }
  }
  return summary;
}

async function warmOne(
  row: PreviewWarmRow,
  dependencies: PreviewWarmDependencies
): Promise<PreviewWarmCommit> {
  const live = await dependencies.getFile(row);
  if (live.trashed || !live.thumbnailLink) {
    return { state: 'unavailable', reason: 'provider_missing' };
  }
  const response = await dependencies.fetchThumbnail(row, live.thumbnailLink);
  const verdict = classifyThumbnailResponse({
    status: response.status,
    mimeType: response.mimeType,
    contentLength: response.bytes.byteLength
  });
  if (verdict.state === 'unavailable') return verdict;
  const version = live.version ?? row.driveVersion;
  const path = await thumbnailCachePath({
    teamId: row.teamId,
    materialId: row.materialId,
    sourceIdentity: live.version ?? live.checksum ?? row.driveVersion,
    mimeType: row.mimeType
  });
  if (!version || !path) return { state: 'unavailable', reason: 'provider_missing' };
  await dependencies.store(path, response.bytes, response.mimeType);
  return { state: 'ready', version };
}
