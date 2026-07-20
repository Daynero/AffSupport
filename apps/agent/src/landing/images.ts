import { spawn } from 'node:child_process';
import type { LandingImageQuality } from '@video-compressor/shared';
import { ffmpegPath } from '../ffmpeg/tools.js';
import { decodePng, encodeWebp } from './webp.js';

/**
 * Decodes any supported raster image to an 8-bit RGBA PNG using the bundled
 * FFmpeg. FFmpeg applies EXIF orientation and preserves transparency, so the
 * pixels handed to the WebP encoder already look exactly like the original.
 */
function decodeToPng(inputPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        inputPath,
        '-frames:v',
        '1',
        '-pix_fmt',
        'rgba',
        '-c:v',
        'png',
        '-f',
        'image2pipe',
        'pipe:1'
      ],
      { shell: false }
    );
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-4_000);
    });
    child.once('error', reject);
    child.once('close', code => {
      const output = Buffer.concat(chunks);
      if (code === 0 && output.byteLength > 0) resolve(output);
      else reject(new Error(stderr.trim() || `FFmpeg could not decode the image (code ${code}).`));
    });
  });
}

export interface OptimizedImage {
  webp: Buffer;
  width: number;
  height: number;
}

/** Converts a single image to WebP at the requested quality. */
export async function encodeImageToWebp(
  inputPath: string,
  quality: LandingImageQuality
): Promise<OptimizedImage> {
  const png = await decodeToPng(inputPath);
  const image = await decodePng(png);
  const webp = await encodeWebp(image, quality);
  return { webp, width: image.width, height: image.height };
}
