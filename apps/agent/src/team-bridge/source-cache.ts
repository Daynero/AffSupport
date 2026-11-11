/**
 * A team source this computer already holds, by Drive's content identity.
 *
 * A catalog restitch with ten variations used to download the same video ten times: every
 * variation is its own operation with its own workspace, and the workspace is removed when the
 * operation ends. The download is still asked for — the first ranged read is what tells the
 * agent which bytes the grant names, and it keeps the server's authorization in the loop — but
 * once its headers name an MD5 and a length this cache already holds, the rest is read from
 * disk instead of the network.
 *
 * Nothing here is trusted on its word. A held file is placed into the workspace and its MD5 is
 * recomputed before it is handed over, so the transfer's promise — "sourceChecksum was checked
 * against every byte" — stays exactly as true as it was for a download. A miss, a failed link
 * or a failed check only costs the download it would have cost anyway.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { constants } from 'node:fs';
import { copyFile, link, mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { applicationSupportRoot } from '../files/support-dir.js';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 2 * 1024 * 1024 * 1024;

export interface TeamSourceCacheOptions {
  root?: string;
  maxBytes?: number;
  maxEntryBytes?: number;
}

function validChecksum(checksum: string): boolean {
  return /^[a-f0-9]{32}$/iu.test(checksum);
}

/** Hard link where the volume allows it, otherwise a clone (APFS) or a plain copy. */
async function placeFile(from: string, to: string): Promise<void> {
  try {
    await link(from, to);
  } catch {
    await copyFile(from, to, constants.COPYFILE_FICLONE);
  }
}

async function md5Of(file: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('md5');
  const stream = createReadStream(file, { signal });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export class TeamSourceCache {
  readonly #directory: string;
  readonly #maxBytes: number;
  readonly #maxEntryBytes: number;

  constructor(options: TeamSourceCacheOptions = {}) {
    this.#directory = path.join(options.root ?? applicationSupportRoot(), 'stitcher', 'sources');
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#maxEntryBytes = Math.min(
      options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES,
      this.#maxBytes
    );
  }

  pathFor(checksum: string, sizeBytes: number): string {
    return path.join(this.#directory, `${checksum.toLowerCase()}-${sizeBytes}.bin`);
  }

  /**
   * Puts a verified copy of the held source at `destination`; false when there is none.
   * The destination must not exist yet; it is removed again if the check fails.
   */
  async place(
    checksum: string,
    sizeBytes: number,
    destination: string,
    signal: AbortSignal
  ): Promise<boolean> {
    if (!validChecksum(checksum) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1) return false;
    const held = this.pathFor(checksum, sizeBytes);
    try {
      const stats = await stat(held);
      if (!stats.isFile() || stats.size !== sizeBytes) return false;
      await placeFile(held, destination);
      signal.throwIfAborted();
      if ((await stat(destination)).size !== sizeBytes) throw new Error('SIZE_MISMATCH');
      if ((await md5Of(destination, signal)) !== checksum.toLowerCase())
        throw new Error('CHECKSUM_MISMATCH');
      // Used, not merely kept: the least recently used source is the one evicted.
      const now = new Date();
      await utimes(held, now, now).catch(() => undefined);
      return true;
    } catch (error) {
      await rm(destination, { force: true }).catch(() => undefined);
      // A held file that failed its own identity is worthless; drop it.
      if (error instanceof Error && error.message === 'CHECKSUM_MISMATCH')
        await rm(held, { force: true }).catch(() => undefined);
      if (signal.aborted) throw signal.reason ?? new Error('PROCESS_CANCELED');
      return false;
    }
  }

  /** Keeps a just-verified download for the next operation over the same bytes. Never throws. */
  async keep(checksum: string, sizeBytes: number, file: string): Promise<void> {
    if (!validChecksum(checksum) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1) return;
    if (sizeBytes > this.#maxEntryBytes) return;
    const target = this.pathFor(checksum, sizeBytes);
    try {
      const existing = await stat(target).catch(() => null);
      if (existing?.isFile() && existing.size === sizeBytes) return;
      await mkdir(this.#directory, { recursive: true });
      const staging = path.join(
        this.#directory,
        `.keep-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
      );
      try {
        await placeFile(file, staging);
        await rename(staging, target);
      } finally {
        await rm(staging, { force: true }).catch(() => undefined);
      }
      await this.#evictDownToCap();
    } catch {
      // A source that could not be kept is downloaded again next time; nothing else changes.
    }
  }

  async #evictDownToCap(): Promise<void> {
    let entries: { path: string; size: number; usedAtMs: number }[];
    try {
      const names = (await readdir(this.#directory)).filter(name => name.endsWith('.bin'));
      entries = (
        await Promise.all(
          names.map(async name => {
            const full = path.join(this.#directory, name);
            const stats = await stat(full).catch(() => null);
            if (!stats?.isFile()) return null;
            return { path: full, size: stats.size, usedAtMs: stats.mtimeMs };
          })
        )
      ).filter(entry => entry !== null);
    } catch {
      return;
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (total <= this.#maxBytes) return;
    for (const entry of entries.sort((a, b) => a.usedAtMs - b.usedAtMs)) {
      if (total <= this.#maxBytes) return;
      await rm(entry.path, { force: true }).catch(() => undefined);
      total -= entry.size;
    }
  }
}
