import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { constants } from 'node:fs';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import {
  parseSourceProfile,
  stitchUnsupportedReason,
  type SourceProfile
} from '@video-compressor/shared';
import { applicationSupportRoot } from '../files/support-dir.js';
import { processIsAlive } from '../runtime/launcher-watchdog.js';

type Stage = 'cache_check' | 'cache_invalid' | 'converting' | 'verifying' | 'ready';
export interface VerifiedSourceCacheRequest {
  sourceFile: string;
  workspace: string;
  sourceIdentity?: string | null;
  policy: string;
  signal: AbortSignal;
  onProgress?: (fraction: number) => void;
  onStage?: (stage: Stage, sharedId: string) => void;
  produce: (
    workDir: string,
    sourceFile: string,
    signal: AbortSignal,
    progress: (fraction: number) => void,
    verifying: () => void
  ) => Promise<{ file: string; profile: SourceProfile }>;
}
interface Revision {
  algorithm: 'md5' | 'sha256';
  digest: string;
  size: number;
}
interface Cached {
  file: string;
  profile: SourceProfile;
  fromCache: boolean;
  digest: string;
}
interface Consumer {
  progress?: VerifiedSourceCacheRequest['onProgress'];
  stage?: VerifiedSourceCacheRequest['onStage'];
}
interface Shared {
  id: string;
  controller: AbortController;
  consumers: Map<symbol, Consumer>;
  work: Promise<Cached>;
  owned: Promise<void>;
  done: boolean;
  stage: Stage;
  progress: number;
}
const jobs = new Map<string, Shared>();
const pins = new Map<string, number>();
const evicting = new Map<string, Promise<void>>();
const activeWork = new Set<string>();
const BOOT = randomUUID();
const MAX_MANIFEST_BYTES = 64 * 1024;

