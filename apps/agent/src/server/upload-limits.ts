/**
 * Per-route upload ceilings.
 *
 * The multipart plugin previously ran with a 100 GiB global file-size limit, which meant
 * every upload route was effectively unbounded and a route that forgot to state a limit
 * inherited that. The default is now restrictive, so forgetting is safe; routes that
 * genuinely handle large media opt in here.
 *
 * These are ceilings, not expectations. Soty is a video compressor — an hour of high
 * bit-rate footage really is tens of gigabytes, and pretending otherwise would break the
 * product to satisfy a limit. The point is that the number is stated, finite, and
 * attached to one route rather than inherited by all of them.
 */

/** Anything that does not state a limit. Deliberately small. */
export const DEFAULT_UPLOAD_BYTES = 32 * 1024 * 1024;

/** Source video and audio for compression and transcription. */
export const MAX_MEDIA_UPLOAD_BYTES = 20 * 1024 * 1024 * 1024;

/** A landing archive: many small assets plus markup, not raw footage. */
export const MAX_LANDING_ARCHIVE_BYTES = 512 * 1024 * 1024;

/** One asset inside a landing folder upload, sent file by file. */
export const MAX_LANDING_ASSET_BYTES = 32 * 1024 * 1024;

/**
 * The folder-upload session budget (contracts/agent-http.md §7, C8).
 *
 * Per-file ceilings do nothing against a hundred thousand files: the folder route is called
 * once per file, so before this a single session could fill the disk 32 MiB at a time, for as
 * long as it liked, at any depth. These bound the session as a whole. Exceeding any of them
 * ends the session — `413 UPLOAD_BUDGET_EXCEEDED`, temporary directory removed — rather than
 * leaving it half-written.
 */
export interface FolderUploadLimits {
  maxFiles: number;
  maxBytes: number;
  maxDurationMs: number;
  /** Segments in one relative path, after `.`/`..`/empty segments are dropped. */
  maxDepth: number;
  /** Characters in one segment; 255 is what common filesystems accept anyway. */
  maxSegmentLength: number;
}

export const FOLDER_UPLOAD_LIMITS: Readonly<FolderUploadLimits> = Object.freeze({
  maxFiles: 5_000,
  maxBytes: 2 * 1024 * 1024 * 1024,
  maxDurationMs: 10 * 60 * 1000,
  maxDepth: 16,
  maxSegmentLength: 255
});

export const UPLOAD_BUDGET_EXCEEDED = 'UPLOAD_BUDGET_EXCEEDED';

/** True when a sanitised relative path is within the depth and segment-length bounds. */
export function withinPathBounds(
  relPath: string,
  limits: Pick<FolderUploadLimits, 'maxDepth' | 'maxSegmentLength'> = FOLDER_UPLOAD_LIMITS
): boolean {
  const segments = relPath.split('/');
  return (
    segments.length <= limits.maxDepth &&
    segments.every(segment => segment.length <= limits.maxSegmentLength)
  );
}

/** What one folder-upload session has spent so far. */
export class FolderUploadBudget {
  private files = 0;
  private bytes = 0;
  private readonly startedAt: number;

  constructor(
    readonly limits: Readonly<FolderUploadLimits> = FOLDER_UPLOAD_LIMITS,
    private readonly now: () => number = Date.now
  ) {
    this.startedAt = now();
  }

  /** The wall clock is spent. Checked on every file and at finish, not by a timer. */
  expired(): boolean {
    return this.now() - this.startedAt > this.limits.maxDurationMs;
  }

  /** Counts one more file; false when the count or the clock is already spent. */
  admitFile(): boolean {
    if (this.expired() || this.files >= this.limits.maxFiles) return false;
    this.files += 1;
    return true;
  }

  /** Bytes the session may still write; the next file's ceiling is the smaller of this and its own. */
  remainingBytes(): number {
    return Math.max(0, this.limits.maxBytes - this.bytes);
  }

  /** Records a written file's size; false once the session total is over budget. */
  addBytes(size: number): boolean {
    this.bytes += size;
    return this.bytes <= this.limits.maxBytes;
  }
}
