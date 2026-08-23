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
