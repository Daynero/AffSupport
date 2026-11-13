import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  NativeRestitchVaultFile,
  replaceFile
} from '../apps/agent/src/team-bridge/native-restitch-vault';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { itRequiring, requirePlatform } from './support/requires.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeTemporaryDirectory(root);
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
