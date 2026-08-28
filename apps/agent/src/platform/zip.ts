import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ZipFile as ZipWriter } from 'yazl';
import { openPromise, type Entry, type ZipFile } from 'yauzl';

const MAX_ENTRIES = 50_000;
const MAX_UNCOMPRESSED_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 500;
const MAX_PATH_DEPTH = 80;

export interface SafeZipEntry {
  path: string;
  directory: boolean;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
}

export interface ZipInspection {
  entries: SafeZipEntry[];
  /** POSIX directories that directly contain an index.html/index.htm. */
  landingRoots: string[];
  compressedBytes: number;
  uncompressedBytes: number;
}

/**
 * Writes one directory as the ZIP's single top-level entry. yazl sets the ZIP
 * UTF-8 flag rather than relying on the Windows console code page as bsdtar
 * does, so Ukrainian and other non-ASCII names round-trip predictably.
 */
export async function writeZipDirectory(directory: string, zipPath: string): Promise<void> {
  const root = path.resolve(directory);
  if (!(await stat(root)).isDirectory()) throw new Error('The ZIP source must be a directory.');

  const zip = new ZipWriter();
  const output = createWriteStream(zipPath);
  const completed = new Promise<void>((resolve, reject) => {
    zip.outputStream.once('error', reject);
    output.once('error', reject);
    output.once('close', resolve);
    zip.outputStream.pipe(output);
  });

  try {
    const rootName = path.basename(root);
    zip.addEmptyDirectory(`${rootName}/`);
    await addDirectory(zip, root, rootName);
    zip.end();
    await completed;
  } catch (error) {
    zip.outputStream.unpipe(output);
    output.destroy();
    await rm(zipPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function addDirectory(zip: ZipWriter, directory: string, archivePath: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const source = path.join(directory, entry.name);
    const target = path.posix.join(archivePath, entry.name);
    if (entry.isDirectory()) {
      zip.addEmptyDirectory(`${target}/`);
      await addDirectory(zip, source, target);
    } else if (entry.isFile()) {
      zip.addFile(source, target);
    } else {
      throw new Error(`Could not archive unsupported filesystem entry: ${entry.name}`);
    }
  }
}

/**
 * Reads only the ZIP central directory. This both discovers landing roots and
 * rejects layouts that could escape or exhaust the extraction workspace.
 */
export async function inspectZip(zipPath: string, signal?: AbortSignal): Promise<ZipInspection> {
  const zip = await openSafeZip(zipPath);
  try {
    if (zip.entryCount > MAX_ENTRIES) {
      throw new Error(`ZIP contains too many entries (${zip.entryCount.toLocaleString()}).`);
    }
    const entries: SafeZipEntry[] = [];
    let compressedBytes = 0;
    let uncompressedBytes = 0;
    for await (const entry of zip.eachEntry()) {
      throwIfAborted(signal);
      const normalized = validateEntry(entry);
      if (!normalized) continue;
      compressedBytes += entry.compressedSize;
      uncompressedBytes += entry.uncompressedSize;
      if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
        throw new Error('ZIP expands beyond the 5 GB preview safety limit.');
      }
      entries.push({
        path: normalized.path,
        directory: normalized.directory,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize,
        crc32: entry.crc32 >>> 0
      });
    }
    return {
      entries,
      landingRoots: landingRoots(entries),
      compressedBytes,
      uncompressedBytes
    };
  } finally {
    zip.close();
  }
}

/** Extracts a previously validated ZIP without ever following archive links. */
export async function extractZipSafely(
  zipPath: string,
  destination: string,
  signal?: AbortSignal
): Promise<ZipInspection> {
  const inspection = await inspectZip(zipPath, signal);
  const destinationRoot = path.resolve(destination);
  await rm(destinationRoot, { recursive: true, force: true });
  await mkdir(destinationRoot, { recursive: true });
  const zip = await openSafeZip(zipPath);
  try {
    if (zip.entryCount > MAX_ENTRIES) {
      throw new Error(`ZIP contains too many entries (${zip.entryCount.toLocaleString()}).`);
    }
    let inspectedIndex = 0;
    let uncompressedBytes = 0;
    for await (const entry of zip.eachEntry()) {
      throwIfAborted(signal);
      const normalized = validateEntry(entry);
      if (!normalized) continue;
      uncompressedBytes += entry.uncompressedSize;
      if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
        throw new Error('ZIP expands beyond the 5 GB preview safety limit.');
      }
      const expected = inspection.entries[inspectedIndex];
      inspectedIndex += 1;
      if (
        !expected ||
        expected.path !== normalized.path ||
        expected.directory !== normalized.directory ||
        expected.compressedSize !== entry.compressedSize ||
        expected.uncompressedSize !== entry.uncompressedSize ||
        expected.crc32 !== entry.crc32 >>> 0
      ) {
        throw new Error('ZIP changed while it was being prepared. Try refreshing it again.');
      }
      const target = path.join(destinationRoot, ...normalized.path.split('/'));
      if (!target.startsWith(`${destinationRoot}${path.sep}`)) {
        throw new Error('ZIP contains a path outside its extraction directory.');
      }
      if (normalized.directory) {
        await mkdir(target, { recursive: true });
        continue;
      }
      await mkdir(path.dirname(target), { recursive: true });
      const source = await zip.openReadStreamPromise(entry);
      await pipeline(source, createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal });
    }
    if (inspectedIndex !== inspection.entries.length) {
      throw new Error('ZIP changed while it was being prepared. Try refreshing it again.');
    }
    return inspection;
  } catch (error) {
    await rm(destinationRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    zip.close();
  }
}

