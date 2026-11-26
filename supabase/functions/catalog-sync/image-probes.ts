import type { DriveFileMetadata } from '../_shared/drive.ts';
import { isRecord } from '../_shared/validation.ts';

/**
 * What Drive itself says of a picture, kept beside the catalog (2026-11-26).
 *
 * A file named `photo.png` is an image to Drive whatever its bytes are, and a space's re-stitch
 * pools used to draw such files only to have the agent fail to decode them. Drive does read a
 * real picture, though: `imageMediaMetadata` carries its width and height. A scan records what it
 * saw for every file a pool could take, and `private.restitch_screen_defect` reads it.
 *
 * Silence is evidence only once Drive has had time to read the file. Dimensions appear some time
 * after an upload, so a file younger than the settle window with none is left unrecorded: nothing
 * is known about it, and the pools keep it until something is.
 */
export const DRIVE_IMAGE_SETTLE_MS = 15 * 60 * 1000;
/** The recording function's own ceiling for one call. */
export const DRIVE_IMAGE_PROBE_BATCH = 1000;

const SCREEN_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MD5 = /^[0-9a-f]{32}$/u;

export interface DriveImageProbe {
  driveFileId: string;
  checksum: string;
  width: number | null;
  height: number | null;
  /** Drive has held the file long enough for missing dimensions to mean "no picture". */
  settled: boolean;
}

export function driveImageProbes(
  files: readonly DriveFileMetadata[],
  now: number
): DriveImageProbe[] {
  const probes: DriveImageProbe[] = [];
  for (const file of files) {
    if (
      file.trashed ||
      file.shortcutTargetId ||
      !SCREEN_MIME_TYPES.has(file.mimeType.toLowerCase()) ||
      typeof file.checksum !== 'string' ||
      !MD5.test(file.checksum)
    )
      continue;
    const created = typeof file.createdAt === 'string' ? Date.parse(file.createdAt) : Number.NaN;
    probes.push({
      driveFileId: file.id,
      checksum: file.checksum,
      width: file.imageSize?.width ?? null,
      height: file.imageSize?.height ?? null,
      settled: Number.isFinite(created) && now - created >= DRIVE_IMAGE_SETTLE_MS
    });
  }
  return probes;
}

interface ProbeRpc {
  rpc: (
    name: string,
    parameters: Record<string, unknown>
  ) => Promise<{ data: unknown; error: { code?: unknown } | null }>;
}

/**
 * Best effort, after the page itself is committed: a scan must never fail, repeat a page or lose
 * its lease over a note about pictures. A database that does not know the function yet (the
 * functions were deployed ahead of the migration) is the same as nothing to record.
 */
export async function recordDriveImageProbes(
  client: ProbeRpc,
  connectionId: string,
  files: readonly DriveFileMetadata[],
  now: number = Date.now()
): Promise<number> {
  const probes = driveImageProbes(files, now);
  let recorded = 0;
  for (let start = 0; start < probes.length; start += DRIVE_IMAGE_PROBE_BATCH) {
    try {
      const { data, error } = await client.rpc('service_record_drive_image_probes', {
        p_connection: connectionId,
        p_probes: probes.slice(start, start + DRIVE_IMAGE_PROBE_BATCH)
      });
      if (error) {
        console.warn('catalog_sync_image_probes_skipped', {
          code: isRecord(error) && typeof error.code === 'string' ? error.code.slice(0, 8) : null
        });
        return recorded;
      }
      if (typeof data === 'number' && Number.isSafeInteger(data)) recorded += data;
    } catch {
      console.warn('catalog_sync_image_probes_skipped', { code: null });
      return recorded;
    }
  }
  return recorded;
}
