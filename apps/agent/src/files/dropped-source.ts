import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { capabilities } from '../platform/platform.js';

const COMMON_SOURCE_FOLDERS = ['Downloads', 'Desktop', 'Movies', 'Documents'];

export async function findDroppedSource(
  fileName: string,
  expectedSize: number,
  expectedModifiedAt: number
): Promise<string | null> {
  if (!capabilities().spotlightSearch || !Number.isFinite(expectedSize)) return null;

  const home = os.homedir();
  const common = COMMON_SOURCE_FOLDERS.map(folder => path.join(home, folder, fileName));
  for (const candidate of common) {
    if (await matchesFile(candidate, expectedSize, expectedModifiedAt)) return candidate;
  }

  const escapedName = fileName.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const candidates = await spotlight(
    home,
    `kMDItemFSName == "${escapedName}"c && kMDItemFSSize == ${Math.round(expectedSize)}`
  );
  for (const candidate of candidates) {
    if (await matchesFile(candidate, expectedSize, expectedModifiedAt)) return candidate;
  }
  return null;
}

/**
 * A dropped folder as seen through the browser: its name plus one sample file inside it (path
 * relative to the folder, using POSIX separators, and the file's size/mtime). Browsers never expose
 * a dropped folder's absolute path, so this is all the client can hand over.
 */
export interface DroppedFolderSample {
  folderName: string;
  relPath: string;
  fileName: string;
  size: number;
  lastModified: number;
}

/**
 * Recover a dropped folder's real on-disk path from its {@link DroppedFolderSample}, so the landing
 * viewer's drag-and-drop can open the same watched folder the native picker would. First probes the
 * usual drop locations by exact layout (cheap, cross-platform); then, on macOS, uses Spotlight to
 * find the sample file anywhere under home and derives the folder from its path. Returns `null` when
 * the folder can't be located, in which case the caller falls back to the picker.
 */
export async function findDroppedFolder(sample: DroppedFolderSample): Promise<string | null> {
  const relSegments = sample.relPath.split('/').filter(Boolean);
  if (
    !sample.folderName ||
    sample.folderName.includes('/') ||
    sample.folderName === '..' ||
    sample.folderName === '.' ||
    !relSegments.length ||
    relSegments.some(segment => segment === '..' || segment === '.') ||
    !Number.isFinite(sample.size)
  ) {
    return null;
  }

  const home = os.homedir();
  for (const folder of COMMON_SOURCE_FOLDERS) {
    const root = path.join(home, folder, sample.folderName);
    if (await folderMatches(root, relSegments, sample)) return root;
  }

  if (!capabilities().spotlightSearch) return null;
  const escapedName = sample.fileName.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const hits = await spotlight(
    home,
    `kMDItemFSName == "${escapedName}"c && kMDItemFSSize == ${Math.round(sample.size)}`
  );
  for (const hit of hits) {
    let root = hit;
    for (let index = 0; index < relSegments.length; index += 1) root = path.dirname(root);
    if (path.basename(root) !== sample.folderName) continue;
    if (await folderMatches(root, relSegments, sample)) return root;
  }
  return null;
}

/** True when `root` is a directory whose sample file matches the dropped file's size and mtime. */
async function folderMatches(
  root: string,
  relSegments: string[],
  sample: DroppedFolderSample
): Promise<boolean> {
  try {
    if (!(await stat(root)).isDirectory()) return false;
  } catch {
    return false;
  }
  return matchesFile(path.join(root, ...relSegments), sample.size, sample.lastModified);
}

async function matchesFile(
  candidate: string,
  expectedSize: number,
  expectedModifiedAt: number
): Promise<boolean> {
  try {
    const details = await stat(candidate);
    return (
      details.isFile() &&
      details.size === expectedSize &&
      (!Number.isFinite(expectedModifiedAt) ||
        Math.abs(details.mtimeMs - expectedModifiedAt) < 2000)
    );
  } catch {
    return false;
  }
}

function spotlight(root: string, query: string): Promise<string[]> {
  return new Promise(resolve => {
    const child = spawn('/usr/bin/mdfind', ['-onlyin', root, query], {
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 3000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (output.length < 64 * 1024) output += chunk;
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve([]);
    });
    child.once('close', () => {
      clearTimeout(timer);
      resolve(output.split('\n').filter(Boolean));
    });
  });
}
