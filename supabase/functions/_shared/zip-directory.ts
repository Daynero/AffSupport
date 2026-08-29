/**
 * The central directory of a ZIP, read from its tail (011, findings J2).
 *
 * A landing package sits in Drive as an archive; only the agent used to open
 * one, so a package the owner dropped into Drive stayed an "archive" until
 * somebody previewed it on a computer with Soty running. The catalog can tell
 * from the directory alone — no extraction, no full download: the last 64 KB
 * of the file hold the end-of-central-directory record, which points at the
 * entry list. The rule for "is a landing" and the validation fingerprint are
 * the agent's (`apps/agent/src/platform/zip.ts`, `preview-origin.ts`), so a
 * package inspected here and one opened there agree.
 */

export interface ZipDirectoryEntry {
  path: string;
  directory: boolean;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
}

export interface ZipDirectoryLocation {
  offset: number;
  size: number;
  entries: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_MIN = 22;
const EOCD_MAX_COMMENT = 0xffff;
/** Enough tail to hold the EOCD with the longest comment there can be. */
export const ZIP_TAIL_BYTES = EOCD_MIN + EOCD_MAX_COMMENT + 1;
/** Beyond this the entry list is not a landing but a data set; leave it. */
export const ZIP_DIRECTORY_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Where the central directory lives, from the file's tail. `null` means the
 * tail is not a ZIP's — no record, a ZIP64 record (offsets we do not read), or
 * a directory larger than a landing could need.
 */
export function locateZipDirectory(
  tail: Uint8Array,
  fileSize: number
): ZipDirectoryLocation | null {
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const tailStart = fileSize - tail.byteLength;
  for (let at = tail.byteLength - EOCD_MIN; at >= 0; at -= 1) {
    if (view.getUint32(at, true) !== EOCD_SIGNATURE) continue;
    const disk = view.getUint16(at + 4, true);
    const directoryDisk = view.getUint16(at + 6, true);
    const entries = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 12, true);
    const offset = view.getUint32(at + 16, true);
    const commentLength = view.getUint16(at + 20, true);
    if (at + EOCD_MIN + commentLength > tail.byteLength) continue;
    if (disk !== 0 || directoryDisk !== 0) return null;
    if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff) return null;
    if (size > ZIP_DIRECTORY_MAX_BYTES || offset + size > tailStart + at) return null;
    return { offset, size, entries };
  }
  return null;
}

/** The entries of a central directory, or `null` when the bytes are not one. */
export function readZipDirectory(
  directory: Uint8Array,
  expectedEntries: number
): ZipDirectoryEntry[] | null {
  const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const entries: ZipDirectoryEntry[] = [];
  let at = 0;
  while (at + 46 <= directory.byteLength && entries.length < expectedEntries) {
    if (view.getUint32(at, true) !== CENTRAL_SIGNATURE) return null;
    const crc32 = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const uncompressedSize = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const nameStart = at + 46;
    if (nameStart + nameLength > directory.byteLength) return null;
    const rawName = directory.subarray(nameStart, nameStart + nameLength);
    // Bit 11: the name is UTF-8. Anything else is read the same way; a name
    // that is not UTF-8 decodes with replacement characters and never matches
    // "index.html", which is the only name that matters here.
    const name = decoder.decode(rawName);
    const path = normalizeEntryPath(name);
    if (path !== null) {
      entries.push({
        path,
        directory: name.endsWith('/'),
        compressedSize,
        uncompressedSize,
        crc32
      });
    }
    at = nameStart + nameLength + extraLength + commentLength;
  }
  return entries.length === expectedEntries ? entries : null;
}

function normalizeEntryPath(name: string): string | null {
  const trimmed = name.replace(/\\/g, '/').replace(/\/+$/u, '');
  if (trimmed === '' || trimmed.startsWith('/') || /(^|\/)\.\.(\/|$)/u.test(trimmed)) return null;
  return trimmed;
}

/**
 * POSIX directories that directly contain an index.html, shallowest first,
 * one per subtree — the agent's rule, line for line.
 */
export function landingRootsOf(entries: readonly ZipDirectoryEntry[]): string[] {
  const candidates = entries
    .filter(entry => !entry.directory && /^index\.html?$/iu.test(basename(entry.path)))
    .map(entry => dirname(entry.path))
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

/** The agent's validation fingerprint (`createLandingValidationRecord`), byte for byte. */
export async function landingFingerprint(input: {
  sourceVersion: string | null;
  sourceChecksum: string | null;
  entries: readonly ZipDirectoryEntry[];
  landingRoot: string;
}): Promise<string> {
  const parts: string[] = [
    `${input.sourceVersion ?? '<null>'}\0`,
    `${input.sourceChecksum ?? '<null>'}\0`,
    `${input.landingRoot}\n`
  ];
  for (const entry of [...input.entries].sort((left, right) =>
    left.path.localeCompare(right.path)
  )) {
    parts.push(
      `${entry.path}\0${entry.directory ? 'd' : 'f'}\0${entry.compressedSize}\0${entry.uncompressedSize}\0${entry.crc32}\n`
    );
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('')));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export type ArchiveInspection =
  | { outcome: 'landing'; landingRoot: string; fingerprint: string; entries: number }
  | { outcome: 'archive'; entries: number }
  | { outcome: 'unavailable'; reason: 'not_zip' | 'unreadable' | 'too_large' };

/**
 * Decide what an archive in the catalog is, reading only what it takes.
 * `fetchRange` returns the bytes `[start, end]` of the file, or null when the
 * provider refuses.
 */
export async function inspectArchive(input: {
  fileSize: number;
  sourceVersion: string | null;
  sourceChecksum: string | null;
  fetchRange: (start: number, end: number) => Promise<Uint8Array | null>;
}): Promise<ArchiveInspection> {
  if (input.fileSize < EOCD_MIN) return { outcome: 'unavailable', reason: 'not_zip' };
  const tailStart = Math.max(0, input.fileSize - ZIP_TAIL_BYTES);
  const tail = await input.fetchRange(tailStart, input.fileSize - 1);
  if (!tail) return { outcome: 'unavailable', reason: 'unreadable' };
  const location = locateZipDirectory(tail, input.fileSize);
  if (!location) return { outcome: 'unavailable', reason: 'not_zip' };
  let directory: Uint8Array | null;
  if (location.offset >= tailStart) {
    const from = location.offset - tailStart;
    directory = tail.subarray(from, from + location.size);
  } else {
    directory = await input.fetchRange(location.offset, location.offset + location.size - 1);
    if (!directory) return { outcome: 'unavailable', reason: 'unreadable' };
  }
  const entries = readZipDirectory(directory, location.entries);
  if (!entries) return { outcome: 'unavailable', reason: 'not_zip' };
  const landingRoot = landingRootsOf(entries)[0];
  if (landingRoot === undefined) return { outcome: 'archive', entries: entries.length };
  const fingerprint = await landingFingerprint({
    sourceVersion: input.sourceVersion,
    sourceChecksum: input.sourceChecksum,
    entries,
    landingRoot
  });
  return { outcome: 'landing', landingRoot, fingerprint, entries: entries.length };
}

function basename(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function segmentCount(value: string): number {
  return value ? value.split('/').length : 0;
}
