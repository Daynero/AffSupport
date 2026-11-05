/**
 * The pictures a space draws for its re-stitched videos, kept on this computer (030).
 *
 * They are not this member's pictures: they are the space's, chosen by its owner in Google
 * Drive and drawn one per slot by the server for each job. So they do not go into the
 * compressor's library — the stitcher page would show a stranger's photographs and the local
 * random draws would start picking them — but into a cache of their own, keyed by the
 * material and the md5 of its bytes. The same bytes are never fetched twice; a picture
 * replaced in Drive gets a new key and the old file ages out.
 *
 * Fetching goes through the same download grant a video travels on. When the grant fails and
 * the cache has the picture, the cache wins and the failure is logged: a flaky connection
 * should not stop a job the computer can already do.
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import type { RestitchScreen, TeamTransferGrant } from '@video-compressor/shared';
import {
  RESTITCH_SCREEN_MAX_BYTES,
  RESTITCH_SCREEN_REFUSAL_TTL_MS,
  RESTITCH_SCREEN_REFUSAL_LIMIT
} from '@video-compressor/shared';
import { decodeRestitchScreen } from './screen-decode.js';
import type { probeImage } from '../ffmpeg/tools.js';
import { applicationSupportRoot } from '../files/support-dir.js';
import { diagnostics } from '../server/diagnostics-log.js';
import type { DownloadedTeamSource, TeamSourceDownloadRequest } from './transfer.js';

export const TEAM_SCREENS_DIR = 'TeamScreens';
/** Copies nobody has asked for in this long are not coming back. */
export const SCREEN_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Per space: a pool is at most five hundred pictures, and a cache is not a pool. */
export const SCREEN_CACHE_MAX_PER_TEAM = 500;

export class ScreenCacheError extends Error {
  constructor(
    public readonly code: string,
    public readonly reason:
      | 'transfer_failed'
      | 'checksum_mismatch'
      | 'cache_write_failed'
      | 'source_missing'
      | 'source_changed' = 'transfer_failed'
  ) {
    super(code);
  }
}

function cacheWriteError(cause: unknown): ScreenCacheError {
  const diskFull = cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOSPC';
  return new ScreenCacheError(
    diskFull ? 'DISK_FULL' : 'RESTITCH_SCREEN_FETCH_FAILED',
    'cache_write_failed'
  );
}

/** Preserve closed provider/local causes; only proven file-local failures may enter refusal memory. */
function screenTransferError(cause: unknown): ScreenCacheError {
  if (cause instanceof ScreenCacheError) return cause;
  if (
    cause &&
    typeof cause === 'object' &&
    'code' in cause &&
    ['ENOSPC', 'EACCES', 'EROFS', 'EIO', 'EMFILE', 'ENFILE'].includes(String(cause.code))
  )
    return cacheWriteError(cause);
  if (cause instanceof Error) {
    if (cause.message === 'TOO_LARGE' || cause.message === 'UNSUPPORTED_MEDIA')
      return new ScreenCacheError('RESTITCH_SCREEN_UNSUPPORTED');
    if (cause.message === 'NOT_FOUND')
      return new ScreenCacheError('RESTITCH_SCREEN_UNAVAILABLE', 'source_missing');
    if (cause.message === 'SOURCE_CHANGED')
      return new ScreenCacheError('SOURCE_CHANGED', 'source_changed');
    if (
      ['EXPIRED', 'PERMISSION_DENIED', 'DRIVE_UNAVAILABLE', 'RATE_LIMITED'].includes(cause.message)
    )
      return new ScreenCacheError(cause.message);
  }
  return new ScreenCacheError('RESTITCH_SCREEN_FETCH_FAILED');
}

interface IndexEntry {
  teamId: string;
  lastUsedAt: number;
  sizeBytes: number;
}