function openSafeZip(zipPath: string): Promise<ZipFile> {
  return openPromise(zipPath, {
    autoClose: false,
    lazyEntries: true,
    decodeStrings: true,
    validateEntrySizes: true,
    strictFileNames: true
  });
}

function validateEntry(entry: Entry): { path: string; directory: boolean } | null {
  if (entry.isEncrypted()) throw new Error('Password-protected ZIP archives are not supported.');
  if (!entry.canDecodeFileData()) throw new Error('ZIP uses an unsupported compression method.');
  const raw = entry.fileName;
  if (!raw || raw.includes('\0') || raw.includes('\\')) {
    throw new Error('ZIP contains an unsafe file path.');
  }
  if (raw.startsWith('/') || /^[A-Za-z]:/u.test(raw)) {
    throw new Error('ZIP contains an absolute file path.');
  }
  const directory = raw.endsWith('/');
  const segments = raw.split('/').filter(segment => segment !== '' && segment !== '.');
  if (!segments.length) return null;
  if (segments.some(segment => segment === '..')) {
    throw new Error('ZIP contains a parent-directory path.');
  }
  if (segments.some(unsafeCrossPlatformSegment)) {
    throw new Error('ZIP contains a file name that is unsafe on desktop filesystems.');
  }
  if (segments.length > MAX_PATH_DEPTH) throw new Error('ZIP folder nesting is too deep.');
  const unixMode = entry.externalFileAttributes >>> 16;
  const unixType = unixMode & 0o170000;
  if (unixType === 0o120000) throw new Error('ZIP symbolic links are not supported.');
  if (!directory && entry.uncompressedSize > MAX_SINGLE_FILE_BYTES) {
    throw new Error('ZIP contains a file larger than the 2 GB preview safety limit.');
  }
  const ratio = entry.uncompressedSize / Math.max(1, entry.compressedSize);
  if (!directory && entry.uncompressedSize > 1024 * 1024 && ratio > MAX_COMPRESSION_RATIO) {
    throw new Error('ZIP has a suspicious compression ratio and was not unpacked.');
  }
  return { path: segments.join('/'), directory };
}

function landingRoots(entries: SafeZipEntry[]): string[] {
  const candidates = entries
    .filter(entry => !entry.directory && /^index\.html?$/iu.test(path.posix.basename(entry.path)))
    .map(entry => {
      const dirname = path.posix.dirname(entry.path);
      return dirname === '.' ? '' : dirname;
    })
    .sort((left, right) => {
      const depth = segmentCount(left) - segmentCount(right);
      return depth || left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
    });
  const roots: string[] = [];
  for (const candidate of candidates) {
    if (roots.some(root => root === '' || candidate === root || candidate.startsWith(`${root}/`))) {
      continue;
    }
    roots.push(candidate);
  }
  return roots;
}

function segmentCount(value: string) {
  return value ? value.split('/').length : 0;
}

function unsafeCrossPlatformSegment(segment: string) {
  const hasControlCharacter = [...segment].some(character => character.charCodeAt(0) <= 0x1f);
  if (hasControlCharacter || /[<>:"|?*]/u.test(segment) || /[. ]$/u.test(segment)) return true;
  const stem = segment.split('.')[0].toUpperCase();
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem);
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new Error('Operation cancelled.');
}
