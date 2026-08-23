import { requireBinaries, requirePath } from './requires.js';

/**
 * Shared requirement probes.
 *
 * These run once, at collection time, and are imported by every suite that needs a real
 * binary. Declaring them here rather than per-file means one probe per dependency for the
 * whole run instead of one per file, and — more importantly — one place to look when
 * asking why a suite skipped.
 */

/** Real media encoding and probing. Present on the maintainer's machine, absent on a bare runner. */
export const ffmpegBinaries = await requireBinaries('ffmpeg', 'ffprobe');

/** A built web bundle. Only produced by `build:web`, so absent on a clean checkout. */
export const webDistBuilt = requirePath('apps/web/dist');