interface ScreenRefusal {
  teamId: string;
  scope: string;
  slot: RestitchScreen['slot'];
  materialId: string;
  checksum: string;
  rejectedAt: number;
}
export const SCREEN_REFUSAL_TTL_MS = RESTITCH_SCREEN_REFUSAL_TTL_MS;
export const SCREEN_REFUSAL_LIMIT = RESTITCH_SCREEN_REFUSAL_LIMIT;
interface ScreenIndex {
  refusals?: ScreenRefusal[];
  entries: Record<string, IndexEntry>;
}

export interface ResolvedScreen {
  slot: RestitchScreen['slot'];
  /** The id handed to the stitcher, resolved back to a path by `pathFor`. */
  id: string;
  path: string;
}

export interface ScreenCacheDeps {
  transfer: {
    downloadSource: (
      request: TeamSourceDownloadRequest,
      signal: AbortSignal
    ) => Promise<DownloadedTeamSource>;
  };
  probe?: typeof probeImage;
  decode?: typeof decodeRestitchScreen;
  now?: () => number;
  log?: (message: string) => void;
}

const EXTENSION: Record<RestitchScreen['mimeType'], string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp'
};
const CODEC: Record<RestitchScreen['mimeType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'mjpeg',
  'image/webp': 'webp'
};
const KEY = /^[0-9a-f-]{36}-[0-9a-f]{32}$/i;

export function screenCacheKey(screen: Pick<RestitchScreen, 'materialId' | 'checksum'>): string {
  return `${screen.materialId}-${screen.checksum.toLowerCase()}`;
}

/** The stitcher's id for a cached screen; distinct from any library asset's UUID on purpose. */
export function screenAssetId(screen: Pick<RestitchScreen, 'materialId' | 'checksum'>): string {
  return `team:${screenCacheKey(screen)}`;
}

export class TeamScreenCache {
  readonly #root: string;
  readonly #deps: ScreenCacheDeps;
  #index: ScreenIndex | null = null;
  #paths = new Map<string, string>();
  #saveTail: Promise<void> = Promise.resolve();
  #loading: Promise<ScreenIndex> | null = null;

  constructor(deps: ScreenCacheDeps, root = path.join(applicationSupportRoot(), TEAM_SCREENS_DIR)) {
    this.#root = root;
    this.#deps = deps;
  }

  get root() {
    return this.#root;
  }

  /** The path for an id the stitcher was handed, or null when it is not one of ours. */
  pathFor(id: string): string | null {
    if (!id.startsWith('team:')) return null;
    return this.#paths.get(id.slice(5)) ?? null;
  }

