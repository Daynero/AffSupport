import { randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ffmpegPath } from '../ffmpeg/tools.js';
import { runCommand } from './workspace.js';

export type LandingPreviewSide = 'before' | 'after';
export type LandingPreviewVariant = 'full' | 'thumbnail';

export interface LandingPreviewContent {
  filePath: string;
  mimeType: string;
}

interface PreviewRecord {
  beforePath: string;
  afterPath: string | null;
  beforeMimeType: string;
  width: number | null;
  height: number | null;
}

/**
 * Keeps exact local before/after image pairs outside the landing output tree.
 * Records are addressed only by generated asset ids, so preview routes never
 * accept or resolve a user-controlled filesystem path.
 */
export class LandingPreviewStore {
  private root: string | null = null;
  private records = new Map<string, PreviewRecord>();
  private thumbnailWork = new Map<string, Promise<string | null>>();

  useWorkspace(workspace: string) {
    this.root = path.join(workspace, 'previews');
    this.records.clear();
    this.thumbnailWork.clear();
  }

  clear() {
    this.root = null;
    this.records.clear();
    this.thumbnailWork.clear();
  }

  async cache(
    assetId: string,
    originalPath: string,
    optimizedWebp: Buffer,
    width: number,
    height: number
  ): Promise<boolean> {
    if (!this.root || !isAssetId(assetId)) return false;
    const beforeFormat = originalFormat(originalPath);
    if (!beforeFormat) return false;
    await mkdir(this.root, { recursive: true });
    const beforePath = path.join(this.root, `${assetId}-before${beforeFormat.extension}`);
    const afterPath = path.join(this.root, `${assetId}-after.webp`);
    try {
      await copyFile(originalPath, beforePath);
      await writeFile(afterPath, optimizedWebp, { flag: 'wx' });
      this.records.set(assetId, {
        beforePath,
        afterPath,
        beforeMimeType: beforeFormat.mimeType,
        width,
        height
      });
      return true;
    } catch {
      await Promise.all([unlink(beforePath).catch(() => {}), unlink(afterPath).catch(() => {})]);
      return false;
    }
  }

  /** Keeps a single original preview when optimization intentionally leaves the file unchanged. */
  async cacheOriginal(
    assetId: string,
    originalPath: string,
    width: number | null = null,
    height: number | null = null
  ): Promise<boolean> {
    if (!this.root || !isAssetId(assetId)) return false;
    const beforeFormat = originalFormat(originalPath);
    if (!beforeFormat) return false;
    await mkdir(this.root, { recursive: true });
    const beforePath = path.join(this.root, `${assetId}-before${beforeFormat.extension}`);
    try {
      await copyFile(originalPath, beforePath);
      this.records.set(assetId, {
        beforePath,
        afterPath: null,
        beforeMimeType: beforeFormat.mimeType,
        width,
        height
      });
      return true;
    } catch {
      await unlink(beforePath).catch(() => {});
      return false;
    }
  }

  async remove(assetId: string) {
    const record = this.records.get(assetId);
    this.records.delete(assetId);
    if (!record) return;
    const paths = [
      record.beforePath,
      record.afterPath,
      thumbnailPath(record.beforePath),
      record.afterPath ? thumbnailPath(record.afterPath) : null
    ].filter((filePath): filePath is string => filePath !== null);
    await Promise.all(paths.map(filePath => unlink(filePath).catch(() => {})));
  }

  metadata(
    assetId: string
  ): { comparison: boolean; width: number | null; height: number | null } | null {
    const record = this.records.get(assetId);
    return record
      ? {
          comparison: record.afterPath !== null,
          width: record.width,
          height: record.height
        }
      : null;
  }

  async content(
    assetId: string,
    side: LandingPreviewSide,
    variant: LandingPreviewVariant
  ): Promise<LandingPreviewContent | null> {
    const record = this.records.get(assetId);
    if (!record) return null;
    const sourcePath = side === 'before' ? record.beforePath : record.afterPath;
    if (!sourcePath) return null;
    if (variant === 'full') {
      if (!(await readable(sourcePath))) return null;
      return {
        filePath: sourcePath,
        mimeType: side === 'before' ? record.beforeMimeType : 'image/webp'
      };
    }
    const filePath = await this.ensureThumbnail(sourcePath);
    return filePath ? { filePath, mimeType: 'image/png' } : null;
  }

  private ensureThumbnail(sourcePath: string): Promise<string | null> {
    const target = thumbnailPath(sourcePath);
    const existing = this.thumbnailWork.get(target);
    if (existing) return existing;
    const work = thumbnailLimiter
      .run(() => createThumbnail(sourcePath, target))
      .finally(() => {
        this.thumbnailWork.delete(target);
      });
    this.thumbnailWork.set(target, work);
    return work;
  }
}

async function createThumbnail(sourcePath: string, target: string): Promise<string | null> {
  if (await readable(target)) return target;
  const temporary = `${target}.${randomUUID()}.png`;
  const result = await runCommand(ffmpegPath, [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    sourcePath,
    '-frames:v',
    '1',
    '-vf',
    "scale=w='min(320,iw)':h='min(320,ih)':force_original_aspect_ratio=decrease",
    '-pix_fmt',
    'rgba',
    '-c:v',
    'png',
    '-y',
    temporary
  ]);
  if (result.code !== 0) {
    await unlink(temporary).catch(() => {});
    return null;
  }
  try {
    await rename(temporary, target);
    return target;
  } catch {
    await unlink(temporary).catch(() => {});
    return (await readable(target)) ? target : null;
  }
}

function thumbnailPath(sourcePath: string) {
  return `${sourcePath}.thumbnail.png`;
}

async function readable(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function originalFormat(filePath: string): { extension: string; mimeType: string } | null {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') {
    return { extension, mimeType: 'image/jpeg' };
  }
  if (extension === '.png') return { extension, mimeType: 'image/png' };
  if (extension === '.webp') return { extension, mimeType: 'image/webp' };
  if (extension === '.gif') return { extension, mimeType: 'image/gif' };
  if (extension === '.svg') return { extension, mimeType: 'image/svg+xml' };
  return null;
}

function isAssetId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

class WorkLimiter {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  run<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active += 1;
        void Promise.resolve()
          .then(work)
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            this.queue.shift()?.();
          });
      };
      if (this.active < this.limit) start();
      else this.queue.push(start);
    });
  }
}

const thumbnailLimiter = new WorkLimiter(2);
