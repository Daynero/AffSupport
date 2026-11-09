import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  TeamScreenCache,
  ScreenCacheError,
  type ProtectedScreenCacheBinding
} from '../apps/agent/src/team-bridge/screen-cache';
import { RESTITCH_FIXTURES, restitchFixturePath } from './fixtures/restitch-images';
import { removeTemporaryDirectory } from './support/temp-dir';
import { diagnostics } from '../apps/agent/src/server/diagnostics-log';
import type { DownloadedTeamSource } from '../apps/agent/src/team-bridge/transfer';
import { RestitchScreenDownloadError } from '../apps/agent/src/team-bridge/restitch-screen-download';
const id = (n: number) => 'b1640000-0000-4000-8000-' + String(n).padStart(12, '0');
let root: string;
const binding = (): ProtectedScreenCacheBinding => ({
  selectionProtocol: 1,
  rootOperationId: id(1),
  teamId: id(2),
  actorId: id(3),
  poolNamespaceId: id(4),
  executorId: id(5),
  epoch: 1,
  nativeInstanceId: id(6),
  versionId: id(7),
  acquisition: 0,
  slot: 'end',
  materialId: id(8),
  checksum: RESTITCH_FIXTURES['plain.png'].md5,
  mimeType: 'image/png',
  sizeBytes: RESTITCH_FIXTURES['plain.png'].bytes
});
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'protected-screen-cache-'));
});
afterEach(async () => {
  await removeTemporaryDirectory(root);
  vi.restoreAllMocks();
});
function fixture() {
  const generic = vi.fn(async () => {
    throw Error('GENERIC_TRANSFER_MUST_NOT_RUN');
  });
  const decode = vi.fn(async () => true),
    cleanup = vi.fn(async () => {});
  const store = new TeamScreenCache(
    { transfer: { downloadSource: generic }, decode },
    path.join(root, 'cache')
  );
  const authorize = vi.fn(async (value: Readonly<ProtectedScreenCacheBinding>) => ({ ...value }));
  const download = vi.fn(
    async (
      _binding: Readonly<ProtectedScreenCacheBinding>,
      _signal: AbortSignal
    ): Promise<DownloadedTeamSource> => {
      const workspace = await mkdtemp(path.join(root, 'source-')),
        file = path.join(workspace, 'screen.bin');
      const bytes = await readFile(restitchFixturePath('plain.png'));
      await writeFile(file, bytes);
      return {
        workspace,
        file,
        sizeBytes: bytes.length,
        sourceVersion: '1',
        sourceChecksum: RESTITCH_FIXTURES['plain.png'].md5,
        cleanup: async () => {
          cleanup();
          await removeTemporaryDirectory(workspace);
        }
      };
    }
  );
  return { store, generic, decode, cleanup, authorize, download, loader: { authorize, download } };
}
it('uses the dedicated loader after exact owner/root/version acknowledgement without a generic grant', async () => {
  const f = fixture(),
    scope = binding();
  const result = await f.store.resolveProtected(scope, f.loader, new AbortController().signal);
  expect(await readFile(result.path)).toEqual(await readFile(restitchFixturePath('plain.png')));
  expect(result.slot).toBe('end');
  expect(f.store.pathFor(result.id)).toBe(result.path);
  expect(f.authorize).toHaveBeenCalledTimes(1);
  expect(f.download).toHaveBeenCalledTimes(1);
  expect(f.cleanup).toHaveBeenCalledTimes(1);
  expect(f.generic).not.toHaveBeenCalled();
  expect(Object.isFrozen(f.authorize.mock.calls[0]![0])).toBe(true);
});
it('revalidates authority and actual cached bytes for every root while avoiding another transfer', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  const first = await f.store.resolveProtected(binding(), f.loader, signal);
  const second = await f.store.resolveProtected(
    { ...binding(), rootOperationId: id(9) },
    f.loader,
    signal
  );
  expect(second.path).toBe(first.path);
  expect(f.authorize).toHaveBeenCalledTimes(2);
  expect(f.decode).toHaveBeenCalledTimes(2);
  expect(f.download).toHaveBeenCalledTimes(1);
  expect(f.generic).not.toHaveBeenCalled();
});
it('does not return a warm cached image after authority is revoked', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  await f.store.resolveProtected(binding(), f.loader, signal);
  const before = await readFile(path.join(f.store.root, 'index.json'), 'utf8');
  f.authorize.mockRejectedValueOnce(new ScreenCacheError('PERMISSION_DENIED'));
  await expect(f.store.resolveProtected(binding(), f.loader, signal)).rejects.toMatchObject({
    code: 'PERMISSION_DENIED'
  });
  expect(f.decode).toHaveBeenCalledTimes(1);
  expect(f.download).toHaveBeenCalledTimes(1);
  expect(await readFile(path.join(f.store.root, 'index.json'), 'utf8')).toBe(before);
});
it.each([
  { actorId: id(9) },
  { teamId: id(9) },
  { poolNamespaceId: id(9) },
  { rootOperationId: id(9) },
  { executorId: id(9) },
  { epoch: 2 },
  { nativeInstanceId: id(9) },
  { versionId: id(9) },
  { acquisition: 1 },
  { slot: 'start' },
  { materialId: id(9) },
  { checksum: '0'.repeat(32) },
  { mimeType: 'image/jpeg' },
  { sizeBytes: 1 },
  { selectionProtocol: 0 }
])('refuses substituted authority before cache or downloader access %j', async change => {
  const f = fixture();
  f.authorize.mockResolvedValueOnce({ ...binding(), ...change } as ProtectedScreenCacheBinding);
  await expect(
    f.store.resolveProtected(binding(), f.loader, new AbortController().signal)
  ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  expect(f.download).not.toHaveBeenCalled();
  expect(f.decode).not.toHaveBeenCalled();
  expect(f.generic).not.toHaveBeenCalled();
  expect(await readdir(f.store.root).catch(() => [])).toEqual([]);
});
it('captures original bindings before awaiting authorization and never forwards extra payloads', async () => {
  const f = fixture(),
    scope = binding(),
    original = { ...scope };
  let finish!: () => void;
  const ready = new Promise<void>(resolve => {
    finish = resolve;
  });
  f.authorize.mockImplementationOnce(async captured => {
    await ready;
    return { ...captured };
  });
  const promise = f.store.resolveProtected(
    Object.assign(scope, { unexpectedPrivate: 'SYNTHETIC_PRIVATE' }),
    f.loader,
    new AbortController().signal
  );
  scope.actorId = id(9);
  finish();
  await promise;
  expect(f.authorize.mock.calls[0]![0]).toEqual(original);
  expect(f.download.mock.calls[0]?.[0]).toEqual(original);
  expect(await readFile(path.join(f.store.root, 'index.json'), 'utf8')).not.toContain(
    'SYNTHETIC_PRIVATE'
  );
});
it('remembers only the refused immutable version in its acknowledged actor/pool namespace', async () => {
  const f = fixture(),
    scope = binding();
  const record = vi.spyOn(diagnostics, 'record');
  f.download.mockImplementationOnce(async () => {
    const workspace = await mkdtemp(path.join(root, 'bad-')),
      file = path.join(workspace, 'screen.bin');
    const bytes = await readFile(restitchFixturePath('plain.png'));
    bytes[0] ^= 1;
    await writeFile(file, bytes);
    return {
      workspace,
      file,
      sizeBytes: bytes.length,
      sourceVersion: '1',
      sourceChecksum: scope.checksum,
      cleanup: async () => {
        f.cleanup();
        await removeTemporaryDirectory(workspace);
      }
    };
  });
  await expect(
    f.store.resolveProtected(scope, f.loader, new AbortController().signal)
  ).rejects.toMatchObject({ reason: 'checksum_mismatch' });
  expect(await f.store.refusedProtected(scope.teamId, scope.poolNamespaceId)).toEqual([
    { slot: 'end', versionId: scope.versionId }
  ]);
  expect(await f.store.refusedProtected(scope.teamId, id(10))).toEqual([]);
  expect(await f.store.refused(scope.teamId, scope.poolNamespaceId)).toEqual([]);
  expect(record).toHaveBeenCalledWith(
    'team',
    'screen_candidate_rejected',
    expect.objectContaining({
      operationId: scope.rootOperationId,
      versionId: scope.versionId,
      slot: scope.slot,
      reason: 'checksum_mismatch'
    })
  );
  expect(JSON.stringify(record.mock.calls)).not.toContain(scope.checksum);
  expect(JSON.stringify(record.mock.calls)).not.toContain(root);
  expect(f.cleanup).toHaveBeenCalledTimes(1);
  expect(f.generic).not.toHaveBeenCalled();
  const reloaded = new TeamScreenCache(
    { transfer: { downloadSource: f.generic }, decode: f.decode },
    f.store.root
  );
  expect(await reloaded.refusedProtected(scope.teamId, scope.poolNamespaceId)).toHaveLength(1);
});
it.each(['DRIVE_UNAVAILABLE', 'DISK_FULL'])(
  'does not quarantine an image after the general failure %s',
  async code => {
    const f = fixture();
    f.download.mockRejectedValueOnce(new ScreenCacheError(code));
    await expect(
      f.store.resolveProtected(binding(), f.loader, new AbortController().signal)
    ).rejects.toMatchObject({ code });
    expect(await f.store.refusedProtected(binding().teamId, binding().poolNamespaceId)).toEqual([]);
  }
);
it.each([
  'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN',
  'RESTITCH_SCREEN_BYTE_LIMIT',
  'RESTITCH_SCREEN_IO_LIMIT',
  'RESTITCH_SCREEN_SELECTION_LIMIT',
  'RESTITCH_SCREEN_FETCH_FAILED',
  'AUTH_REQUIRED',
  'WRONG_STATE',
  'REQUEST_REUSE_CONFLICT',
  'DISK_FULL',
  'PROCESS_CANCELED',
  'INVALID_RESPONSE'
] as const)(
  'preserves protected transport reason %s without quarantining the source',
  async code => {
    const f = fixture();
    f.download.mockRejectedValueOnce(new RestitchScreenDownloadError(code, id(99)));
    await expect(
      f.store.resolveProtected(binding(), f.loader, new AbortController().signal)
    ).rejects.toMatchObject({ code, requestId: id(99) });
    expect(await f.store.refusedProtected(binding().teamId, binding().poolNamespaceId)).toEqual([]);
    expect(f.generic).not.toHaveBeenCalled();
  }
);
it('stops before cache work if cancellation arrives during authorization', async () => {
  const f = fixture(),
    controller = new AbortController();
  let finish!: () => void;
  const ready = new Promise<void>(resolve => {
    finish = resolve;
  });
  f.authorize.mockImplementationOnce(async value => {
    await ready;
    return { ...value };
  });
  const promise = f.store.resolveProtected(binding(), f.loader, controller.signal);
  controller.abort();
  finish();
  await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.download).not.toHaveBeenCalled();
  expect(f.decode).not.toHaveBeenCalled();
});
it('keeps the legacy generic-purpose allowlist closed for dedicated screen tickets', async () => {
  const f = fixture(),
    b = binding();
  await expect(
    f.store.resolve(
      b.teamId,
      [
        {
          slot: b.slot,
          materialId: b.materialId,
          checksum: b.checksum,
          mimeType: b.mimeType,
          sizeBytes: b.sizeBytes,
          fileName: 'screen.png',
          transfer: {
            transferUrl: 'https://example.invalid/functions/v1/drive-transfer/range',
            grant: {
              purpose: 'restitch_screen_range_v1',
              ticket: 'a'.repeat(43),
              expiresAt: '2099-01-01T00:00:00Z',
              maxRangeBytes: 2097152,
              maxUses: 1
            }
          }
        }
      ],
      new AbortController().signal
    )
  ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_UNAVAILABLE' });
  expect(f.generic).not.toHaveBeenCalled();
});

it.each([null, undefined, [], Object.create(binding())])(
  'refuses a missing or inherited authority receipt %j',
  async value => {
    const f = fixture();
    f.authorize.mockResolvedValueOnce(value as ProtectedScreenCacheBinding);
    await expect(
      f.store.resolveProtected(binding(), f.loader, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(f.download).not.toHaveBeenCalled();
    expect(f.decode).not.toHaveBeenCalled();
  }
);

it('stores simultaneous authorized copies without a staging-file collision or cache corruption', async () => {
  const f = fixture();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
  try {
    const result = await Promise.allSettled([
      f.store.resolveProtected(binding(), f.loader, new AbortController().signal),
      f.store.resolveProtected(
        { ...binding(), rootOperationId: id(9) },
        f.loader,
        new AbortController().signal
      )
    ]);
    expect(result.map(item => item.status)).toEqual(['fulfilled', 'fulfilled']);
    for (const item of result) {
      if (item.status === 'fulfilled')
        expect(await readFile(item.value.path)).toEqual(
          await readFile(restitchFixturePath('plain.png'))
        );
    }
    expect(f.cleanup).toHaveBeenCalledTimes(2);
    expect(f.generic).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});

it('does not quarantine a corrected metadata version that retains the same image bytes', async () => {
  const f = fixture(),
    original = binding(),
    stale = { ...original, sizeBytes: original.sizeBytes + 1 };
  await expect(
    f.store.resolveProtected(stale, f.loader, new AbortController().signal)
  ).rejects.toMatchObject({ code: 'SOURCE_CHANGED', reason: 'source_changed' });
  const corrected = { ...original, versionId: id(11) };
  await expect(
    f.store.resolveProtected(corrected, f.loader, new AbortController().signal)
  ).resolves.toMatchObject({ slot: 'end' });
  expect(await f.store.refusedProtected(original.teamId, original.poolNamespaceId)).toEqual([
    { slot: 'end', versionId: stale.versionId }
  ]);
  expect(f.download).toHaveBeenCalledTimes(2);
  expect(f.cleanup).toHaveBeenCalledTimes(2);
});

it('keeps the original loader methods if a retained caller object is changed during authorization', async () => {
  const f = fixture();
  let finish!: () => void;
  const pending = new Promise<void>(resolve => {
    finish = resolve;
  });
  f.authorize.mockImplementationOnce(async value => {
    await pending;
    return { ...value };
  });
  const result = f.store.resolveProtected(binding(), f.loader, new AbortController().signal);
  const replacement = vi.fn(async () => {
    throw Error('SUBSTITUTED_LOADER');
  });
  Object.assign(f.loader, { download: replacement });
  finish();
  await result;
  expect(f.download).toHaveBeenCalledTimes(1);
  expect(replacement).not.toHaveBeenCalled();
});
