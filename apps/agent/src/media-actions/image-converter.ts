import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { access, copyFile, link, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { spawnTracked } from '../power/spawn.js';
import path from 'node:path';
import { ffmpegPath, probeImage } from '../ffmpeg/tools.js';
import { encodeImageToWebp } from '../landing/images.js';
import { IMAGE_CONVERSION_FORMATS, type ImageConversionFormat } from '@video-compressor/shared';

// Declared in the shared package because the interface renders it, and a set the two
// processes enumerate separately is a set they will eventually disagree on.
export { IMAGE_CONVERSION_FORMATS };
export type { ImageConversionFormat };

export const IMAGE_CONVERSION_EXTENSIONS: Record<ImageConversionFormat, '.png' | '.jpg' | '.webp'> =
  {
    png: '.png',
    jpeg: '.jpg',
    webp: '.webp'
  };

const EXPECTED_CODECS: Record<ImageConversionFormat, string> = {
  png: 'png',
  jpeg: 'mjpeg',
  webp: 'webp'
};

const MAX_IMAGE_PIXELS = 100_000_000;

export class ImageConversionError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ImageConversionError';
  }
}

export function isImageConversionFormat(value: unknown): value is ImageConversionFormat {
  return IMAGE_CONVERSION_FORMATS.includes(value as ImageConversionFormat);
}

export function sourceAlreadyUsesFormat(inputPath: string, format: ImageConversionFormat) {
  const extension = path.extname(inputPath).toLowerCase();
  if (format === 'jpeg') return extension === '.jpg' || extension === '.jpeg';
  return extension === IMAGE_CONVERSION_EXTENSIONS[format];
}