  /**
   * Every screen of a job, on disk. Cache first; a fetch only for what is missing; the cache
   * again when the fetch fails but the bytes are already here.
   */
  async resolve(
    teamId: string,
    screens: readonly RestitchScreen[],
    signal: AbortSignal,
    scope = '',
    operationId?: string
  ): Promise<ResolvedScreen[]> {
    signal.throwIfAborted();
    await mkdir(this.#root, { recursive: true }).catch(cause => {
      throw cacheWriteError(cause);
    });
    const index = await this.#load();
    const resolved: ResolvedScreen[] = [];
    for (const screen of screens) {
      signal.throwIfAborted();
      const key = screenCacheKey(screen);
      if (!KEY.test(key) || screen.sizeBytes > RESTITCH_SCREEN_MAX_BYTES) {
        throw new ScreenCacheError('RESTITCH_SCREEN_UNSUPPORTED');
      }
      const file = path.join(this.#root, `${key}${EXTENSION[screen.mimeType]}`);
      let have = await this.#usable(file, screen, signal);
      signal.throwIfAborted();
      if (!have) {
        if (!screen.transfer) throw new ScreenCacheError('RESTITCH_SCREEN_UNAVAILABLE');
        try {
          await this.#fetch(file, screen, screen.transfer, signal);
          have = true;
        } catch (cause) {
          signal.throwIfAborted();
          const error = screenTransferError(cause);
          if (
            error.code === 'RESTITCH_SCREEN_UNSUPPORTED' ||
            error.reason === 'checksum_mismatch' ||
            error.reason === 'source_missing' ||
            error.reason === 'source_changed'
          ) {
            const now = this.#now();
            index.refusals = [
              ...(index.refusals ?? []).filter(
                item =>
                  now - item.rejectedAt < SCREEN_REFUSAL_TTL_MS &&
                  !(
                    item.teamId === teamId &&
                    item.scope === scope &&
                    item.slot === screen.slot &&
                    item.materialId === screen.materialId &&
                    item.checksum.toLowerCase() === screen.checksum.toLowerCase()
                  )
              ),
              {
                teamId,
                scope,
                slot: screen.slot,
                materialId: screen.materialId,
                checksum: screen.checksum.toLowerCase(),
                rejectedAt: now
              }
            ].slice(-SCREEN_REFUSAL_LIMIT);
            await this.#save(index);
            diagnostics.record('team', 'screen_candidate_rejected', {
              ...(operationId ? { operationId } : {}),
              materialId: screen.materialId,
              reason:
                error.code === 'RESTITCH_SCREEN_UNSUPPORTED' ? 'unsupported_image' : error.reason
            });
          }
          if (error.code === 'RESTITCH_SCREEN_UNSUPPORTED') {
            throw error;
          }
          diagnostics.record('team', 'screen_fetch_failed', {
            reason: error.reason
          });
          throw error;
        }
      }
      signal.throwIfAborted();
      const size = (await stat(file)).size;
      index.refusals = (index.refusals ?? []).filter(
        item =>
          !(
            item.teamId === teamId &&
            item.scope === scope &&
            item.slot === screen.slot &&
            item.materialId === screen.materialId &&
            item.checksum.toLowerCase() === screen.checksum.toLowerCase()
          )
      );
      index.entries[key] = { teamId, lastUsedAt: this.#now(), sizeBytes: size };
      this.#paths.set(key, file);
      resolved.push({ slot: screen.slot, id: screenAssetId(screen), path: file });
    }
    await this.#save(index);
    return resolved;
  }

  async refusalHistory(teamId: string) {
    const index = await this.#load();
    return (index.refusals ?? [])
      .filter(
        item => item.teamId === teamId && this.#now() - item.rejectedAt < SCREEN_REFUSAL_TTL_MS
      )
      .map(({ scope, slot, materialId, checksum }) => ({
        settingsRevision: scope,
        slot,
        materialId,
        checksum
      }));
  }

  async refused(
    teamId: string,
    scope = ''
  ): Promise<Array<Pick<ScreenRefusal, 'slot' | 'materialId' | 'checksum'>>> {
    const index = await this.#load();
    return (index.refusals ?? [])
      .filter(
        item =>
          item.teamId === teamId &&
          item.scope === scope &&
          this.#now() - item.rejectedAt < SCREEN_REFUSAL_TTL_MS
      )
      .map(({ slot, materialId, checksum }) => ({ slot, materialId, checksum }));
  }

  /**
   * Drop what the space no longer draws from: anything of this space not in `keep` and
   * older than the age, then the oldest beyond the per-space ceiling. Never touches the
   * compressor's library, which lives in another directory altogether.
   */
  async evict(teamId: string, keep: readonly string[]): Promise<number> {
    const index = await this.#load();
    const kept = new Set(keep.map(id => (id.startsWith('team:') ? id.slice(5) : id)));
    const now = this.#now();
    const mine = Object.entries(index.entries).filter(([, entry]) => entry.teamId === teamId);
    const gone: string[] = [];
    for (const [key, entry] of mine) {
      if (!kept.has(key) && now - entry.lastUsedAt > SCREEN_CACHE_MAX_AGE_MS) gone.push(key);
    }
    const remaining = mine
      .filter(([key]) => !gone.includes(key))
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (let index = 0; remaining.length - index > SCREEN_CACHE_MAX_PER_TEAM; index += 1) {
      const [key] = remaining[index]!;
      if (!kept.has(key)) gone.push(key);
    }
    for (const key of gone) {
      await this.#remove(key, index);
    }
    if (gone.length) {
      await this.#save(index);
      this.#deps.log?.(`[screen-cache] evicted ${gone.length}`);
    }
    return gone.length;
  }

  async #usable(file: string, screen: RestitchScreen, signal: AbortSignal): Promise<boolean> {
    try {
      await access(file, constants.R_OK);
    } catch {
      return false;
    }
    const size = (await stat(file)).size;
    if (size < 1 || size > RESTITCH_SCREEN_MAX_BYTES) return false;
    const digest = createHash('md5')
      .update(await readFile(file))
      .digest('hex');
    if (digest !== screen.checksum.toLowerCase()) return false;
    return this.#valid(file, screen, signal);
  }

