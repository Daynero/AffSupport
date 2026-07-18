import { randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { access, mkdir, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import path from 'node:path';
import type { ImageAsset, ImageMimeType } from '@video-compressor/shared';
import { probeImage } from '../ffmpeg/tools.js';
import { applicationSupportRoot } from '../files/support-dir.js';

const formats = {
  '.png': { mimeType: 'image/png', codec: 'png' },
  '.jpg': { mimeType: 'image/jpeg', codec: 'mjpeg' },
  '.jpeg': { mimeType: 'image/jpeg', codec: 'mjpeg' },
  '.webp': { mimeType: 'image/webp', codec: 'webp' }
} as const;

export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

export class ImageAssetError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export function defaultImageRoot() {
  return process.env.AGENT_IMAGE_PATH ?? path.join(applicationSupportRoot(), 'Images');
}

export function isSupportedImageFile(fileName: string, mimeType?: string) {
  const format = imageFormat(fileName);
  return Boolean(
    format && (!mimeType || mimeType === 'application/octet-stream' || mimeType === format.mimeType)
  );
}

export class ImageAssetStore {
  constructor(private readonly root = defaultImageRoot()) {}

  async import(
    stream: Readable & { truncated?: boolean },
    originalName: string,
    mimeType: string
  ): Promise<ImageAsset> {
    const format = imageFormat(originalName);
    if (!format || (mimeType !== 'application/octet-stream' && mimeType !== format.mimeType)) {
      stream.resume();
      throw new ImageAssetError('IMAGE_UNSUPPORTED_FORMAT');
    }

    await mkdir(this.root, { recursive: true });
    const id = randomUUID();
    const extension = format.extension;
    const destination = path.join(this.root, `${id}${extension}`);
    try {
      await pipeline(stream, createWriteStream(destination, { flags: 'wx' }));
      if (stream.truncated) throw new ImageAssetError('IMAGE_TOO_LARGE');
      const details = await stat(destination);
      if (!details.size || details.size > MAX_IMAGE_BYTES) {
        throw new ImageAssetError('IMAGE_TOO_LARGE');
      }
      const image = await probeImage(destination);
      if (!image || image.codec !== format.codec) throw new ImageAssetError('IMAGE_DAMAGED');
      return {
        id,
        fileName: path.basename(originalName).slice(0, 255) || `image${extension}`,
        width: image.width,
        height: image.height,
        size: details.size,
        mimeType: format.mimeType,
        extension
      };
    } catch (error) {
      await unlink(destination).catch(() => {});
      if (stream.truncated) throw new ImageAssetError('IMAGE_TOO_LARGE');
      if (error instanceof ImageAssetError) throw error;
      throw new ImageAssetError('IMAGE_IMPORT_FAILED');
    }
  }

  pathFor(asset: ImageAsset): string {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        asset.id
      ) ||
      !['.png', '.jpg', '.webp'].includes(asset.extension)
    ) {
      throw new ImageAssetError('IMAGE_UNAVAILABLE');
    }
    const candidate = path.resolve(this.root, `${asset.id}${asset.extension}`);
    if (path.dirname(candidate) !== path.resolve(this.root)) {
      throw new ImageAssetError('IMAGE_UNAVAILABLE');
    }
    return candidate;
  }

  async exists(asset: ImageAsset) {
    try {
      await access(this.pathFor(asset), constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async validate(asset: ImageAsset) {
    const filePath = this.pathFor(asset);
    try {
      await access(filePath, constants.R_OK);
    } catch {
      throw new ImageAssetError('IMAGE_UNAVAILABLE');
    }
    const image = await probeImage(filePath);
    const expectedCodec =
      asset.extension === '.png' ? 'png' : asset.extension === '.jpg' ? 'mjpeg' : 'webp';
    if (
      !image ||
      image.codec !== expectedCodec ||
      image.width !== asset.width ||
      image.height !== asset.height
    ) {
      throw new ImageAssetError('IMAGE_DAMAGED');
    }
    return filePath;
  }

  async remove(asset: ImageAsset) {
    await unlink(this.pathFor(asset)).catch(() => {});
  }
}

function imageFormat(fileName: string): {
  mimeType: ImageMimeType;
  codec: string;
  extension: ImageAsset['extension'];
} | null {
  const rawExtension = path.extname(fileName).toLowerCase() as keyof typeof formats;
  const format = formats[rawExtension];
  if (!format) return null;
  return {
    mimeType: format.mimeType,
    codec: format.codec,
    extension: rawExtension === '.jpeg' ? '.jpg' : rawExtension
  };
}
