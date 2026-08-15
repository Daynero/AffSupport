import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  TeamLandingPreviewCatalogRequest,
  TeamLandingPreviewSnapshotItem,
  TeamLandingPreviewSnapshotState
} from '@video-compressor/shared';
import { inspectZip } from './archive.js';

const IGNORED_DIRECTORIES = new Set(['.git', '.hg', '.svn', 'node_modules', '__MACOSX']);
const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db']);
/** A single readdir/stat this slow means a stuck or offline mount (e.g. a
 *  removed cloud-synced folder); abandon it so a scan can never wedge. */
const FS_OP_TIMEOUT_MS = 15_000;

/**
 * Runs a filesystem operation so it can ALWAYS be abandoned. Node's fs calls
 * ignore AbortSignal, so a blocking syscall on a removed/offline path would
 * otherwise pin the whole scan and make cancellation a no-op. This races the
 * operation against the abort signal (rejects the instant cancel is requested,
 * letting the orphaned syscall settle in the background) and against a timeout
 * (so a path that never returns can't hang the run forever).
 */
export async function guardedFs<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
  timeoutMs: number = FS_OP_TIMEOUT_MS
): Promise<T> {
  if (signal?.aborted) throw signal.reason ?? new Error('Operation cancelled.');
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      action();
    };
    const onAbort = () => finish(() => reject(signal?.reason ?? new Error('Operation cancelled.')));
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(new Error('Timed out reading from disk — the folder may be offline or removed.'))
        ),
      timeoutMs
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    operation().then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error))
    );
  });
}
const TEAM_SNAPSHOT_STATES = new Set<TeamLandingPreviewSnapshotState>([
  'ready',
  'candidate',
  'rendering',
  'needs_agent',
  'agent_outdated',
  'error'
]);
const TEAM_FAILURE_REASONS = new Set([
  'unsupported',
  'corrupt',
  'protected',
  'too_large',
  'render_error'
]);
const MAX_TEAM_SNAPSHOT_ITEMS = 50_000;

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

/**
 * Validates the provider-credential-free snapshot sent by the signed-in web app. Preview URLs
 * are still checked against the configured Edge render endpoint immediately before download.
 */
export function normalizeTeamLandingSnapshot(
  value: unknown
): TeamLandingPreviewCatalogRequest | null {
  if (!record(value)) return null;
  if (!uuid(value.teamId) || !compact(value.teamName, 240) || !Array.isArray(value.items)) {
    return null;
  }
  if (value.items.length > MAX_TEAM_SNAPSHOT_ITEMS) return null;
  const seen = new Set<string>();
  const items: TeamLandingPreviewSnapshotItem[] = [];
  for (const candidate of value.items) {
    if (!record(candidate)) return null;
    const materialId = candidate.materialId;
    const name = compact(candidate.name, 240);
    const state = candidate.state;
    const sourceVersion = candidate.sourceVersion;
    const fingerprint = candidate.fingerprint;
    const preset = candidate.preset;
    const previewUrls = candidate.previewUrls;
    const failureReason = candidate.failureReason;
    if (
      !uuid(materialId) ||
      seen.has(materialId) ||
      !name ||
      !TEAM_SNAPSHOT_STATES.has(state as TeamLandingPreviewSnapshotState) ||
      typeof sourceVersion !== 'string' ||
      sourceVersion.length > 512 ||
      (fingerprint !== '' &&
        (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(fingerprint))) ||
      typeof preset !== 'string' ||
      !/^[a-z0-9_-]{1,64}$/iu.test(preset) ||
      !Array.isArray(previewUrls) ||
      previewUrls.length > 64 ||
      previewUrls.some(url => typeof url !== 'string' || url.length > 4096) ||
      (failureReason !== undefined &&
        (typeof failureReason !== 'string' || !TEAM_FAILURE_REASONS.has(failureReason)))
    ) {
      return null;
    }
    if ((state === 'ready') !== previewUrls.length > 0) return null;
    seen.add(materialId);
    items.push({
      materialId,
      name,
      state: state as TeamLandingPreviewSnapshotState,
      sourceVersion,
      fingerprint,
      preset,
      previewUrls: [...previewUrls],
      ...(typeof failureReason === 'string' ? { failureReason } : {})
    });
  }
  return { teamId: value.teamId, teamName: compact(value.teamName, 240)!, items };
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
      entries = await guardedFs(() => readdir(directory, { withFileTypes: true }), signal);
    } catch (error) {
      if (signal?.aborted) throw error;
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
          guardedFs(() => stat(archivePath), signal),
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
    let entries;
    try {
      entries = await guardedFs(() => readdir(current, { withFileTypes: true }), signal);
    } catch (error) {
      // A folder removed mid-scan (or an offline mount) contributes nothing to
      // the fingerprint rather than failing the whole run.
      if (signal?.aborted) throw error;
      return;
    }
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
        let details;
        try {
          details = await guardedFs(() => stat(child), signal);
        } catch (error) {
          if (signal?.aborted) throw error;
          continue; // a file removed mid-scan is simply skipped
        }
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

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(value);
}

function compact(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  return normalized && normalized.length <= maxLength ? normalized : null;
}
