export interface TranscriptSourceIdentity {
  driveVersion: string | null;
  checksum: string | null;
  mimeType: string | null;
  extension: string | null;
}

export interface TranscriptCatalogSnapshot {
  materialId: string;
  provenanceId: string | null;
  transcriptText: string | null;
  lifecycle: 'active' | 'trashed' | 'missing';
}

export function isTranscriptCommitCurrent(
  expected: TranscriptSourceIdentity,
  current: TranscriptSourceIdentity
): boolean {
  return (
    expected.driveVersion === current.driveVersion &&
    expected.checksum === current.checksum &&
    expected.mimeType === current.mimeType &&
    expected.extension === current.extension
  );
}

export function catalogTranscriptTransition(
  previous: TranscriptSourceIdentity | null,
  current: TranscriptSourceIdentity
): { clearText: boolean; queueIngest: boolean } {
  const changed = previous === null || !isTranscriptCommitCurrent(previous, current);
  return { clearText: changed, queueIngest: changed };
}

export function tombstoneTranscriptSnapshot<T extends TranscriptCatalogSnapshot>(
  snapshot: T
): T & { transcriptText: null; transcriptIngestState: 'unavailable' } {
  return {
    ...snapshot,
    lifecycle: 'missing',
    transcriptText: null,
    transcriptIngestState: 'unavailable'
  };
}
