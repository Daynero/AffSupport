import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, stat, truncate, writeFile } from 'node:fs/promises';
import { removeTemporaryDirectory } from './support/temp-dir.js';
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
import { diagnostics } from '../apps/agent/src/server/diagnostics-log.js';

/**
 * Feature 030: the space's pictures on this computer. Cache first, a fetch only for what is
 * missing, the cache again when the fetch fails but the bytes are here; keyed by bytes so a
 * replaced picture is a new file; aged out when no pool wants it; never a finger on the
 * compressor's own library next door.
 */

const TEAM = '30000000-0000-4000-8000-0000000000cc';
const MATERIAL = '31000000-0000-4000-8000-000000000001';

let directory: string;
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
          cleanup: () => removeTemporaryDirectory(workspace)
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
    return {
      width: 64,
      height: 32,
      codec,
      frames: options?.countFrames ? (animated ? 2 : 1) : null
    };
  }
);

function cache(transfer: ReturnType<typeof transferOf>) {
  return new TeamScreenCache(
    { transfer, probe: probe as never, decode: async () => true, now: () => clock, log: () => {} },
    path.join(directory, 'TeamScreens')
  );
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'screen-cache-'));
  await writeFile(path.join(directory, 'library.png'), 'not touched');
  fixtureByMaterial.clear();
  fixtureByMaterial.set(MATERIAL, 'plain.png');
  clock = 1_700_000_000_000;
});