export class VerifiedSourceCache {
  private readonly directory: string;
  private readonly maxBytes: number;
  private cleaned = false;
  constructor(options: { root?: string; maxBytes?: number } = {}) {
    this.directory = path.join(
      options.root ?? applicationSupportRoot(),
      'stitcher',
      'compatible-sources'
    );
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024 * 1024;
  }
  async prepare(options: VerifiedSourceCacheRequest): Promise<Cached & { sharedId: string }> {
    options.signal.throwIfAborted();
    const revision = await sourceRevision(
      options.sourceFile,
      options.sourceIdentity,
      options.signal
    );
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prepareRevision(options, revision);
      } catch (error) {
        if (
          attempt > 0 ||
          options.signal.aborted ||
          !(error instanceof Error) ||
          error.message !== 'SOURCE_CHANGED'
        )
          throw error;
        // A changed producer input does not condemn another consumer's independently
        // verified copy. Affected consumers fail their own revision check here.
        await assertRevision(options.sourceFile, revision, options.signal);
      }
    }
  }
  private async prepareRevision(
    options: VerifiedSourceCacheRequest,
    revision: Revision
  ): Promise<Cached & { sharedId: string }> {
    options.signal.throwIfAborted();
    const key = createHash('sha256')
      .update(JSON.stringify([options.policy, revision]))
      .digest('hex');
    const target = path.join(this.directory, key);
    while (evicting.has(target)) await evicting.get(target);
    pins.set(target, (pins.get(target) ?? 0) + 1);
    let shared: Shared | undefined;
    const token = Symbol();
    const leave = () => {
      shared?.consumers.delete(token);
      if (shared && !shared.done && !shared.consumers.size) shared.controller.abort();
    };
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (!this.cleaned) {
        this.cleaned = true;
        await this.cleanAbandonedWork();
      }
      shared = jobs.get(target);
      if (shared?.controller.signal.aborted) {
        await shared.work.catch(() => {});
        shared = undefined;
      }
      if (!shared) {
        let owned!: () => void;
        const entry: Shared = {
          id: randomUUID(),
          controller: new AbortController(),
          consumers: new Map(),
          work: Promise.resolve(null as unknown as Cached),
          owned: new Promise(resolve => {
            owned = resolve;
          }),
          done: false,
          stage: 'cache_check',
          progress: 0
        };
        shared = entry;
        jobs.set(target, entry);
        entry.work = Promise.resolve()
          .then(() => this.produce(target, key, revision, options, entry, owned))
          .finally(() => {
            entry.done = true;
            owned();
            if (jobs.get(target) === entry) jobs.delete(target);
          });
        // Every consumer may cancel before attaching its waiter.
        void entry.work.catch(() => {});
      }
      shared.consumers.set(token, { progress: options.onProgress, stage: options.onStage });
      observe(() => options.onStage?.('cache_check', shared!.id));
      if (shared.stage !== 'cache_check')
        observe(() => options.onStage?.(shared!.stage, shared!.id));
      observe(() => options.onProgress?.(shared!.progress));
      options.signal.addEventListener('abort', leave, { once: true });
      if (options.signal.aborted) leave();
      let cached: Cached;
      try {
        cached = await wait(shared.work, options.signal);
      } catch (error) {
        if (options.signal.aborted) {
          await shared.owned;
          if (!shared.consumers.size) await shared.work.catch(() => {});
          throw new Error('PROCESS_CANCELED', { cause: error });
        }
        throw error;
      }
      options.signal.throwIfAborted();
      await assertRevision(options.sourceFile, revision, options.signal);
      const consumerFile = path.join(options.workspace, 'hevc-compatible.mp4');
      if (path.resolve(consumerFile) === path.resolve(options.sourceFile))
        throw new Error('STITCH_PATH_INVALID');
      await rm(consumerFile, { force: true });
      await link(cached.file, consumerFile).catch(() =>
        copyFile(cached.file, consumerFile, constants.COPYFILE_EXCL)
      );
      options.signal.throwIfAborted();
      observe(() => options.onStage?.('ready', shared!.id));
      return {
        ...cached,
        file: consumerFile,
        profile: { ...cached.profile, path: consumerFile },
        sharedId: shared.id
      };
    } finally {
      options.signal.removeEventListener('abort', leave);
      leave();
      if (shared && !shared.done && !shared.consumers.size) await shared.work.catch(() => {});
      const remaining = (pins.get(target) ?? 1) - 1;
      if (remaining) pins.set(target, remaining);
      else pins.delete(target);
      await this.evict();
    }
  }
  private async produce(
    target: string,
    key: string,
    revision: Revision,
    options: VerifiedSourceCacheRequest,
    entry: Shared,
    owned: () => void
  ): Promise<Cached> {
    const stage = (s: Stage) => {
      entry.stage = s;
      for (const c of entry.consumers.values()) observe(() => c.stage?.(s, entry.id));
    };
    const progress = (fraction: number) => {
      if (Number.isFinite(fraction)) {
        entry.progress = Math.max(entry.progress, Math.min(1, fraction));
        for (const c of entry.consumers.values()) observe(() => c.progress?.(entry.progress));
      }
    };
    const existing = await this.load(target, key, options.policy, entry.controller.signal);
    if (existing) {
      owned();
      progress(1);
      return { ...existing, fromCache: true };
    }
    if (
      await lstat(target).then(
        () => true,
        () => false
      )
    ) {
      stage('cache_invalid');
      await rm(target, { recursive: true, force: true });
    }
    entry.controller.signal.throwIfAborted();
    const workDir = await mkdtemp(path.join(this.directory, '.work-'));
    activeWork.add(workDir);
    try {
      await writeFile(
        path.join(workDir, 'owner.json'),
        JSON.stringify({ pid: process.pid, boot: BOOT }),
        { mode: 0o600 }
      );
      const input = path.join(workDir, 'input.media');
      await link(options.sourceFile, input)
        .catch(() => copyFile(options.sourceFile, input, constants.COPYFILE_EXCL))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') throw new Error('SOURCE_CHANGED');
          throw error;
        });
      await assertRevision(input, revision, entry.controller.signal);
      owned();
      entry.controller.signal.throwIfAborted();
      stage('converting');
      let produced: { file: string; profile: SourceProfile };
      try {
        produced = await options.produce(workDir, input, entry.controller.signal, progress, () =>
          stage('verifying')
        );
      } catch (error) {
        await assertRevision(input, revision, entry.controller.signal);
        throw error;
      }
      await assertRevision(input, revision, entry.controller.signal);
      entry.controller.signal.throwIfAborted();
      if (path.dirname(path.resolve(produced.file)) !== path.resolve(workDir))
        throw new Error('STITCH_VERIFICATION_FAILED');
      const facts = await lstat(produced.file);
      if (
        !facts.isFile() ||
        facts.isSymbolicLink() ||
        facts.size < 1 ||
        stitchUnsupportedReason(produced.profile)
      )
        throw new Error('STITCH_VERIFICATION_FAILED');
      const digest = await hash(produced.file, 'sha256', entry.controller.signal);
      const publish = path.join(workDir, 'publish');
      await mkdir(publish);
      await rename(produced.file, path.join(publish, 'video.mp4'));
      await writeFile(
        path.join(publish, 'manifest.json'),
        JSON.stringify({
          version: 1,
          key,
          policy: options.policy,
          size: facts.size,
          digest,
          profile: { ...produced.profile, path: 'normalized', sizeBytes: facts.size }
        }),
        { mode: 0o600 }
      );
      entry.controller.signal.throwIfAborted();
      try {
        await rename(publish, target);
      } catch (error) {
        const concurrent = await this.load(target, key, options.policy, entry.controller.signal);
        if (concurrent) return { ...concurrent, fromCache: true };
        throw error;
      }
      progress(1);
      return {
        file: path.join(target, 'video.mp4'),
        profile: {
          ...produced.profile,
          path: path.join(target, 'video.mp4'),
          sizeBytes: facts.size
        },
        fromCache: false,
        digest
      };
    } finally {
      owned();
      activeWork.delete(workDir);
      await rm(workDir, { recursive: true, force: true });
    }
  }
  private async load(
    target: string,
    key: string,
    policy: string,
    signal: AbortSignal
  ): Promise<Omit<Cached, 'fromCache'> | null> {
    try {
      const directory = await lstat(target);
      if (!directory.isDirectory() || directory.isSymbolicLink()) return null;
      const manifestFile = path.join(target, 'manifest.json'),
        file = path.join(target, 'video.mp4');
      const [manifestStat, mediaStat] = await Promise.all([lstat(manifestFile), lstat(file)]);
      if (
        !manifestStat.isFile() ||
        manifestStat.isSymbolicLink() ||
        manifestStat.size > MAX_MANIFEST_BYTES ||
        !mediaStat.isFile() ||
        mediaStat.isSymbolicLink()
      )
        return null;
      const m: unknown = JSON.parse(await readFile(manifestFile, 'utf8'));
      if (
        !record(m) ||
        m.version !== 1 ||
        m.key !== key ||
        m.policy !== policy ||
        m.size !== mediaStat.size ||
        typeof m.digest !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(m.digest)
      )
        return null;
      const p = parseSourceProfile(m.profile);
      if (
        !p.ok ||
        p.value.sizeBytes !== mediaStat.size ||
        stitchUnsupportedReason(p.value) ||
        (await hash(file, 'sha256', signal)) !== m.digest
      )
        return null;
      await utimes(target, new Date(), new Date()).catch(() => {});
      return { file, profile: { ...p.value, path: file }, digest: m.digest };
    } catch (error) {
      if (signal.aborted) throw new Error('PROCESS_CANCELED', { cause: error });
      throwIfUnexpectedCacheError(error);
      return null;
    }
  }
  private async cleanAbandonedWork(): Promise<void> {
    for (const name of await readdir(this.directory)) {
      if (!name.startsWith('.work-')) continue;
      const directory = path.join(this.directory, name);
      if (activeWork.has(directory)) continue;
      try {
        const file = path.join(directory, 'owner.json');
        const info = await lstat(file);
        if (info.size > 4096) continue;
        const owner: unknown = JSON.parse(await readFile(file, 'utf8'));
        if (!record(owner) || !Number.isSafeInteger(owner.pid) || Number(owner.pid) < 1) continue;
        if (
          (owner.pid === process.pid && owner.boot !== BOOT) ||
          !processIsAlive(Number(owner.pid))
        )
          await rm(directory, { recursive: true, force: true });
      } catch {
        /* Unknown ownership never grants permission to remove work. */
      }
    }
  }
  private async evict(): Promise<void> {
    try {
      const entries: { directory: string; bytes: number; time: number }[] = [];
      for (const name of await readdir(this.directory)) {
        if (!/^[a-f0-9]{64}$/u.test(name)) continue;
        const directory = path.join(this.directory, name);
        try {
          const d = await lstat(directory);
          if (!d.isDirectory() || d.isSymbolicLink()) continue;
          const v = await lstat(path.join(directory, 'video.mp4')).catch(() => null);
          // Broken entries still count towards the entry cap; a missing media
          // file must never prevent valid old entries from being evicted.
          entries.push({ directory, bytes: v?.isFile() ? v.size : 0, time: d.mtimeMs });
        } catch {
          /* An entry may disappear during an independent cache read. */
        }
      }
      let bytes = entries.reduce((sum, e) => sum + e.bytes, 0);
      let count = entries.length;
      for (const e of entries.sort((a, b) => a.time - b.time)) {
        if (bytes <= this.maxBytes && count <= 64) break;
        if (pins.has(e.directory) || evicting.has(e.directory)) continue;
        const removal = rm(e.directory, { recursive: true, force: true }).catch(() => {});
        evicting.set(e.directory, removal);
        try {
          await removal;
        } finally {
          if (evicting.get(e.directory) === removal) evicting.delete(e.directory);
        }
        bytes -= e.bytes;
        count--;
      }
    } catch {
      /* Cache pressure cannot invalidate an already linked consumer. */
    }
  }
}
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function observe(work: () => void) {
  try {
    work();
  } catch {
    /* Observer failure cannot abandon owned work. */
  }
}
export async function hash(
  file: string,
  algorithm: 'md5' | 'sha256',
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted();
  const digest = createHash(algorithm);
  try {
    for await (const chunk of createReadStream(file, { signal })) digest.update(chunk);
    signal?.throwIfAborted();
    return digest.digest('hex');
  } catch (error) {
    if (signal?.aborted) throw new Error('PROCESS_CANCELED', { cause: error });
    throw error;
  }
}
// Corrupt/absent cache bytes are rebuildable. Cancellation and access/I/O errors
// are not permission to delete a previously verified cache entry.
function throwIfUnexpectedCacheError(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code && code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
}
async function sourceRevision(
  file: string,
  known: string | null | undefined,
  signal: AbortSignal
): Promise<Revision> {
  try {
    const facts = await stat(file).catch(() => {
      throw new Error('SOURCE_CHANGED');
    });
    if (!facts.isFile() || facts.size < 1) throw new Error('SOURCE_CHANGED');
    const match = known ? /^md5:([a-f0-9]{32}):(\d+)$/iu.exec(known) : null;
    const revision: Revision = {
      algorithm: match ? 'md5' : 'sha256',
      digest: match ? match[1]!.toLowerCase() : await hash(file, 'sha256', signal),
      size: facts.size
    };
    if (
      match &&
      (Number(match[2]) !== facts.size || (await hash(file, 'md5', signal)) !== revision.digest)
    )
      throw new Error('SOURCE_CHANGED');
    return revision;
  } catch {
    if (signal.aborted) throw new Error('PROCESS_CANCELED');
    throw new Error('SOURCE_CHANGED');
  }
}
async function assertRevision(file: string, revision: Revision, signal: AbortSignal) {
  try {
    const facts = await stat(file);
    if (
      facts.size !== revision.size ||
      (await hash(file, revision.algorithm, signal)) !== revision.digest
    )
      throw new Error('SOURCE_CHANGED');
  } catch {
    if (signal.aborted) throw new Error('PROCESS_CANCELED');
    throw new Error('SOURCE_CHANGED');
  }
}
function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('PROCESS_CANCELED'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('PROCESS_CANCELED'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}
