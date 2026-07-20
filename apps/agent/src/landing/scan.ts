import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { isSupportedVideoPath } from '../queue/queue.js';
import { toPosix } from './references.js';

/** Raster formats safe to convert to WebP. */
const OPTIMIZABLE_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
/** Images we deliberately leave untouched (animation / vector safety). */
const PRESERVED_IMAGE_EXTENSIONS = new Set(['.gif', '.svg']);

/** Entries that are byproducts of archiving and never part of the landing. */
const IGNORED_NAMES = new Set(['.DS_Store', '__MACOSX', 'Thumbs.db']);

export type AssetClass = 'image' | 'image-preserved' | 'video' | null;

export function classifyAsset(relPath: string): AssetClass {
  const extension = path.extname(relPath).toLowerCase();
  if (OPTIMIZABLE_IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (PRESERVED_IMAGE_EXTENSIONS.has(extension)) return 'image-preserved';
  if (isSupportedVideoPath(relPath)) return 'video';
  return null;
}

export interface ScannedFile {
  /** POSIX path relative to the landing root. */
  relPath: string;
  absPath: string;
  size: number;
}

/** Recursively lists every regular file under a directory (POSIX rel paths). */
export async function walkFiles(root: string): Promise<ScannedFile[]> {
  const files: ScannedFile[] = [];
  async function recurse(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name)) continue;
      const absPath = path.join(dir, entry.name);
      // Never follow symlinks: they could escape the working copy.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await recurse(absPath);
      } else if (entry.isFile()) {
        const info = await stat(absPath);
        files.push({ relPath: toPosix(path.relative(root, absPath)), absPath, size: info.size });
      }
    }
  }
  await recurse(root);
  return files;
}

/**
 * Detects the true landing root inside an unpacked/copied workspace. Archives
 * commonly wrap everything in a single top-level folder; when that is the only
 * top-level entry, descend into it. Otherwise the directory itself is the root
 * (e.g. an archive with `index.html` sitting directly at the top).
 */
export async function detectLandingRoot(inputDir: string): Promise<string> {
  const entries = (await readdir(inputDir, { withFileTypes: true })).filter(
    entry => !IGNORED_NAMES.has(entry.name)
  );
  const directories = entries.filter(entry => entry.isDirectory());
  const files = entries.filter(entry => entry.isFile());
  if (directories.length === 1 && files.length === 0) {
    return path.join(inputDir, directories[0].name);
  }
  return inputDir;
}
