import { inspectArchive, type ArchiveInspection } from './zip-directory.ts';

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
