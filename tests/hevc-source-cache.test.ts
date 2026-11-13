import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SourceProfile } from '@video-compressor/shared';
import {
  VerifiedSourceCache,
  type VerifiedSourceCacheRequest
} from '../apps/agent/src/stitcher/verified-source-cache';
import { removeTemporaryDirectory } from './support/temp-dir';
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});
let root = '';
const inputBytes = 'independently verified HEVC source bytes';
const outputBytes = 'verified H264 bytes';
const identity = `md5:${createHash('md5').update(inputBytes).digest('hex')}:${Buffer.byteLength(inputBytes)}`;
const profile: SourceProfile = {
  path: 'staged',
  sizeBytes: outputBytes.length,
  modifiedAtMs: 1,
  container: 'mov,mp4',
  videoCodec: 'h264',
  profile: 'High',
  level: 30,
  width: 640,
  height: 360,
  pixelFormat: 'yuv420p',
  colorRange: 'tv',
  frameRate: 30,
  variableFrameRate: false,
  videoTimescale: 90000,
  durationSeconds: 2,
  hasAudio: false,
  audioCodec: null,
  audioSampleRate: null,
  audioChannels: null,
  audioBitrateKbps: null,
  keyframeTimes: [0]
};
beforeEach(async () => {
  vi.mocked(createReadStream).mockImplementation(
    (await vi.importActual<typeof import('node:fs')>('node:fs')).createReadStream
  );
  root = await mkdtemp(path.join(os.tmpdir(), 'soty-hevc-cache-'));
});
it('aborts an in-flight source hash and closes its stream before acknowledging cancellation', async () => {
  const c = await consumer(50);
  const bytes = Buffer.alloc(4 * 1024 * 1024, 1);
  await writeFile(c.request.sourceFile, bytes);
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  let stream: ReturnType<typeof createReadStream> | undefined;
  const produce = vi.fn(c.request.produce);
  vi.mocked(createReadStream).mockImplementationOnce((file, options) => {
    stream = actual.createReadStream(file, options);
    stream.once('data', () => c.controller.abort());
    return stream;
  });
  await expect(c.cache.prepare({ ...c.request, sourceIdentity: null, produce })).rejects.toThrow(
    'PROCESS_CANCELED'
  );
  expect(stream?.closed).toBe(true);
  expect(stream?.bytesRead).toBeLessThan(bytes.length);
  expect(produce).not.toHaveBeenCalled();
});
it('cancels cache byte validation without deleting the verified entry or starting another encode', async () => {
  const first = await consumer(51);
  const bytes = Buffer.alloc(2 * 1024 * 1024, 2);
  const produce = vi.fn(async (directory: string) => {
    const file = path.join(directory, 'staged.mp4');
    await writeFile(file, bytes);
    return { file, profile };
  });
  await first.cache.prepare({ ...first.request, produce });
  const second = await consumer(52, first.cache);
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  let cachedStream: ReturnType<typeof createReadStream> | undefined;
  vi.mocked(createReadStream).mockImplementation((file, options) => {
    const stream = actual.createReadStream(file, options);
    if (String(file).endsWith(`${path.sep}video.mp4`)) {
      cachedStream = stream;
      stream.once('data', () => second.controller.abort());
    }
    return stream;
  });
  await expect(second.cache.prepare({ ...second.request, produce })).rejects.toThrow(
    'PROCESS_CANCELED'
  );
  expect(cachedStream?.closed).toBe(true);
  expect(cachedStream?.bytesRead).toBeLessThan(bytes.length);
  expect(await entries()).toHaveLength(1);
  vi.mocked(createReadStream).mockImplementation(actual.createReadStream);
  const third = await consumer(53, first.cache);
  expect((await third.cache.prepare({ ...third.request, produce })).fromCache).toBe(true);
  expect(produce).toHaveBeenCalledTimes(1);
});
afterEach(async () => {
  vi.mocked(createReadStream).mockClear();
  await removeTemporaryDirectory(root);
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}
async function consumer(
  n: number,
  cache = new VerifiedSourceCache({ root })
): Promise<{
  cache: VerifiedSourceCache;
  controller: AbortController;
  request: VerifiedSourceCacheRequest;
}> {
  const workspace = path.join(root, `consumer-${n}`);
  await mkdir(workspace, { recursive: true });
  const sourceFile = path.join(workspace, 'original.mp4');
  await writeFile(sourceFile, inputBytes);
  const controller = new AbortController();
  return {
    cache,
    controller,
    request: {
      sourceFile,
      workspace,
      sourceIdentity: identity,
      policy: 'test-policy-v1',
      signal: controller.signal,
      produce: async directory => {
        const file = path.join(directory, 'staged.mp4');
        await writeFile(file, outputBytes);
        return { file, profile };
      }
    }
  };
}
async function entries() {
  return (await readdir(path.join(root, 'stitcher', 'compatible-sources'))).filter(v =>
    /^[a-f0-9]{64}$/u.test(v)
  );
}
it('single-flights ten consumers and preserves nine when the first cancels and its workspace disappears', async () => {
  const cache = new VerifiedSourceCache({ root });
  const release = deferred(),
    started = deferred();
  let runs = 0;
  const consumers = await Promise.all(Array.from({ length: 10 }, (_, i) => consumer(i, cache)));
  const produce: VerifiedSourceCacheRequest['produce'] = async (
    directory,
    input,
    signal,
    progress
  ) => {
    runs++;
    started.resolve();
    progress(0.5);
    await release.promise;
    expect(signal.aborted).toBe(false);
    expect(await readFile(input, 'utf8')).toBe(inputBytes);
    const file = path.join(directory, 'staged.mp4');
    await writeFile(file, outputBytes);
    return { file, profile };
  };
  let registered = 0;
  const allRegistered = deferred();
  const promises = consumers.map(c =>
    c.cache.prepare({
      ...c.request,
      produce,
      onStage: stage => {
        if (stage === 'cache_check' && ++registered === 10) allRegistered.resolve();
      }
    })
  );
  const cancelled = promises[0]!.catch(e => e as Error);
  await started.promise;
  await allRegistered.promise;
  consumers[0]!.controller.abort();
  expect(await cancelled).toMatchObject({ message: 'PROCESS_CANCELED' });
  await removeTemporaryDirectory(consumers[0]!.request.workspace);
  release.resolve();
  const results = await Promise.all(promises.slice(1));
  expect(runs).toBe(1);
  expect(new Set(results.map(r => r.sharedId)).size).toBe(1);
  for (const result of results) expect(await readFile(result.file, 'utf8')).toBe(outputBytes);
});
it('joins real cleanup before acknowledging the last cancellation and promotes no partial output', async () => {
  const c = await consumer(0);
  const started = deferred(),
    finishCleanup = deferred(),
    cleanupEntered = deferred();
  let cleaned = false,
    settled = false;
  const result = c.cache
    .prepare({
      ...c.request,
      produce: async (directory, _input, signal) => {
        await writeFile(path.join(directory, 'partial.mp4'), 'partial');
        started.resolve();
        try {
          await new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(new Error('PROCESS_CANCELED')), {
              once: true
            })
          );
        } finally {
          cleanupEntered.resolve();
          await finishCleanup.promise;
          cleaned = true;
        }
        throw new Error('unreachable');
      }
    })
    .catch(e => {
      settled = true;
      return e as Error;
    });
  await started.promise;
  c.controller.abort();
  await cleanupEntered.promise;
  expect(settled).toBe(false);
  finishCleanup.resolve();
  expect(await result).toMatchObject({ message: 'PROCESS_CANCELED' });
  expect(cleaned).toBe(true);
  expect(await entries()).toEqual([]);
  expect(
    (await readdir(path.join(root, 'stitcher', 'compatible-sources'))).filter(n =>
      n.startsWith('.work-')
    )
  ).toEqual([]);
});
it('isolates a producer input change and retries an unaffected consumer from its own bytes', async () => {
  const cache = new VerifiedSourceCache({ root });
  const first = await consumer(0, cache),
    second = await consumer(1, cache);
  const started = deferred(),
    release = deferred(),
    joined = deferred();
  let runs = 0;
  const produce: VerifiedSourceCacheRequest['produce'] = async directory => {
    if (++runs === 1) {
      started.resolve();
      await release.promise;
    }
    const file = path.join(directory, 'staged.mp4');
    await writeFile(file, outputBytes);
    return { file, profile };
  };
  const bad = cache.prepare({ ...first.request, produce }).catch(e => e as Error);
  await started.promise;
  const good = cache.prepare({
    ...second.request,
    produce,
    onStage: stage => {
      if (stage === 'cache_check') joined.resolve();
    }
  });
  await joined.promise;
  await writeFile(first.request.sourceFile, 'changed original source');
  release.resolve();
  expect(await bad).toMatchObject({ message: 'SOURCE_CHANGED' });
  expect(await readFile((await good).file, 'utf8')).toBe(outputBytes);
  expect(runs).toBe(2);
});
it('rejects a mismatched input revision before conversion and keeps independent sources usable', async () => {
  const bad = await consumer(0);
  await writeFile(bad.request.sourceFile, 'different');
  const produce = vi.fn(bad.request.produce);
  await expect(bad.cache.prepare({ ...bad.request, produce })).rejects.toThrow('SOURCE_CHANGED');
  expect(produce).not.toHaveBeenCalled();
  const good = await consumer(1, bad.cache);
  expect((await good.cache.prepare(good.request)).fromCache).toBe(false);
});
it('verifies cached bytes, ignores restart leftovers and invalidates a changed policy', async () => {
  const c = await consumer(0);
  let runs = 0;
  const produce = vi.fn(async (...args: Parameters<VerifiedSourceCacheRequest['produce']>) => {
    runs++;
    return c.request.produce(...args);
  });
  const first = await c.cache.prepare({ ...c.request, produce });
  expect(first.fromCache).toBe(false);
  const next = await consumer(1, c.cache);
  expect((await c.cache.prepare({ ...next.request, produce })).fromCache).toBe(true);
  expect(runs).toBe(1);
  const directory = path.join(root, 'stitcher', 'compatible-sources');
  const orphan = path.join(directory, '.work-orphan');
  await mkdir(orphan);
  await writeFile(
    path.join(orphan, 'owner.json'),
    JSON.stringify({ pid: process.pid, boot: 'previous-boot' })
  );
  await writeFile(path.join(orphan, 'video.mp4'), 'unverified');
  const entry = (await entries())[0]!;
  await writeFile(path.join(directory, entry, 'video.mp4'), 'corrupted same cache');
  const restarted = new VerifiedSourceCache({ root });
  const third = await consumer(2, restarted);
  expect((await restarted.prepare({ ...third.request, produce })).fromCache).toBe(false);
  expect(runs).toBe(2);
  expect(await readdir(directory)).not.toContain('.work-orphan');
  const fourth = await consumer(3, restarted);
  await restarted.prepare({ ...fourth.request, produce, policy: 'test-policy-v2' });
  expect(runs).toBe(3);
});
it('evicts completed cache entries without invalidating a consumer link', async () => {
  const c = await consumer(0, new VerifiedSourceCache({ root, maxBytes: 0 }));
  const result = await c.cache.prepare(c.request);
  expect(await entries()).toEqual([]);
  expect(await readFile(result.file, 'utf8')).toBe(outputBytes);
});
it('keeps enforcing the disk cap when an older malformed key directory has no media', async () => {
  const broken = '0'.repeat(64);
  await mkdir(path.join(root, 'stitcher', 'compatible-sources', broken), { recursive: true });
  const c = await consumer(54, new VerifiedSourceCache({ root, maxBytes: 0 }));
  const result = await c.cache.prepare(c.request);
  expect((await entries()).filter(key => key !== broken)).toEqual([]);
  expect(await readFile(result.file, 'utf8')).toBe(outputBytes);
});
it('does not promote a failed producer or leak its partial result into a retry', async () => {
  const c = await consumer(0);
  await expect(
    c.cache.prepare({
      ...c.request,
      produce: async directory => {
        await writeFile(path.join(directory, 'partial.mp4'), 'unverified');
        throw Object.assign(new Error('STITCH_TOOL_FAILED'), { code: 'ENOSPC' });
      }
    })
  ).rejects.toThrow('STITCH_TOOL_FAILED');
  expect(await entries()).toEqual([]);
  expect((await c.cache.prepare(c.request)).fromCache).toBe(false);
});
