import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import type { SourceProfile, StitchPlan } from '@video-compressor/shared';

// The body builder's media tools are replaced: these tests are about who builds a body and
// when, not about FFmpeg. Every "encode" writes its output file and counts itself.
const tools = vi.hoisted(() => ({
  calls: 0,
  delayMs: 0,
  failRaw: false,
  checkInputs: false,
  gate: null as Promise<void> | null,
  args: [] as string[][]
}));
vi.mock('../apps/agent/src/stitcher/run.js', async () => {
  const fs = await import('node:fs/promises');
  return {
    runTool: async (_command: string, args: string[], options?: { signal?: AbortSignal }) => {
      tools.calls += 1;
      tools.args.push(args);
      if (tools.gate) await tools.gate;
      if (tools.delayMs) await new Promise(resolve => setTimeout(resolve, tools.delayMs));
      if (options?.signal?.aborted)
        return { code: 1, cancelled: true, spawnErrorCode: null, stderr: '' };
      if (tools.checkInputs) {
        try {
          await fs.readFile(args[args.indexOf('-i') + 1]!);
        } catch {
          return { code: 1, cancelled: false, spawnErrorCode: null, stderr: 'missing input' };
        }
      }
      if (tools.failRaw && args.includes('rawvideo'))
        return { code: 1, cancelled: false, spawnErrorCode: null, stderr: 'no' };
      await fs.writeFile(args[args.length - 1] as string, 'body');
      return { code: 0, cancelled: false, spawnErrorCode: null, stderr: '' };
    },
    toolSucceeded: (result: { code: number }) => result.code === 0
  };
});
vi.mock('../apps/agent/src/stitcher/verify.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../apps/agent/src/stitcher/verify.js')>();
  return {
    ...actual,
    // A copied body that measures exactly as planned needs no recovery.
    measureOutput: async () => ({
      videoTrackSeconds: 10,
      audioTrackSeconds: 10,
      audioCodec: 'aac'
    })
  };
});

const { PreparedBodyCache, preparedBodyKey } =
  await import('../apps/agent/src/stitcher/body-cache.js');
const { TeamSourceCache } = await import('../apps/agent/src/team-bridge/source-cache.js');
const { TeamTransferClient } = await import('../apps/agent/src/team-bridge/transfer.js');
const { contentIdentity } = await import('../apps/agent/src/team-bridge/restitch.js');
const { buildScreenSegment } = await import('../apps/agent/src/stitcher/segments.js');

const roots: string[] = [];
async function root() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'soty-multi-variation-'));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  tools.calls = 0;
  tools.delayMs = 0;
  tools.failRaw = false;
  tools.checkInputs = false;
  tools.gate = null;
  tools.args = [];
  await Promise.all(roots.splice(0).map(dir => removeTemporaryDirectory(dir)));
});

function profile(file: string, modifiedAtMs: number): SourceProfile {
  return {
    path: file,
    sizeBytes: 1000,
    modifiedAtMs,
    frameRate: 30,
    hasAudio: false
  } as unknown as SourceProfile;
}
const plan = {
  bodyStartSeconds: 0,
  bodyEndSeconds: 10,
  headReencodeUntilSeconds: null
} as unknown as StitchPlan;