export async function convertImage(
  inputPath: string,
  outputPath: string,
  format: ImageConversionFormat,
  signal?: AbortSignal
) {
  if (signal?.aborted) throw conversionCancelled();
  let details: Stats;
  try {
    details = await stat(inputPath);
    await Promise.all([
      access(inputPath, constants.R_OK),
      access(path.dirname(outputPath), constants.W_OK)
    ]);
  } catch (error) {
    if (['EACCES', 'EPERM', 'EROFS'].includes(errorCode(error) ?? '')) {
      throw new ImageConversionError(
        'PERMISSION_DENIED',
        'Soty does not have permission to read this image or create a file beside it.'
      );
    }
    throw new ImageConversionError('INPUT_UNAVAILABLE', 'The selected image is unavailable.');
  }
  if (!details.isFile()) {
    throw new ImageConversionError('INPUT_UNAVAILABLE', 'The selected image is unavailable.');
  }
  const source = await probeImage(inputPath);
  if (!source) {
    throw new ImageConversionError(
      'INPUT_UNSUPPORTED',
      'The selected file is not a supported raster image.'
    );
  }
  if (source.codec === 'gif' || source.codec === 'apng' || (source.frames ?? 1) > 1) {
    throw new ImageConversionError(
      'ANIMATED_IMAGE_UNSUPPORTED',
      'Animated images are not converted because that would discard their animation.'
    );
  }
  if (source.width * source.height > MAX_IMAGE_PIXELS) {
    throw new ImageConversionError(
      'IMAGE_TOO_LARGE',
      'The selected image is too large to convert safely.'
    );
  }

  const temporary = temporaryOutputPath(outputPath);
  try {
    if (format === 'webp') {
      // WebP encoding is in-process and has no signal to hand it, so the stop
      // lands on either side of it rather than inside. One image is bounded
      // work; a queue of them is not, and the queue is what the stop is for.
      const encoded = await encodeImageToWebp(inputPath, 'conversion');
      if (signal?.aborted) throw conversionCancelled();
      await writeFile(temporary, encoded.webp, { flag: 'wx' });
    } else {
      await encodeWithFfmpeg(inputPath, temporary, format, source.width, source.height, signal);
    }

    const output = await probeImage(temporary);
    if (
      !output ||
      output.codec !== EXPECTED_CODECS[format] ||
      output.width !== source.width ||
      output.height !== source.height
    ) {
      throw new ImageConversionError(
        'OUTPUT_INVALID',
        'Soty could not validate the converted image.'
      );
    }
    await publishWithoutOverwrite(temporary, outputPath);
    return {
      outputPath,
      width: output.width,
      height: output.height,
      size: (await stat(outputPath)).size
    };
  } catch (error) {
    if (
      !(error instanceof ImageConversionError) &&
      ['EACCES', 'EPERM', 'EROFS'].includes(errorCode(error) ?? '')
    ) {
      throw new ImageConversionError(
        'PERMISSION_DENIED',
        'Soty does not have permission to create the converted image beside the original.'
      );
    }
    throw error;
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function temporaryOutputPath(outputPath: string) {
  const parsed = path.parse(outputPath);
  return path.join(parsed.dir, `.${temporaryPrefix(parsed.name)}${randomUUID()}${parsed.ext}`);
}

function temporaryPrefix(name: string) {
  return `${name}.soty-`;
}

/**
 * Removes the half-written temporaries this converter may have left beside `outputPath`.
 *
 * `convertImage` unlinks its own temporary as it unwinds, so this is for the case where it
 * never got to: a quit that ran out of patience and signalled the encoder, or an agent the
 * launcher killed outright. What is left then is a partial file beside the user's original
 * that nothing will ever finish or claim.
 *
 * Matched by the converter's own marker and a UUID rather than by prefix alone, so it can
 * only ever remove a file this application wrote.
 */
export async function removeConversionTemporaries(outputPath: string): Promise<void> {
  const parsed = path.parse(outputPath);
  const prefix = `.${temporaryPrefix(parsed.name)}`;
  const entries = await readdir(parsed.dir).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter(entry => entry.startsWith(prefix) && entry.endsWith(parsed.ext))
      .filter(entry => UUID.test(entry.slice(prefix.length, entry.length - parsed.ext.length)))
      .map(entry => unlink(path.join(parsed.dir, entry)).catch(() => {}))
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function conversionCancelled() {
  return new ImageConversionError('CONVERSION_CANCELLED', 'The image conversion was stopped.');
}

function encodeWithFfmpeg(
  inputPath: string,
  outputPath: string,
  format: Exclude<ImageConversionFormat, 'webp'>,
  width: number,
  height: number,
  signal?: AbortSignal
) {
  const args =
    format === 'png'
      ? [
          '-hide_banner',
          '-nostdin',
          '-loglevel',
          'error',
          '-n',
          '-i',
          inputPath,
          '-map_metadata',
          '-1',
          '-frames:v',
          '1',
          '-c:v',
          'png',
          '-compression_level',
          '6',
          outputPath
        ]
      : [
          '-hide_banner',
          '-nostdin',
          '-loglevel',
          'error',
          '-n',
          '-f',
          'lavfi',
          '-i',
          `color=c=white:s=${width}x${height}`,
          '-i',
          inputPath,
          '-filter_complex',
          '[0:v][1:v]overlay=shortest=1:format=auto,format=yuvj420p[out]',
          '-map',
          '[out]',
          '-map_metadata',
          '-1',
          '-frames:v',
          '1',
          '-c:v',
          'mjpeg',
          '-q:v',
          '2',
          outputPath
        ];

  return new Promise<void>((resolve, reject) => {
    const child = spawnTracked(ffmpegPath, args, { toolId: 'media-actions' });
    // A stop has to reach the encoder itself, not just the promise waiting on
    // it: FFmpeg is the part actually holding the machine, and one left running
    // behind a queue that reports itself stopped is invisible to everything
    // except the power readout. The spawn seam escalates to SIGKILL if it does
    // not go quietly.
    const abort = () => child.kill('SIGTERM');
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-4_000);
    });
    child.once('close', () => signal?.removeEventListener('abort', abort));
    child.once('error', error => {
      reject(
        new ImageConversionError(
          'ENCODER_UNAVAILABLE',
          error instanceof Error ? error.message : 'The image encoder is unavailable.'
        )
      );
    });
    child.once('close', code => {
      if (code === 0) resolve();
      // A killed encoder is a stop, not a failure: reporting the signal as an
      // encoding error would put a red row in front of the user for doing
      // exactly what they asked.
      else if (signal?.aborted) reject(conversionCancelled());
      else {
        reject(
          new ImageConversionError(
            'ENCODE_FAILED',
            stderr.trim() || `The image encoder exited with code ${code}.`
          )
        );
      }
    });
  });
}

async function publishWithoutOverwrite(temporary: string, outputPath: string) {
  try {
    await link(temporary, outputPath);
    return;
  } catch (error) {
    const code = errorCode(error);
    if (code === 'EEXIST') {
      throw new ImageConversionError('OUTPUT_EXISTS', 'A file already uses the output name.');
    }
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(code ?? '')) throw error;
  }
  try {
    await copyFile(temporary, outputPath, constants.COPYFILE_EXCL);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      throw new ImageConversionError('OUTPUT_EXISTS', 'A file already uses the output name.');
    }
    throw error;
  }
}

function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}