  async #valid(file: string, screen: RestitchScreen, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    // An injected metadata probe may add a check; production always does a strict full decode.
    if (this.#deps.probe) {
      const image = await this.#deps.probe(file, undefined, { countFrames: true });
      if (!image || image.codec !== CODEC[screen.mimeType] || image.frames !== 1) return false;
    }
    try {
      return await (this.#deps.decode ?? decodeRestitchScreen)(file, screen.mimeType, signal);
    } catch (cause) {
      signal.throwIfAborted();
      if (
        cause instanceof Error &&
        ['MEDIA_TOOL_UNAVAILABLE', 'RESTITCH_SCREEN_SELECTION_LIMIT'].includes(cause.message)
      )
        throw new ScreenCacheError(cause.message);
      throw cause;
    }
  }

  async #fetch(
    file: string,
    screen: RestitchScreen,
    transfer: NonNullable<RestitchScreen['transfer']>,
    signal: AbortSignal
  ) {
    // The grant travelled as plain strings; the transfer client wants the one purpose a
    // picture may be fetched under, and refuses anything else before a byte moves.
    const purpose = transfer.grant.purpose;
    if (purpose !== 'download_range' && purpose !== 'process_input') {
      throw new ScreenCacheError('RESTITCH_SCREEN_UNAVAILABLE');
    }
    const grant: TeamTransferGrant = { ...transfer.grant, purpose };
    const downloaded = await this.#deps.transfer.downloadSource(
      {
        operationId: `screen:${screen.materialId}`,
        transferUrl: transfer.transferUrl,
        grant,
        maxTotalBytes: RESTITCH_SCREEN_MAX_BYTES,
        maxRetries: 2
      },
      signal
    );
    try {
      const actualSize = (await stat(downloaded.file)).size;
      if (
        actualSize < 1 ||
        actualSize > RESTITCH_SCREEN_MAX_BYTES ||
        downloaded.sizeBytes < 1 ||
        downloaded.sizeBytes > RESTITCH_SCREEN_MAX_BYTES
      ) {
        throw new ScreenCacheError('RESTITCH_SCREEN_UNSUPPORTED');
      }
      const bytes = await readFile(downloaded.file);
      const digest = createHash('md5').update(bytes).digest('hex');
      const expected = screen.checksum.toLowerCase();
      // The catalog's md5 is what the key is made of; bytes that disagree with it would be
      // cached under a name that lies about them, which is worse than no cache at all.
      if (digest !== expected) {
        throw new ScreenCacheError('RESTITCH_SCREEN_FETCH_FAILED', 'checksum_mismatch');
      }
      if (!(await this.#valid(downloaded.file, screen, signal)))
        throw new ScreenCacheError('RESTITCH_SCREEN_UNSUPPORTED');
      const staged = `${file}.part-${process.pid}-${Date.now()}`;
      try {
        await writeFile(staged, bytes, { flag: 'wx' });
        await rename(staged, file);
      } catch (error) {
        await unlink(staged).catch(() => {});
        throw error instanceof ScreenCacheError ? error : cacheWriteError(error);
      }
    } finally {
      await downloaded.cleanup().catch(() => {});
    }
  }

  async #remove(key: string, index: ScreenIndex) {
    delete index.entries[key];
    this.#paths.delete(key);
    let names: string[];
    try {
      names = await readdir(this.#root);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(`${key}.`)) await unlink(path.join(this.#root, name)).catch(() => {});
    }
  }

  #now() {
    return this.#deps.now?.() ?? Date.now();
  }

  async #load(): Promise<ScreenIndex> {
    if (this.#loading) return this.#loading;
    if (this.#index) return this.#index;
    this.#loading = this.#readIndex();
    try {
      return await this.#loading;
    } finally {
      this.#loading = null;
    }
  }

  async #readIndex(): Promise<ScreenIndex> {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(path.join(this.#root, 'index.json'), 'utf8')
      );
      const entries =
        typeof parsed === 'object' && parsed !== null && 'entries' in parsed
          ? (parsed as { entries: unknown }).entries
          : null;
      this.#index = { entries: {}, refusals: [] };
      const refusals =
        typeof parsed === 'object' && parsed !== null && 'refusals' in parsed
          ? parsed.refusals
          : null;
      if (Array.isArray(refusals))
        for (const item of refusals.slice(-SCREEN_REFUSAL_LIMIT)) {
          if (
            typeof item !== 'object' ||
            item === null ||
            typeof item.teamId !== 'string' ||
            typeof item.scope !== 'string' ||
            item.scope.length > 128 ||
            (item.slot !== 'start' && item.slot !== 'end') ||
            typeof item.materialId !== 'string' ||
            typeof item.checksum !== 'string' ||
            !KEY.test(`${item.materialId}-${item.checksum}`) ||
            typeof item.rejectedAt !== 'number' ||
            !Number.isFinite(item.rejectedAt) ||
            item.rejectedAt > this.#now() ||
            this.#now() - item.rejectedAt >= SCREEN_REFUSAL_TTL_MS
          )
            continue;
          this.#index.refusals!.push({
            teamId: item.teamId,
            scope: item.scope,
            slot: item.slot,
            materialId: item.materialId,
            checksum: item.checksum,
            rejectedAt: item.rejectedAt
          });
        }
      if (typeof entries === 'object' && entries !== null) {
        for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
          if (
            KEY.test(key) &&
            typeof value === 'object' &&
            value !== null &&
            typeof (value as IndexEntry).teamId === 'string' &&
            typeof (value as IndexEntry).lastUsedAt === 'number'
          ) {
            this.#index.entries[key] = {
              teamId: (value as IndexEntry).teamId,
              lastUsedAt: (value as IndexEntry).lastUsedAt,
              sizeBytes: Number((value as IndexEntry).sizeBytes) || 0
            };
          }
        }
      }
    } catch {
      this.#index = { entries: {} };
    }
    // Paths are rebuilt from the index, not trusted from it.
    for (const key of Object.keys(this.#index.entries)) {
      for (const extension of Object.values(EXTENSION)) {
        const candidate = path.join(this.#root, `${key}${extension}`);
        try {
          await access(candidate, constants.R_OK);
          this.#paths.set(key, candidate);
          break;
        } catch {
          /* next extension */
        }
      }
    }
    return this.#index;
  }

  #save(index: ScreenIndex): Promise<void> {
    const serialized = JSON.stringify(index);
    const write = async () => {
      await mkdir(this.#root, { recursive: true }).catch(cause => {
        throw cacheWriteError(cause);
      });
      const target = path.join(this.#root, 'index.json');
      const staged = `${target}.part-${process.pid}`;
      try {
        await writeFile(staged, serialized);
        await rename(staged, target);
      } catch (cause) {
        await unlink(staged).catch(() => {});
        throw cacheWriteError(cause);
      }
    };
    const saved = this.#saveTail.then(write, write);
    this.#saveTail = saved.catch(() => undefined);
    return saved;
  }
}
