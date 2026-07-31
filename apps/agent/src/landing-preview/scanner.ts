import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { inspectZip } from './archive.js';

const IGNORED_DIRECTORIES = new Set(['.git', '.hg', '.svn', 'node_modules', '__MACOSX']);
const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db']);

export interface DiscoveredLanding {
  key: string;
  name: string;
  relativePath: string;
  sourceKind: 'folder' | 'zip';
  sourceRelativePath: string;
  archiveRoot: string | null;
  entryFile: string;
  fingerprint: string;
}

export interface DiscoveryResult {
  landings: DiscoveredLanding[];
  warnings: string[];
}

/** Finds folder and ZIP landing roots without descending inside a landing. */
export async function discoverLandings(
  root: string,
  signal?: AbortSignal
): Promise<DiscoveryResult> {
  const landings: DiscoveredLanding[] = [];
  const warnings: string[] = [];

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    throwIfAborted(signal);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      warnings.push(`${displayPath(relativeDirectory)}: ${errorMessage(error)}`);
      return;
    }
    entries.sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
    );
    const index = entries.find(entry => entry.isFile() && /^index\.html?$/iu.test(entry.name));
    if (index) {
      const sourceRelativePath = relativeDirectory;
      landings.push({
        key: `folder:${sourceRelativePath || '.'}`,
        name: path.basename(directory),
        relativePath: sourceRelativePath || path.basename(root),
        sourceKind: 'folder',
        sourceRelativePath,
        archiveRoot: null,
        entryFile: index.name,
        fingerprint: await fingerprintDirectory(directory, signal)
      });
      return;
    }

    for (const entry of entries) {
      throwIfAborted(signal);
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.zip') continue;
      const archivePath = path.join(directory, entry.name);
      const archiveRelativePath = toPosix(
        relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name
      );
      try {
        const [archiveStat, inspection] = await Promise.all([
          stat(archivePath),
          inspectZip(archivePath, signal)
        ]);
        if (!inspection.landingRoots.length) continue;
        const fingerprint = hashParts([
          String(archiveStat.size),
          String(Math.round(archiveStat.mtimeMs)),
          ...inspection.entries.map(
            item => `${item.path}\0${item.uncompressedSize}\0${item.compressedSize}\0${item.crc32}`
          )
        ]);
        const many = inspection.landingRoots.length > 1;
        for (const archiveRoot of inspection.landingRoots) {
          const innerName = archiveRoot ? path.posix.basename(archiveRoot) : stripZip(entry.name);
          const entryPath = inspection.entries.find(item => {
            if (item.directory || !/^index\.html?$/iu.test(path.posix.basename(item.path))) {
              return false;
            }
            const dirname = path.posix.dirname(item.path);
            return (dirname === '.' ? '' : dirname) === archiveRoot;
          })?.path;
          landings.push({
            key: `zip:${archiveRelativePath}:${archiveRoot || '.'}`,
            name: many ? innerName : stripZip(entry.name),
            relativePath:
              many && archiveRoot ? `${archiveRelativePath}/${archiveRoot}` : archiveRelativePath,
            sourceKind: 'zip',
            sourceRelativePath: archiveRelativePath,
            archiveRoot: archiveRoot || null,
            entryFile: entryPath ? path.posix.basename(entryPath) : 'index.html',
            fingerprint
          });
        }
      } catch (error) {
        warnings.push(`${archiveRelativePath}: ${errorMessage(error)}`);
      }
    }

    for (const entry of entries) {
      throwIfAborted(signal);
      if (!entry.isDirectory() || entry.isSymbolicLink() || IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const childRelative = toPosix(
        relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name
      );
      await visit(path.join(directory, entry.name), childRelative);
    }
  }

  await visit(root, '');
  landings.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, undefined, {
      numeric: true,
      sensitivity: 'base'
    })
  );
  return { landings, warnings };
}

async function fingerprintDirectory(directory: string, signal?: AbortSignal): Promise<string> {
  const parts: string[] = [];
  async function walk(current: string, relative: string): Promise<void> {
    throwIfAborted(signal);
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      throwIfAborted(signal);
      if (IGNORED_FILES.has(entry.name) || entry.isSymbolicLink()) continue;
      const child = path.join(current, entry.name);
      const childRelative = toPosix(relative ? path.join(relative, entry.name) : entry.name);
      if (entry.isDirectory()) {
        parts.push(`d\0${childRelative}`);
        await walk(child, childRelative);
      } else if (entry.isFile()) {
        const details = await stat(child);
        parts.push(`f\0${childRelative}\0${details.size}\0${Math.round(details.mtimeMs)}`);
      }
    }
  }
  await walk(directory, '');
  return hashParts(parts);
}

function hashParts(parts: string[]) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\n');
  return hash.digest('hex');
}

function stripZip(name: string) {
  return name.replace(/\.zip$/iu, '');
}

function toPosix(value: string) {
  return value.split(path.sep).join('/');
}

function displayPath(value: string) {
  return value || '.';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Could not inspect this item.';
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new Error('Operation cancelled.');
}
