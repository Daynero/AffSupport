import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RestitchScreen } from '@video-compressor/shared';
import {
  SCREEN_CACHE_MAX_AGE_MS,
  TeamScreenCache,
  screenAssetId
} from '../apps/agent/src/team-bridge/screen-cache.js';
import type { DownloadedTeamSource } from '../apps/agent/src/team-bridge/transfer.js';
import { RESTITCH_FIXTURES, restitchFixturePath } from './fixtures/restitch-images/index.js';

/**
 * Feature 030: the space's pictures on this computer. Cache first, a fetch only for what is
 * missing, the cache again when the fetch fails but the bytes are here; keyed by bytes so a
 * replaced picture is a new file; aged out when no pool wants it; never a finger on the
 * compressor's own library next door.
 */

const TEAM = '30000000-0000-4000-8000-0000000000cc';
const MATERIAL = '31000000-0000-4000-8000-000000000001';

let directory: string;
let library: string;
let clock = 1_700_000_000_000;

function screen(
  name: keyof typeof RESTITCH_FIXTURES,
  overrides: Partial<RestitchScreen> = {}
): RestitchScreen {
  const fixture = RESTITCH_FIXTURES[name];
  return {
    slot: 'start',
    materialId: MATERIAL,
    checksum: fixture.md5,
    mimeType: fixture.mimeType as RestitchScreen['mimeType'],
    fileName: name,
    sizeBytes: fixture.bytes,
    transfer: {
      transferUrl: 'https://edge.test/drive-transfer/range',
      grant: {
        ticket: 't',
        purpose: 'download_range',
        expiresAt: '2099-01-01T00:00:00Z',
        maxRangeBytes: 1 << 20,
        maxUses: 10
      }
    },
    ...overrides
  };
}

/** A transfer that hands back a copy of a fixture, or throws, counting what it did. */
function transferOf(behaviour: 'copy' | 'fail' | ((name: string) => 'copy' | 'fail')) {
  const calls: string[] = [];
  return {
    calls,
    downloadSource: vi.fn(
      async (request: { operationId: string }): Promise<DownloadedTeamSource> => {
        calls.push(request.operationId);
        const name = request.operationId.slice('screen:'.length);
        const outcome = typeof behaviour === 'function' ? behaviour(name) : behaviour;
        if (outcome === 'fail') throw new Error('DRIVE_UNAVAILABLE');
        const workspace = await mkdtemp(path.join(directory, 'transfer-'));
        const file = path.join(workspace, 'source.bin');
        const fixture = fixtureByMaterial.get(name) ?? 'plain.png';
        const bytes = await readFile(restitchFixturePath(fixture));
        await writeFile(file, bytes);
        return {
          workspace,
          file,
          sizeBytes: bytes.length,
          sourceVersion: '1',
          sourceChecksum: createHash('md5').update(bytes).digest('hex'),
          cleanup: () => rm(workspace, { recursive: true, force: true })
        };
      }
    )
  };
}
const fixtureByMaterial = new Map<string, keyof typeof RESTITCH_FIXTURES>();

/** A probe that answers from the bytes: codec by magic number, frames by the fixture table. */
const probe = vi.fn(
  async (file: string, _command?: string, options?: { countFrames?: boolean }) => {
    const bytes = await readFile(file).catch(() => null);
    if (!bytes || bytes.length < 12) return null;
    const codec = bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      ? 'png'
      : bytes.readUInt16BE(0) === 0xffd8
        ? 'mjpeg'
        : bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
            bytes.subarray(8, 12).toString('ascii') === 'WEBP'
          ? 'webp'
          : null;
    if (!codec) return null;
    const md5 = createHash('md5').update(bytes).digest('hex');
    const animated = Object.values(RESTITCH_FIXTURES).some(
      meta => meta.animated && meta.md5 === md5
    );
    return { width: 64, height: 32, codec, frames: options?.countFrames && animated ? 2 : null };
  }
);