afterEach(async () => {
  await removeTemporaryDirectory(directory);
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
    const record = vi.spyOn(diagnostics, 'record');
    const transfer = transferOf('copy');
    const store = cache(transfer);
    await expect(
      store.resolve(
        TEAM,
        [screen('plain.png', { checksum: 'f'.repeat(32) })],
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_FETCH_FAILED' });
    expect(record).toHaveBeenCalledWith('team', 'screen_fetch_failed', {
      reason: 'checksum_mismatch'
    });
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
    ).rejects.toMatchObject({ code: 'DRIVE_UNAVAILABLE' });
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
    ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_FETCH_FAILED', reason: 'cache_write_failed' });
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

it('refetches a corrupt cache entry even when its image header still probes successfully', async () => {
  const transfer = transferOf('copy');
  const store = cache(transfer);
  const [first] = await store.resolve(TEAM, [screen('plain.png')], new AbortController().signal);
  const bytes = await readFile(first!.path);
  bytes[bytes.length - 1] ^= 1;
  await writeFile(first!.path, bytes);
  await store.resolve(TEAM, [screen('plain.png')], new AbortController().signal);
  expect(transfer.downloadSource).toHaveBeenCalledTimes(2);
  expect(await readFile(first!.path)).toEqual(await readFile(restitchFixturePath('plain.png')));
});

it('does not trust a provider checksum header over the checksum of the received bytes', async () => {
  const transfer = transferOf('copy');
  const original = transfer.downloadSource.getMockImplementation()!;
  transfer.downloadSource.mockImplementation(async request => {
    const result = await original(request);
    result.sourceChecksum = 'f'.repeat(32);
    return result;
  });
  await expect(
    cache(transfer).resolve(
      TEAM,
      [screen('plain.png', { checksum: 'f'.repeat(32) })],
      new AbortController().signal
    )
  ).rejects.toMatchObject({ reason: 'checksum_mismatch' });
});

it('does not accept even a warm screen after cancellation', async () => {
  const transfer = transferOf('copy');
  const store = cache(transfer);
  await store.resolve(TEAM, [screen('plain.png')], new AbortController().signal);
  const controller = new AbortController();
  controller.abort();
  await expect(store.resolve(TEAM, [screen('plain.png')], controller.signal)).rejects.toMatchObject(
    { name: 'AbortError' }
  );
  expect(transfer.downloadSource).toHaveBeenCalledTimes(1);
});

it('persists only file-specific refusals and isolates them by team and settings revision', async () => {
  fixtureByMaterial.set(MATERIAL, 'animated.webp');
  const store = cache(transferOf('copy'));
  const item = screen('animated.webp');
  await expect(
    store.resolve(TEAM, [item], new AbortController().signal, 'settings-1')
  ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_UNSUPPORTED' });
  const restarted = cache(transferOf('fail'));
  expect(await restarted.refused(TEAM, 'settings-1')).toEqual([
    { slot: 'start', materialId: MATERIAL, checksum: item.checksum }
  ]);
  expect(await restarted.refused(TEAM, 'settings-2')).toEqual([]);
  expect(await restarted.refused('other-team', 'settings-1')).toEqual([]);
  clock += 24 * 60 * 60 * 1000 + 1;
  expect(await restarted.refused(TEAM, 'settings-1')).toEqual([]);
});
it('does not blacklist a picture after a network outage', async () => {
  const store = cache(transferOf('fail'));
  await expect(
    store.resolve(TEAM, [screen('plain.png')], new AbortController().signal, 'settings-1')
  ).rejects.toMatchObject({ code: 'DRIVE_UNAVAILABLE' });
  expect(await store.refused(TEAM, 'settings-1')).toEqual([]);
});

it('refuses probeable bytes when the full decoder rejects them and remembers the version', async () => {
  const transfer = transferOf('copy');
  const decoder = vi.fn(async () => false);
  const instance = new TeamScreenCache(
    { transfer, probe: probe as never, decode: decoder },
    path.join(directory, 'decode-cache')
  );
  await expect(
    instance.resolve(TEAM, [screen('plain.png')], new AbortController().signal, 'settings')
  ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_UNSUPPORTED' });
  expect(await instance.refused(TEAM, 'settings')).toHaveLength(1);
  expect(instance.pathFor(screenAssetId(screen('plain.png')))).toBeNull();
});
it('does not blacklist an image when decoder resources time out', async () => {
  const transfer = transferOf('copy');
  const instance = new TeamScreenCache(
    {
      transfer,
      probe: probe as never,
      decode: async () => {
        throw new Error('RESTITCH_SCREEN_SELECTION_LIMIT');
      }
    },
    path.join(directory, 'decode-timeout')
  );
  await expect(
    instance.resolve(TEAM, [screen('plain.png')], new AbortController().signal, 'settings')
  ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_SELECTION_LIMIT' });
  expect(await instance.refused(TEAM, 'settings')).toEqual([]);
});

it('persists both source rejections when two jobs initialize the same cache concurrently', async () => {
  const store = cache(transferOf('copy'));
  const first = screen('plain.png', { checksum: 'f'.repeat(32) });
  const second = screen('plain.png', {
    materialId: '31000000-0000-4000-8000-000000000002',
    checksum: 'e'.repeat(32)
  });
  const results = await Promise.allSettled(
    [first, second].map(candidate =>
      store.resolve(TEAM, [candidate], new AbortController().signal, 'scope')
    )
  );
  expect(results.every(result => result.status === 'rejected')).toBe(true);
  const restarted = cache(transferOf('fail'));
  expect(await restarted.refused(TEAM, 'scope')).toHaveLength(2);
});

it('bounds actual downloaded file bytes even when transfer metadata underreports its size', async () => {
  const transfer = transferOf('copy');
  const download = transfer.downloadSource.getMockImplementation()!;
  transfer.downloadSource.mockImplementation(async request => {
    const result = await download(request);
    await truncate(result.file, 51 * 1024 * 1024);
    return result;
  });
  await expect(
    cache(transfer).resolve(TEAM, [screen('plain.png')], new AbortController().signal)
  ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_UNSUPPORTED' });
});

it.each([
  ['TOO_LARGE', 'RESTITCH_SCREEN_UNSUPPORTED', true],
  ['NOT_FOUND', 'RESTITCH_SCREEN_UNAVAILABLE', true],
  ['SOURCE_CHANGED', 'SOURCE_CHANGED', true],
  ['EXPIRED', 'EXPIRED', false],
  ['PERMISSION_DENIED', 'PERMISSION_DENIED', false],
  ['DRIVE_UNAVAILABLE', 'DRIVE_UNAVAILABLE', false]
] as const)(
  'retains the safe transfer cause %s and remembers only a candidate-local defect',
  async (cause, code, remembered) => {
    const transfer = transferOf('copy');
    transfer.downloadSource.mockRejectedValue(new Error(cause));
    const instance = cache(transfer);
    await expect(
      instance.resolve(TEAM, [screen('plain.png')], new AbortController().signal, 'scope')
    ).rejects.toMatchObject({ code });
    expect(await instance.refused(TEAM, 'scope')).toHaveLength(remembered ? 1 : 0);
  }
);
it('bounds screen transfer before provider I/O and identifies local temporary-disk exhaustion', async () => {
  const transfer = transferOf('copy');
  transfer.downloadSource.mockRejectedValue(
    Object.assign(new Error('private temp path'), { code: 'ENOSPC' })
  );
  const instance = cache(transfer);
  await expect(
    instance.resolve(TEAM, [screen('plain.png')], new AbortController().signal, 'scope')
  ).rejects.toMatchObject({ code: 'DISK_FULL', reason: 'cache_write_failed' });
  expect(transfer.downloadSource).toHaveBeenCalledWith(
    expect.objectContaining({ maxTotalBytes: 50 * 1024 * 1024, maxRetries: 2 }),
    expect.any(AbortSignal)
  );
  expect(await instance.refused(TEAM, 'scope')).toEqual([]);
});

function refusalEntry(index: number, overrides: Record<string, unknown> = {}) {
  return {
    teamId: TEAM,
    scope: 'settings-1',
    slot: 'start',
    materialId: `31000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    checksum: 'f'.repeat(32),
    rejectedAt: clock - 1000 + index,
    ...overrides
  };
}

it('retains independent refusal scopes across restart and a new rejection', async () => {
  const store = cache(transferOf('copy'));
  await mkdir(store.root, { recursive: true });
  const start = Array.from({ length: 512 }, (_, i) => refusalEntry(i));
  const end = Array.from({ length: 512 }, (_, i) => refusalEntry(i, { slot: 'end' }));
  const otherScope = refusalEntry(700, { scope: 'settings-2' });
  const otherTeam = refusalEntry(701, { teamId: 'other-team' });
  await writeFile(
    path.join(store.root, 'index.json'),
    JSON.stringify({
      entries: {},
      refusals: [...start, ...end, otherScope, otherTeam]
    })
  );
  expect(await store.refused(TEAM, 'settings-1')).toHaveLength(1024);
  expect(await store.refused(TEAM, 'settings-2')).toHaveLength(1);
  fixtureByMaterial.set(MATERIAL, 'animated.webp');
  await expect(
    store.resolve(TEAM, [screen('animated.webp')], new AbortController().signal, 'settings-1')
  ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_UNSUPPORTED' });
  const restarted = cache(transferOf('fail'));
  const rows = await restarted.refused(TEAM, 'settings-1');
  expect(rows.filter(row => row.slot === 'start')).toHaveLength(512);
  expect(rows.filter(row => row.slot === 'end')).toHaveLength(512);
  expect(rows.some(row => row.slot === 'start' && row.materialId === start[0]!.materialId)).toBe(
    false
  );
  expect(rows.some(row => row.slot === 'end' && row.materialId === end[0]!.materialId)).toBe(true);
  expect(await restarted.refused(TEAM, 'settings-2')).toHaveLength(1);
  expect(await restarted.refused('other-team', 'settings-1')).toHaveLength(1);
});

it('evicts the oldest refusal by timestamp even when disk history is out of order', async () => {
  const store = cache(transferOf('fail'));
  await mkdir(store.root, { recursive: true });
  const rows = Array.from({ length: 513 }, (_, i) => refusalEntry(i));
  await writeFile(
    path.join(store.root, 'index.json'),
    JSON.stringify({
      entries: {},
      refusals: [...rows].reverse()
    })
  );
  const kept = await store.refused(TEAM, 'settings-1');
  expect(kept).toHaveLength(512);
  expect(kept.some(row => row.materialId === rows[0]!.materialId)).toBe(false);
  expect(kept.some(row => row.materialId === rows[512]!.materialId)).toBe(true);
});

it('does not extend refusal expiry when later clicks read the remembered version', async () => {
  fixtureByMaterial.set(MATERIAL, 'animated.webp');
  const store = cache(transferOf('copy'));
  await expect(
    store.resolve(TEAM, [screen('animated.webp')], new AbortController().signal, 'settings')
  ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_UNSUPPORTED' });
  clock += 24 * 60 * 60 * 1000 - 1;
  expect(await store.refused(TEAM, 'settings')).toHaveLength(1);
  expect(await store.refusalHistory(TEAM)).toHaveLength(1);
  clock += 1;
  expect(await cache(transferOf('fail')).refused(TEAM, 'settings')).toEqual([]);
});

it('clears a repaired version only after a successful full validation', async () => {
  const transfer = transferOf('copy');
  let valid = false;
  const store = new TeamScreenCache(
    { transfer, decode: async () => valid, now: () => clock },
    path.join(directory, 'TeamScreens')
  );
  await expect(
    store.resolve(TEAM, [screen('plain.png')], new AbortController().signal, 'settings')
  ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_UNSUPPORTED' });
  expect(await store.refused(TEAM, 'settings')).toHaveLength(1);
  valid = true;
  await expect(
    store.resolve(TEAM, [screen('plain.png')], new AbortController().signal, 'settings')
  ).resolves.toHaveLength(1);
  expect(await cache(transferOf('fail')).refused(TEAM, 'settings')).toEqual([]);
});
