/** Safe local diagnostic detail; contains no source identity or content. */
export type TeamSourceIntegrityReason = 'checksum_invalid' | 'checksum_mismatch' | 'size_mismatch';

/**
 * A source whose bytes are not the ones the server named. Its own module so both transfers —
 * Drive (`transfer.ts`) and R2 (`r2-transfer.ts`) — raise the same error without importing
 * each other.
 */
export class TeamSourceIntegrityError extends Error {
  readonly reason: TeamSourceIntegrityReason;
  constructor(reason: TeamSourceIntegrityReason) {
    super(reason === 'checksum_invalid' ? 'INVALID_RESPONSE' : 'SOURCE_CHANGED');
    this.reason = reason;
  }
}
