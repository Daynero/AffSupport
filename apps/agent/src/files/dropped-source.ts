import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { indexedFileSearch, userContentFolders } from '../platform/platform.js';
import { diagnostics } from '../server/diagnostics-log.js';

const MAX_COMMON_FOLDER_ENTRIES = 5_000;
const MAX_COMMON_FOLDER_DEPTH = 4;

/**
 * Where a dropped original was found, as a class (031 FR-054): one of the usual content
 * folders, the OS file index, or nowhere. Never the folder, and never the name — the record
 * is copied into support threads, and "not found" against "found by the index" is the whole
 * distinction a report about a drop that imported a copy needs.
 */
type DropLocation = 'common_folder' | 'index' | 'none';

function journalDrop(code: 'resolve_file' | 'resolve_folder', location: DropLocation): void {
  diagnostics.record('drop', code, {
    location,
    outcome: location === 'none' ? 'not_found' : 'found'
  });
}

export async function findDroppedSource(
  fileName: string,
  expectedSize: number,
  expectedModifiedAt: number
): Promise<string | null> {
  if (!Number.isFinite(expectedSize)) {
    diagnostics.record('drop', 'resolve_file', { location: 'none', outcome: 'invalid' });
    return null;
  }

  const inCommonFolder = await findDroppedSourceInDirectories(
    await userContentFolders(),
    fileName,
    expectedSize,
    expectedModifiedAt
  );
  if (inCommonFolder) {
    journalDrop('resolve_file', 'common_folder');
    return inCommonFolder;
  }

  const candidates = await indexedFileSearch(os.homedir(), fileName);
  for (const candidate of candidates) {
    if (await matchesFile(candidate, expectedSize, expectedModifiedAt)) {
      journalDrop('resolve_file', 'index');
      return candidate;
    }
  }
  journalDrop('resolve_file', 'none');
  return null;
}

/**
 * Finds a browser-dropped original in the folders people normally drag from.
 *
 * Finder commonly supplies a file from one folder below Downloads (for example,
 * `Downloads/campaign/video.mp4`). The browser hides its absolute path and
 * Spotlight may not have indexed a recent download yet, so an exact top-level
 * probe alone turns the agent's temporary import into the apparent original.
 * This bounded walk covers that ordinary layout without scanning the home directory.
 */
async function findDroppedSourceInDirectories(
  directories: string[],
  fileName: string,
  expectedSize: number,
  expectedModifiedAt: number
): Promise<string | null> {
  for (const directory of directories) {
    const direct = path.join(directory, fileName);
    if (await matchesFile(direct, expectedSize, expectedModifiedAt)) return direct;

    const pending: Array<{ directory: string; depth: number }> = [{ directory, depth: 0 }];
    let visited = 0;
    while (pending.length && visited < MAX_COMMON_FOLDER_ENTRIES) {
      const current = pending.shift()!;
      let entries: Dirent[];
      try {
        entries = await readdir(current.directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (++visited > MAX_COMMON_FOLDER_ENTRIES) break;
        // Hidden trees such as .git and node_modules are neither ordinary drop
        // locations nor a useful place to spend the bounded search budget.
        if (entry.name.startsWith('.')) continue;
        const candidate = path.join(current.directory, entry.name);
        if (entry.isFile() && entry.name === fileName) {
          if (await matchesFile(candidate, expectedSize, expectedModifiedAt)) return candidate;
        } else if (entry.isDirectory() && current.depth < MAX_COMMON_FOLDER_DEPTH) {
          pending.push({ directory: candidate, depth: current.depth + 1 });
        }
      }
    }
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
 * usual drop locations by exact layout (cheap, cross-platform); then asks the OS file index to
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
    diagnostics.record('drop', 'resolve_folder', { location: 'none', outcome: 'invalid' });
    return null;
  }

  for (const folder of await userContentFolders()) {
    const root = path.join(folder, sample.folderName);
    if (await folderMatches(root, relSegments, sample)) {
      journalDrop('resolve_folder', 'common_folder');
      return root;
    }
  }

  const hits = await indexedFileSearch(os.homedir(), sample.fileName);
  for (const hit of hits) {
    let root = hit;
    for (let index = 0; index < relSegments.length; index += 1) root = path.dirname(root);
    if (path.basename(root) !== sample.folderName) continue;
    if (await folderMatches(root, relSegments, sample)) {
      journalDrop('resolve_folder', 'index');
      return root;
    }
  }
  journalDrop('resolve_folder', 'none');
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
