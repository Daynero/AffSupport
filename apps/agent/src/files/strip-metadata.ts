import { closeSync, fstatSync, openSync, readSync, writeSync } from 'node:fs';
import { open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  detectMediaMetadataFormat,
  planIsoBmffMetadataPatches,
  stripMediaMetadata,
  type MediaByteSource,
  type MediaMetadataPatch
} from '@video-compressor/shared';
import { ffmpegPath } from '../ffmpeg/tools.js';
import { runTool } from '../stitcher/run.js';

/**
 * Making a file that is about to leave the machine say nothing about where it came from (073).
 *
 * The rules live in `packages/shared/src/media-metadata.ts`, so a download through the browser
 * and one through Soty come out byte-identical. This is the disk side: an MP4 or MOV is patched
 * where it lies (a few KB of writes on a file of any size, nothing re-encoded), an image is
 * rebuilt next to itself and moved into place, and a video in a container the shared code does
 * not walk (Matroska, WebM, AVI…) is re-muxed by FFmpeg with every tag left out.
 *
 * Fail closed: when a media file cannot be cleaned the caller gets METADATA_STRIP_FAILED and
 * decides, rather than a file that is quietly still carrying a GPS position.
 */

export type MetadataStripOutcome = 'cleaned' | 'already-clean' | 'not-media';

export class MetadataStripError extends Error {
  readonly code = 'METADATA_STRIP_FAILED';
  constructor(readonly reason: string) {
    super('METADATA_STRIP_FAILED');
  }
}

/** Larger images than this are not held in memory; no real still comes near it. */
const MAX_IMAGE_BYTES = 512 * 1024 * 1024;
const ZERO_CHUNK = 1024 * 1024;

/** Video containers handed to FFmpeg when the shared stripper does not walk them. */
const REMUX_EXTENSIONS = new Set([
  '.mkv',
  '.webm',
  '.avi',
  '.flv',
  '.wmv',
  '.asf',
  '.mpg',
  '.mpeg',
  '.ts',
  '.m2ts',
  '.mts',
  '.vob',
  '.ogv'
]);

async function readHead(file: string): Promise<Uint8Array> {
  const handle = await open(file, 'r');
  try {
    const head = new Uint8Array(64);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function fileSource(fd: number): MediaByteSource {
  const size = fstatSync(fd).size;
  return {
    size,
    read(offset, length) {
      const bytes = new Uint8Array(Math.max(0, Math.min(length, size - offset)));
      let filled = 0;
      while (filled < bytes.length) {
        const read = readSync(fd, bytes, filled, bytes.length - filled, offset + filled);
        if (read <= 0) break;
        filled += read;
      }
      return bytes.subarray(0, filled);
    }
  };
}

function applyPatches(fd: number, patches: readonly MediaMetadataPatch[]): void {
  const zeros = new Uint8Array(ZERO_CHUNK);
  for (const patch of patches) {
    if (patch.data) {
      writeSync(fd, patch.data, 0, patch.length, patch.offset);
      continue;
    }
    for (let done = 0; done < patch.length; done += ZERO_CHUNK) {
      writeSync(fd, zeros, 0, Math.min(ZERO_CHUNK, patch.length - done), patch.offset + done);
    }
  }
}

function sibling(file: string, tag: string): string {
  const parsed = path.parse(file);
  return path.join(parsed.dir, `.${parsed.name}.${tag}${parsed.ext}`);
}

/**
 * Cleans `file` where it lies. Only ever call it on a file Soty itself just produced (a download
 * in its own workspace, a copy about to be uploaded) — never on the person's original.
 */
export async function stripMetadataInPlace(
  file: string,
  options: { signal?: AbortSignal } = {}
): Promise<MetadataStripOutcome> {
  const head = await readHead(file);
  const format = detectMediaMetadataFormat(head);
  if (format === 'isobmff' || format === 'heif') {
    const fd = openSync(file, 'r+');
    try {
      const plan = planIsoBmffMetadataPatches(fileSource(fd));
      if (plan.supported) {
        applyPatches(fd, plan.patches);
        return plan.patches.length > 0 ? 'cleaned' : 'already-clean';
      }
    } catch (error) {
      throw new MetadataStripError(error instanceof Error ? error.message : 'isobmff');
    } finally {
      closeSync(fd);
    }
    // A movie whose header the shared code would not walk (fragmented, no `moov`): FFmpeg.
    if (format === 'isobmff') return remux(file, options.signal);
    throw new MetadataStripError('heif-unsupported');
  }
  if (format === 'jpeg' || format === 'png' || format === 'webp' || format === 'gif') {
    const { size } = await stat(file);
    if (size > MAX_IMAGE_BYTES) throw new MetadataStripError('image-too-large');
    const result = stripMediaMetadata(new Uint8Array(await readFile(file)));
    if (!result.supported) throw new MetadataStripError(`${format}-unreadable`);
    if (!result.changed) return 'already-clean';
    const temporary = sibling(file, 'soty-clean');
    try {
      await writeFile(temporary, result.bytes);
      await rename(temporary, file);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw new MetadataStripError(error instanceof Error ? error.message : 'write');
    }
    return 'cleaned';
  }
  if (REMUX_EXTENSIONS.has(path.extname(file).toLowerCase())) return remux(file, options.signal);
  return 'not-media';
}

/** Every tag, chapter and non-media stream left out; pictures and sound copied untouched. */
export function metadataRemuxArgs(input: string, output: string): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    '-map',
    '0:v?',
    '-map',
    '0:a?',
    '-c',
    'copy',
    '-map_metadata',
    '-1',
    '-map_metadata:s',
    '-1',
    '-map_chapters',
    '-1',
    // Without it the muxer writes its own name and version back in as `encoder`.
    '-fflags',
    '+bitexact',
    output
  ];
}

async function remux(file: string, signal?: AbortSignal): Promise<MetadataStripOutcome> {
  const temporary = sibling(file, 'soty-clean');
  await unlink(temporary).catch(() => {});
  const result = await runTool(ffmpegPath, metadataRemuxArgs(file, temporary), { signal });
  if (result.code !== 0) {
    await unlink(temporary).catch(() => {});
    throw new MetadataStripError(result.cancelled ? 'canceled' : 'remux');
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw new MetadataStripError(error instanceof Error ? error.message : 'rename');
  }
  return 'cleaned';
}
