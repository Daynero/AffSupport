import {
  inspectArchive,
  ZIP_DIRECTORY_MAX_BYTES,
  type ArchiveInspection
} from './zip-directory.ts';
import { BodyLimitError, readBoundedBody } from './http-body.ts';

/** A provider may ignore Range; only a proven, bounded range reaches the ZIP parser. */
export async function readArchiveRange(
  response: Response,
  start: number,
  end: number,
  fileSize: number
): Promise<Uint8Array | null> {
  const expected = end - start + 1;
  const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/u);
  const validRange =
    response.status === 206 &&
    range &&
    Number(range[1]) === start &&
    Number(range[2]) === end &&
    Number(range[3]) === fileSize;
  const fullSmallFile = response.status === 200 && start === 0 && end === fileSize - 1;
  const length = response.headers.get('content-length');
  if (
    ![start, end, fileSize].every(Number.isSafeInteger) ||
    start < 0 ||
    end < start ||
    end >= fileSize ||
    expected > ZIP_DIRECTORY_MAX_BYTES ||
    (!validRange && !fullSmallFile) ||
    (length !== null && (!/^\d+$/u.test(length) || Number(length) !== expected))
  ) {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
  try {
    const bytes = await readBoundedBody(response.body, expected);
    return bytes.byteLength === expected ? bytes : null;
  } catch (error) {
    if (error instanceof BodyLimitError) return null;
    throw error;
  }
}

/** One claimed archive, as `service_claim_archive_inspections` returns it. */
export interface ArchiveInspectionRow {
  materialId: string;
  teamId: string;
  credentialId: string;
  driveFileId: string;
  resourceKey: string | null;
  driveVersion: string | null;
  checksum: string | null;
  sizeBytes: number;
}

export interface ArchiveInspectionDependencies {
  /** Bytes `[start, end]` of the file as Drive holds it now, or null when refused. */
  fetchRange: (row: ArchiveInspectionRow, start: number, end: number) => Promise<Uint8Array | null>;
  commit: (row: ArchiveInspectionRow, inspection: ArchiveInspection) => Promise<unknown>;
}

/**
 * The preview-warm pass over new archives (011, findings J2): read each
 * one's central directory and let the catalog know whether a landing page is
 * inside. Every row gets a decision — a provider refusal is recorded as
 * unavailable rather than left for the next claim to repeat.
 */
export async function runArchiveInspectionSlice(
  rows: readonly ArchiveInspectionRow[],
  dependencies: ArchiveInspectionDependencies
): Promise<{ landings: number; archives: number; unavailable: number }> {
  const summary = { landings: 0, archives: 0, unavailable: 0 };
  for (const row of rows) {
    let inspection: ArchiveInspection;
    try {
      inspection = await inspectArchive({
        fileSize: row.sizeBytes,
        sourceVersion: row.driveVersion,
        sourceChecksum: row.checksum,
        fetchRange: (start, end) => dependencies.fetchRange(row, start, end)
      });
    } catch {
      inspection = { outcome: 'unavailable', reason: 'unreadable' };
    }
    await dependencies.commit(row, inspection);
    if (inspection.outcome === 'landing') summary.landings += 1;
    else if (inspection.outcome === 'archive') summary.archives += 1;
    else summary.unavailable += 1;
  }
  return summary;
}
