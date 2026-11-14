import { mkdtemp, readFile, writeFile, stat, lstat, rename, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  NativeRestitchVaultFile,
  replaceFile
} from '../apps/agent/src/team-bridge/native-restitch-vault';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { itRequiring, requirePlatform } from './support/requires.js';
import * as updateReceipt from '../apps/agent/src/update/receipt';
const osCredential = vi.hoisted(() => vi.fn());
vi.mock('../apps/agent/src/platform/platform', async importOriginal => ({
  ...(await importOriginal<typeof import('../apps/agent/src/platform/platform')>()),
  recoveryCredential: osCredential
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat), rename: vi.fn(actual.rename) };
});
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(lstat).mockImplementation(actual.lstat);
  vi.mocked(rename).mockImplementation(actual.rename);
  osCredential.mockReset();
});
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await removeTemporaryDirectory(root);
});
it('uses only a fixed-size key through the default platform store and recovers the encrypted snapshot after restart', async () => {
  const x = await setup();
  const values = new Map<string, string>();
  osCredential.mockImplementation(async (action: string, account: string, value?: string) => {
    if (action === 'write') {
      values.set(account, value!);
      return null;
    }
    return values.get(account) ?? null;
  });
  const vault = new NativeRestitchVaultFile(x.file, x.account);
  await vault.write({ secret: 'private retained credential' });
  expect(osCredential).toHaveBeenCalledWith(
    'write',
    `${x.account}-key`,
    expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u)
  );
  expect([...values.keys()]).toEqual([`${x.account}-key`]);
  expect(await new NativeRestitchVaultFile(x.file, x.account).read()).toEqual({
    secret: 'private retained credential'
  });
  expect((await readFile(x.file)).includes(Buffer.from('private retained credential'))).toBe(false);
});
it('waits for a pending encrypted write before update flushing and permits an absent vault', async () => {
  const x = await setup();
  await expect(x.vault.flushForUpdate()).resolves.toBeUndefined();
  let entered!: () => void, release!: () => void;
  const writing = new Promise<void>(r => {
    entered = r;
  });
  const canWrite = new Promise<void>(r => {
    release = r;
  });
  x.store.write.mockImplementationOnce(async (key, value) => {
    entered();
    await canWrite;
    x.values.set(key, value);
  });
  const synced = vi.spyOn(updateReceipt, 'syncUpdateStateFiles');
  const written = x.vault.write({ secret: 'pending' });
  await writing;
  const flushed = x.vault.flushForUpdate();
  try {
    expect(synced).not.toHaveBeenCalled();
  } finally {
    release();
  }
  await Promise.all([written, flushed]);
  expect(synced).toHaveBeenCalledWith([x.file]);
  expect(await x.vault.read()).toEqual({ secret: 'pending' });
});
it('propagates unavailable update storage and does not discard retained credentials', async () => {
  const x = await setup();
  await x.vault.write({ secret: 'retained' });
  const unavailable = Object.assign(new Error('synthetic storage unavailable'), { code: 'EIO' });
  vi.mocked(lstat).mockRejectedValueOnce(unavailable);
  await expect(x.vault.flushForUpdate()).rejects.toBe(unavailable);
  expect(await x.vault.read()).toEqual({ secret: 'retained' });
});
it('refuses a nonserializable snapshot without touching the key or the committed ciphertext', async () => {
  const x = await setup();
  await x.vault.write({ secret: 'retained' });
  const before = await readFile(x.file),
    reads = x.store.read.mock.calls.length;
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  await expect(x.vault.write(cyclic)).rejects.toThrow('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
  expect(await readFile(x.file)).toEqual(before);
  expect(x.store.read).toHaveBeenCalledTimes(reads);
});
it('preserves the last committed ciphertext when atomic replacement fails and allows a later retry', async () => {
  const x = await setup();
  await x.vault.write({ secret: 'retained' });
  const before = await readFile(x.file);
  vi.mocked(rename).mockRejectedValueOnce(
    Object.assign(new Error('/private/failed-path'), { code: 'EIO' })
  );
  await expect(x.vault.write({ secret: 'not committed' })).rejects.toThrow(
    'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  );
  expect(await readFile(x.file)).toEqual(before);
  expect((await readdir(path.dirname(x.file))).filter(name => name.endsWith('.tmp'))).toEqual([]);
  expect(await x.vault.read()).toEqual({ secret: 'retained' });
  await x.vault.write({ secret: 'retried' });
  expect(await x.vault.read()).toEqual({ secret: 'retried' });
});
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-vault-'));
  roots.push(root);
  const values = new Map<string, string>();
  const store = {
    read: vi.fn(async (key: string) => values.get(key) ?? null),
    write: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    })
  };
  const file = path.join(root, 'credentials.vault'),
    account = 'soty-recovery-synthetic-vault';
  return { file, account, store, values, vault: new NativeRestitchVaultFile(file, account, store) };
}
it('round-trips a large retained journal while OS secret writes stay 43 bytes', async () => {
  const x = await setup(),
    value = {
      schemaVersion: 1,
      records: Array.from({ length: 64 }, (_, i) => ({
        id: i,
        secret: 'private-token-' + i + 'x'.repeat(1300)
      }))
    };
  await x.vault.write(value);
  expect(await x.vault.read()).toEqual(value);
  expect(x.store.write).toHaveBeenCalledTimes(1);
  expect(x.store.write.mock.calls[0]![1]).toHaveLength(43);
  expect((await readFile(x.file)).includes(Buffer.from('private-token'))).toBe(false);
});
itRequiring(
  requirePlatform('darwin', 'linux'),
  'writes the encrypted vault with private POSIX permissions',
  async () => {
    const x = await setup();
    await x.vault.write({ secret: 'retained' });
    expect((await stat(x.file)).mode & 0o777).toBe(0o600);
  }
);
it('reads intact legacy credentials and migrates without rewriting their Keychain entry', async () => {
  const x = await setup(),
    old = { records: [{ secret: 'retained' }] };
  x.values.set(x.account, Buffer.from(JSON.stringify(old)).toString('base64url'));
  expect(await x.vault.read()).toEqual(old);
  await x.vault.write(old);
  expect(await x.vault.read()).toEqual(old);
  expect(x.values.get(x.account)).toBe(Buffer.from(JSON.stringify(old)).toString('base64url'));
});
it('keeps a corrupt legacy journal fenced instead of treating it as empty', async () => {
  const x = await setup();
  x.values.set(x.account, 'broken');
  await expect(x.vault.read()).rejects.toThrow('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
  expect(x.store.write).not.toHaveBeenCalled();
});
it('refuses ciphertext modification and a missing key without generating replacement authority', async () => {
  const x = await setup();
  await x.vault.write({ secret: 'retained' });
  const bytes = await readFile(x.file);
  bytes[bytes.length - 1]! ^= 1;
  await writeFile(x.file, bytes);
  await expect(x.vault.read()).rejects.toThrow('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
  x.values.clear();
  await expect(x.vault.read()).rejects.toThrow('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
  expect(x.store.write).toHaveBeenCalledTimes(1);
});
it('rejects oversized snapshots without losing the previous committed journal', async () => {
  const x = await setup();
  await x.vault.write({ secret: 'retained' });
  await expect(x.vault.write({ large: 'x'.repeat(262145) })).rejects.toThrow();
  expect(await x.vault.read()).toEqual({ secret: 'retained' });
});
it('serializes concurrent writes and captures the original snapshot', async () => {
  const x = await setup(),
    first = { n: 1 };
  const a = x.vault.write(first);
  first.n = 99;
  const b = x.vault.write({ n: 2 });
  await Promise.all([a, b]);
  expect(await x.vault.read()).toEqual({ n: 2 });
  expect(x.store.write).toHaveBeenCalledTimes(1);
});
it('macOS keeps asking the OS store for the key on every journal operation', async () => {
  const x = await setup();
  const vault = new NativeRestitchVaultFile(x.file, x.account, x.store, {
    cacheKey: false,
    retryRename: false
  });
  await vault.write({ n: 1 });
  await vault.write({ n: 2 });
  await vault.read();
  // create (read, write, verify) + one read per later write and read
  expect(x.store.read).toHaveBeenCalledTimes(4);
});
it('Windows keeps the verified key for the process: one cold store start, not one per write', async () => {
  const x = await setup();
  const vault = new NativeRestitchVaultFile(x.file, x.account, x.store, {
    cacheKey: true,
    retryRename: true
  });
  await vault.write({ n: 1 });
  const afterCreate = x.store.read.mock.calls.length;
  for (let n = 2; n < 8; n++) await vault.write({ n });
  expect(await vault.read()).toEqual({ n: 7 });
  expect(x.store.read).toHaveBeenCalledTimes(afterCreate);
  expect(x.store.write).toHaveBeenCalledTimes(1);
  // A fresh process still reads the same key from the store and the journal.
  const restarted = new NativeRestitchVaultFile(x.file, x.account, x.store, {
    cacheKey: true,
    retryRename: true
  });
  expect(await restarted.read()).toEqual({ n: 7 });
});
it('Windows does not cache a missing key or invent one on read', async () => {
  const x = await setup();
  const vault = new NativeRestitchVaultFile(x.file, x.account, x.store, {
    cacheKey: true,
    retryRename: true
  });
  await writeFile(x.file, Buffer.alloc(64));
  await expect(vault.read()).rejects.toThrow('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
  await expect(vault.read()).rejects.toThrow('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
  expect(x.store.write).not.toHaveBeenCalled();
});
it('retries a Windows file replacement refused while another process holds the file', async () => {
  const busy = (code: string) => Object.assign(new Error(code), { code });
  const waits: number[] = [];
  const move = vi
    .fn<(from: string, to: string) => Promise<void>>()
    .mockRejectedValueOnce(busy('EPERM'))
    .mockRejectedValueOnce(busy('EBUSY'))
    .mockRejectedValueOnce(busy('EACCES'))
    .mockResolvedValueOnce();
  await replaceFile('a', 'b', true, move, async ms => {
    waits.push(ms);
  });
  expect(move).toHaveBeenCalledTimes(4);
  expect(waits).toEqual([50, 100, 200]);
});
it('replaces once elsewhere, never retries other errors, and gives up after a bounded wait', async () => {
  const busy = (code: string) => Object.assign(new Error(code), { code });
  const once = vi.fn(async () => {
    throw busy('EPERM');
  });
  await expect(replaceFile('a', 'b', false, once, async () => {})).rejects.toThrow('EPERM');
  expect(once).toHaveBeenCalledTimes(1);
  const missing = vi.fn(async () => {
    throw busy('ENOENT');
  });
  await expect(replaceFile('a', 'b', true, missing, async () => {})).rejects.toThrow('ENOENT');
  expect(missing).toHaveBeenCalledTimes(1);
  const stuck = vi.fn(async () => {
    throw busy('EPERM');
  });
  const waits: number[] = [];
  await expect(
    replaceFile('a', 'b', true, stuck, async ms => {
      waits.push(ms);
    })
  ).rejects.toThrow('EPERM');
  expect(stuck).toHaveBeenCalledTimes(6);
  expect(waits.reduce((a, b) => a + b, 0)).toBe(1550);
});