function cache(transfer: ReturnType<typeof transferOf>) {
  return new TeamScreenCache(
    { transfer, probe: probe as never, now: () => clock, log: () => {} },
    path.join(directory, 'TeamScreens')
  );
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'screen-cache-'));
  library = path.join(directory, 'Images');
  await writeFile(path.join(directory, 'library.png'), 'not touched');
  fixtureByMaterial.clear();
  fixtureByMaterial.set(MATERIAL, 'plain.png');
  clock = 1_700_000_000_000;
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('resolving a job’s screens', () => {
  it('fetches what is missing once, and serves it from disk afterwards', async () => {
    const transfer = transferOf('copy');
    const store = cache(transfer);
    const first = await store.resolve(TEAM, [screen('plain.png')], new AbortController().signal);
    expect(first[0]).toMatchObject({ slot: 'start', id: screenAssetId(screen('plain.png')) });
    expect(first[0]!.path).toBe(
      path.join(store.root, `${MATERIAL}-${RESTITCH_FIXTURES['plain.png'].md5}.png`)
    );
    expect(await readFile(first[0]!.path)).toEqual(
      await readFile(restitchFixturePath('plain.png'))
    );
    expect(store.pathFor(first[0]!.id)).toBe(first[0]!.path);

    const again = await store.resolve(TEAM, [screen('plain.png')], new AbortController().signal);
    expect(again[0]!.path).toBe(first[0]!.path);
    expect(transfer.downloadSource).toHaveBeenCalledTimes(1);
    expect(await readdir(directory)).toContain('library.png');
    expect(await readFile(path.join(directory, 'library.png'), 'utf8')).toBe('not touched');
  });

  it('is keyed by bytes: a replaced picture is a new file, a renamed one is not', async () => {
    const transfer = transferOf('copy');
    const store = cache(transfer);
    await store.resolve(TEAM, [screen('plain.png')], new AbortController().signal);
    fixtureByMaterial.set(MATERIAL, 'plain.jpg');
    const replaced = await store.resolve(
      TEAM,
      [screen('plain.jpg', { fileName: 'renamed.jpg' })],
      new AbortController().signal
    );
    expect(replaced[0]!.path).toContain(RESTITCH_FIXTURES['plain.jpg'].md5);
    expect(transfer.downloadSource).toHaveBeenCalledTimes(2);
    await store.resolve(
      TEAM,
      [screen('plain.jpg', { fileName: 'renamed-again.jpg' })],
      new AbortController().signal
    );
    expect(transfer.downloadSource).toHaveBeenCalledTimes(2);
  });

  it('refuses bytes that do not match the catalog’s md5', async () => {
    const transfer = transferOf('copy');
    const store = cache(transfer);
    await expect(
      store.resolve(
        TEAM,
        [screen('plain.png', { checksum: 'f'.repeat(32) })],
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_FETCH_FAILED' });
    expect((await readdir(store.root)).filter(name => !name.startsWith('index'))).toEqual([]);
  });

  it('uses the copy it has when the fetch fails, and names the failure when it has none', async () => {
    const good = cache(transferOf('copy'));
    await good.resolve(TEAM, [screen('plain.png')], new AbortController().signal);
    const flaky = cache(transferOf('fail'));
    const served = await flaky.resolve(TEAM, [screen('plain.png')], new AbortController().signal);
    expect(served[0]!.path).toContain(RESTITCH_FIXTURES['plain.png'].md5);
    await expect(
      flaky.resolve(
        TEAM,
        [screen('plain.jpg', { materialId: '31000000-0000-4000-8000-000000000002' })],
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_FETCH_FAILED' });
    await expect(
      flaky.resolve(
        TEAM,
        [
          screen('plain.jpg', {
            materialId: '31000000-0000-4000-8000-000000000003',
            transfer: null
          })
        ],
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_UNAVAILABLE' });
  });

  it('refuses an animated picture and leaves nothing behind', async () => {
    fixtureByMaterial.set(MATERIAL, 'animated.webp');
    const store = cache(transferOf('copy'));
    await expect(
      store.resolve(TEAM, [screen('animated.webp')], new AbortController().signal)
    ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_UNSUPPORTED' });
    expect((await readdir(store.root)).filter(name => name.endsWith('.webp'))).toEqual([]);
  });

  it('fails cleanly when the disk refuses the write', async () => {
    const store = cache(transferOf('copy'));
    // The cache directory is a file: every write into it fails like a full disk would.
    await writeFile(store.root, 'in the way');
    await expect(
      store.resolve(TEAM, [screen('plain.png')], new AbortController().signal)
    ).rejects.toBeTruthy();
    expect((await stat(path.join(directory, 'library.png'))).size).toBeGreaterThan(0);
  });
});

describe('making room', () => {
  it('drops what no pool wants once it is old, keeps what is named, and caps a space', async () => {
    const store = cache(transferOf('copy'));
    const kept = screen('plain.png');
    await store.resolve(TEAM, [kept], new AbortController().signal);
    const old = screen('plain.jpg', { materialId: '31000000-0000-4000-8000-000000000004' });
    fixtureByMaterial.set(old.materialId, 'plain.jpg');
    await store.resolve(TEAM, [old], new AbortController().signal);

    clock += SCREEN_CACHE_MAX_AGE_MS + 1;
    expect(await store.evict(TEAM, [screenAssetId(kept)])).toBe(1);
    expect(store.pathFor(screenAssetId(old))).toBeNull();
    expect(store.pathFor(screenAssetId(kept))).not.toBeNull();
    expect(
      (await readdir(store.root)).some(name => name.includes(RESTITCH_FIXTURES['plain.jpg'].md5))
    ).toBe(false);

    // Another space's copies are not this space's to drop.
    const other = '30000000-0000-4000-8000-0000000000dd';
    const theirs = screen('plain.webp', { materialId: '31000000-0000-4000-8000-000000000005' });
    fixtureByMaterial.set(theirs.materialId, 'plain.webp');
    await store.resolve(other, [theirs], new AbortController().signal);
    clock += SCREEN_CACHE_MAX_AGE_MS + 1;
    expect(await store.evict(TEAM, [])).toBe(1);
    expect(store.pathFor(screenAssetId(theirs))).not.toBeNull();
  });
});