describe('a body shared by every variation of one source', () => {
  it('keys a verified source by its content, not by the workspace it was downloaded into', () => {
    const identity = contentIdentity('A'.repeat(32), 1000);
    expect(identity).toBe(`md5:${'a'.repeat(32)}:1000`);
    const first = profile('/tmp/op-1/source.bin', 1);
    const second = profile('/tmp/op-2/source.bin', 2);
    expect(preparedBodyKey(first, plan, identity)).toBe(preparedBodyKey(second, plan, identity));
    // Without a verified identity the old, path-and-mtime rule stays in force.
    expect(preparedBodyKey(first, plan)).not.toBe(preparedBodyKey(second, plan));
    expect(contentIdentity(null, 1000)).toBeNull();
    expect(contentIdentity('not-md5', 1000)).toBeNull();
  });

  it('builds the body once for the first variation and serves every later one from the cache', async () => {
    const cache = new PreparedBodyCache({ root: await root() });
    const identity = contentIdentity('b'.repeat(32), 1000);
    const first = await cache.prepare({
      profile: profile('/tmp/op-1/source.bin', 1),
      plan,
      sourceIdentity: identity
    });
    expect(first).toMatchObject({ ok: true, value: { fromCache: false } });
    const builds = tools.calls;
    expect(builds).toBeGreaterThan(0);
    for (const op of [2, 3, 4]) {
      const later = await cache.prepare({
        profile: profile(`/tmp/op-${op}/source.bin`, op),
        plan,
        sourceIdentity: identity
      });
      expect(later).toMatchObject({ ok: true, value: { fromCache: true } });
    }
    expect(tools.calls).toBe(builds);
  });

  it('lets two variations that reach the body together share one build', async () => {
    tools.delayMs = 30;
    const cache = new PreparedBodyCache({ root: await root() });
    const identity = contentIdentity('c'.repeat(32), 1000);
    const [a, b] = await Promise.all([
      cache.prepare({ profile: profile('/tmp/a/source.bin', 1), plan, sourceIdentity: identity }),
      cache.prepare({ profile: profile('/tmp/b/source.bin', 2), plan, sourceIdentity: identity })
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect([a, b].filter(r => r.ok && !r.value.fromCache)).toHaveLength(1);
    // remux + one measurement is one build; a second build would double it.
    expect(tools.calls).toBe(1);
  });
});

describe('a source held on this computer', () => {
  const bytes = new Uint8Array([10, 11, 12, 13, 14, 15, 16, 17]);
  const md5 = createHash('md5').update(bytes).digest('hex');

  it('places only a held copy whose bytes still match their MD5, and drops one that does not', async () => {
    const dir = await root();
    const cache = new TeamSourceCache({ root: dir });
    const downloaded = path.join(dir, 'downloaded.bin');
    await writeFile(downloaded, bytes);
    await cache.keep(md5, bytes.length, downloaded);

    const placed = path.join(dir, 'placed.bin');
    expect(await cache.place(md5, bytes.length, placed, new AbortController().signal)).toBe(true);
    expect([...new Uint8Array(await readFile(placed))]).toEqual([...bytes]);

    // A held file whose content changed under the same name is refused and forgotten.
    const held = cache.pathFor(md5, bytes.length);
    const { rm } = await import('node:fs/promises');
    await rm(held);
    await writeFile(held, new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]));
    const again = path.join(dir, 'again.bin');
    expect(await cache.place(md5, bytes.length, again, new AbortController().signal)).toBe(false);
    await expect(stat(again)).rejects.toThrow();
    await expect(stat(held)).rejects.toThrow();
  });

  it('does not keep a source larger than one entry may be', async () => {
    const dir = await root();
    const cache = new TeamSourceCache({ root: dir, maxEntryBytes: 4 });
    const downloaded = path.join(dir, 'downloaded.bin');
    await writeFile(downloaded, bytes);
    await cache.keep(md5, bytes.length, downloaded);
    await expect(stat(cache.pathFor(md5, bytes.length))).rejects.toThrow();
  });

  it('downloads a source once; the next operation over the same bytes reads one range and the disk', async () => {
    const dir = await root();
    const temporary = path.join(dir, 'tmp');
    await mkdir(temporary);
    const sourceCache = new TeamSourceCache({ root: path.join(dir, 'support') });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const range = new Headers(init?.headers).get('range');
      const start = Number(/^bytes=(\d+)-/u.exec(range ?? '')?.[1] ?? 0);
      const end = Math.min(start + 3, 7);
      return new Response(bytes.slice(start, end + 1), {
        status: 206,
        headers: {
          'content-length': String(end - start + 1),
          'content-range': `bytes ${start}-${end}/8`,
          'x-wishly-source-version': '3',
          'x-wishly-source-checksum': md5
        }
      });
    });
    const grant = {
      ticket: 'opaque-process_input-ticket-with-enough-entropy',
      purpose: 'process_input',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxRangeBytes: 4,
      maxUses: 8
    } as const;
    const request = (operationId: string) => ({
      operationId,
      transferUrl: 'https://project.supabase.co/functions/v1/drive-transfer/range',
      grant
    });
    const client = new TeamTransferClient({ fetchImpl, temporaryRoot: temporary, sourceCache });

    const first = await client.downloadSource(request('variation-1'), new AbortController().signal);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await first.cleanup();

    const second = await client.downloadSource(
      request('variation-2'),
      new AbortController().signal
    );
    // One more ranged read — the one that names the bytes — and nothing else.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(second).toMatchObject({ sizeBytes: 8, sourceVersion: '3', sourceChecksum: md5 });
    expect([...new Uint8Array(await readFile(second.file))]).toEqual([...bytes]);
    await second.cleanup();
    expect(await readdir(temporary)).toEqual([]);
  });
});

describe('a held screen', () => {
  const screenProfile = {
    path: '/unused',
    width: 1280,
    height: 720,
    pixelFormat: 'yuv420p',
    frameRate: 30,
    videoTimescale: 15360,
    profile: 'High',
    level: 40
  } as unknown as SourceProfile;
  const held = { frameRate: 1, durationSeconds: 30, frames: 30, aacFrames: 0 } as never;

  async function build(dir: string) {
    const image = path.join(dir, 'end.png');
    await writeFile(image, 'not-a-real-png');
    return buildScreenSegment({
      imagePath: image,
      profile: screenProfile,
      screen: held,
      fitMode: 'cover',
      workDir: dir,
      name: 'outro',
      silenceBankPath: null
    });
  }

  it('fits the picture once and loops the fitted frame', async () => {
    const result = await build(await root());
    expect(result.ok).toBe(true);
    const encodes = tools.args.filter(args => args.includes('libx264'));
    expect(encodes).toHaveLength(1);
    expect(encodes[0]).toContain('-stream_loop');
    expect(encodes[0]).not.toContain('-loop');
  });

  it('falls back to the single encode when the fitted frame cannot be made', async () => {
    tools.failRaw = true;
    const result = await build(await root());
    expect(result.ok).toBe(true);
    const encodes = tools.args.filter(args => args.includes('libx264'));
    expect(encodes).toHaveLength(1);
    expect(encodes[0]).toContain('-loop');
    expect(encodes[0]).not.toContain('-stream_loop');
  });
});

