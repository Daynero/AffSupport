import { rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ffmpegPath } from '../ffmpeg/tools.js';
import { runCommand } from './workspace.js';

/**
 * Stripping metadata from a file the run is otherwise leaving alone.
 *
 * Media that gets re-encoded loses its metadata on the way through: an image is decoded to
 * raw pixels before it becomes WebP, and the video preset has always asked for the tags to be
 * dropped. What is left is everything the run decided not to touch — a video already smaller
 * than we could make it, an image that gained nothing — and those still carry the camera, the
 * editing software and, on a phone-shot clip, where it was shot. On a landing that ships to a
 * client that is the one file that gives away more than the page does.
 *
 * A stream copy, so nothing is re-encoded and nothing is re-compressed: the same pictures and
 * the same samples, with the tags left out. It is written beside the original and moved into
 * place only once FFmpeg has succeeded, so a failure leaves the file exactly as it was.
 */
export async function stripFileMetadata(absPath: string): Promise<boolean> {
  const parsed = path.parse(absPath);
  const temporary = path.join(parsed.dir, `.${parsed.name}.soty-meta${parsed.ext}`);
  await unlink(temporary).catch(() => {});
  const result = await runCommand(ffmpegPath, [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-i',
    absPath,
    '-map',
    '0',
    '-c',
    'copy',
    // Everything a container can carry about where the file came from.
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    // A stripped file that still names its encoder has not been stripped.
    '-fflags',
    '+bitexact',
    '-flags:v',
    '+bitexact',
    '-flags:a',
    '+bitexact',
    temporary
  ]);
  if (result.code !== 0) {
    await unlink(temporary).catch(() => {});
    return false;
  }
  try {
    await rename(temporary, absPath);
    return true;
  } catch {
    await unlink(temporary).catch(() => {});
    return false;
  }
}