it('materializes twenty independent consumers before eviction can remove the shared body', async () => {
  const directory = await root();
  const cache = new PreparedBodyCache({ root: directory, maxBytes: 1 });
  tools.delayMs = 20;
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      cache.prepare({
        profile: profile(`/tmp/batch-${index}/source.bin`, index),
        plan,
        sourceIdentity: contentIdentity('c'.repeat(32), 1000),
        workspacePath: path.join(directory, `consumer-${index}.mp4`)
      })
    )
  );
  expect(tools.calls).toBe(1);
  expect(results.every(result => result.ok)).toBe(true);
  for (const result of results)
    if (result.ok) expect(await readFile(result.value.path, 'utf8')).toBe('body');
  expect(new Set(results.flatMap(result => (result.ok ? [result.value.path] : []))).size).toBe(20);
  if (!results[0]?.ok) throw new Error('first consumer missing');
  await unlink(results[0].value.path);
  for (const result of results.slice(1))
    if (result.ok) expect(await readFile(result.value.path, 'utf8')).toBe('body');
});

it('cancels a waiting consumer promptly without canceling the shared producer', async () => {
  const cache = new PreparedBodyCache({ root: await root() });
  tools.delayMs = 100;
  const options = {
    profile: profile('/tmp/producer/source.bin', 1),
    plan,
    sourceIdentity: contentIdentity('d'.repeat(32), 1000)
  };
  let completed = false;
  const producer = cache.prepare(options).then(result => {
    completed = true;
    return result;
  });
  const controller = new AbortController();
  const waiter = cache.prepare({ ...options, signal: controller.signal });
  controller.abort();
  expect(await waiter).toEqual({ ok: false, error: 'STITCH_CANCELLED' });
  expect(completed).toBe(false);
  expect((await producer).ok).toBe(true);
  expect(tools.calls).toBe(1);
});

it('never overwrites a shared cached inode when a consumer workspace is reused', async () => {
  const directory = await root();
  const cache = new PreparedBodyCache({ root: directory });
  const source = profile('/synthetic/one.mp4', 1);
  const workspacePath = path.join(directory, 'consumer.mp4');
  const first = await cache.prepare({
    profile: source,
    plan,
    workspacePath,
    sourceIdentity: 'verified:first'
  });
  expect(first.ok).toBe(true);
  await writeFile(workspacePath, 'first immutable content');
  const second = await cache.prepare({
    profile: source,
    plan,
    workspacePath,
    sourceIdentity: 'verified:second'
  });
  expect(second.ok).toBe(true);
  expect(await readFile(cache.pathFor(source, plan, 'verified:first'), 'utf8')).toBe(
    'first immutable content'
  );
  expect(await readFile(workspacePath, 'utf8')).toBe('body');
});

it('rebuilds from a surviving verified copy when the shared producer input is deleted during preparation', async () => {
  const directory = await root();
  const cache = new PreparedBodyCache({ root: directory });
  const gone = path.join(directory, 'gone.mp4'),
    kept = path.join(directory, 'kept.mp4');
  await Promise.all([writeFile(gone, 'source'), writeFile(kept, 'source')]);
  tools.checkInputs = true;
  let release!: () => void;
  tools.gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const options = { plan, sourceIdentity: 'verified:same' };
  const first = cache.prepare({ ...options, profile: profile(gone, 1) });
  await vi.waitFor(() => expect(tools.calls).toBe(1));
  const second = cache.prepare({
    ...options,
    profile: profile(kept, 2),
    workspacePath: path.join(directory, 'consumer.mp4')
  });
  await unlink(gone);
  release();
  expect((await first).ok).toBe(false);
  const survived = await second;
  expect(survived.ok).toBe(true);
  if (survived.ok) expect(await readFile(survived.value.path, 'utf8')).toBe('body');
  expect(tools.calls).toBe(2);
  expect((await cache.prepare({ ...options, profile: profile(kept, 2) })).ok).toBe(true);
  expect(tools.calls).toBe(2);
});

it('a cancelled shared producer cannot cancel the other nineteen consumers', async () => {
  const directory = await root(),
    cache = new PreparedBodyCache({ root: directory });
  let release!: () => void;
  tools.gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const controller = new AbortController();
  const options = {
    plan,
    sourceIdentity: 'verified:cancel',
    profile: profile('/synthetic/source', 1)
  };
  const first = cache.prepare({ ...options, signal: controller.signal });
  await vi.waitFor(() => expect(tools.calls).toBe(1));
  const rest = Array.from({ length: 19 }, (_, index) =>
    cache.prepare({ ...options, workspacePath: path.join(directory, `consumer-${index}.mp4`) })
  );
  controller.abort();
  release();
  expect(await first).toEqual({ ok: false, error: 'STITCH_CANCELLED' });
  expect((await Promise.all(rest)).every(result => result.ok)).toBe(true);
  expect(tools.calls).toBe(2);
});
