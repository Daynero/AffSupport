import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { currentPlatform, recoveryCredential } from '../platform/platform.js';
const MAX = 256 * 1024;
const HEADER = Buffer.from('SOTYRV01');
const fail = () => new Error('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
interface Secrets {
  read(account: string): Promise<string | null>;
  write(account: string, value: string): Promise<void>;
}
const secrets: Secrets = {
  read: account => recoveryCredential('read', account),
  write: async (account, value) => {
    await recoveryCredential('write', account, value);
  }
};
/** Windows refuses to replace a file another process (antivirus, the search
 * indexer) holds open for a moment after it was written: EPERM/EACCES/EBUSY.
 * Retried briefly there, as graceful-fs does; anywhere else one rename. */
const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;
export async function replaceFile(
  from: string,
  to: string,
  retry: boolean,
  move: (from: string, to: string) => Promise<void> = rename,
  wait: (ms: number) => Promise<void> = ms => new Promise(done => setTimeout(done, ms))
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await move(from, to);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (
        !retry ||
        attempt >= RENAME_RETRY_DELAYS_MS.length ||
        !['EPERM', 'EACCES', 'EBUSY'].includes(String(code))
      )
        throw error;
      await wait(RENAME_RETRY_DELAYS_MS[attempt]!);
    }
  }
}
/** Only the fixed-size encryption key enters OS secret storage. Credentials remain
 * authenticated, encrypted and atomically replaced on disk, bounded independently
 * of the macOS security CLI's interactive command buffer. */
export class NativeRestitchVaultFile {
  #writes: Promise<void> = Promise.resolve();
  #cachedKey: Buffer | null = null;
  constructor(
    readonly file: string,
    readonly account: string,
    private readonly store = secrets,
    /**
     * Windows only (production 2026-11-12): the OS store is a cold PowerShell
     * start per call, and every journal write used to make one. Under a busy CPU
     * one slow start faulted the catalog restitch vault until restart. The key
     * never changes once created, so after one verified read it is kept for the
     * life of the process. macOS keeps asking the Keychain every time.
     */
    private readonly platform: { cacheKey: boolean; retryRename: boolean } = {
      cacheKey: currentPlatform() === 'win32',
      retryRename: currentPlatform() === 'win32'
    }
  ) {}
  async #key(create: boolean): Promise<Buffer> {
    if (this.#cachedKey) return this.#cachedKey;
    let raw = await this.store.read(this.account + '-key');
    if (raw === null && create) {
      raw = randomBytes(32).toString('base64url');
      await this.store.write(this.account + '-key', raw);
      if ((await this.store.read(this.account + '-key')) !== raw) throw fail();
    }
    if (!raw || !/^[A-Za-z0-9_-]{43}$/u.test(raw)) throw fail();
    const key = Buffer.from(raw, 'base64url');
    if (key.length !== 32) throw fail();
    if (this.platform.cacheKey) this.#cachedKey = key;
    return key;
  }
  async read(): Promise<unknown> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.file, 'r');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw fail();
      // Existing deployments migrate only after the old payload parses. A damaged
      // legacy value remains fenced and is never silently replaced with empty state.
      const legacy = await this.store.read(this.account);
      if (legacy === null) return null;
      if (legacy.length > 400000) throw fail();
      try {
        return JSON.parse(Buffer.from(legacy, 'base64url').toString('utf8'));
      } catch {
        throw fail();
      }
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 36 || stat.size > MAX + 36) throw fail();
      const bytes = Buffer.alloc(MAX + 37);
      let size = 0;
      while (size < bytes.length) {
        const part = await handle.read(bytes, size, bytes.length - size, null);
        if (!part.bytesRead) break;
        size += part.bytesRead;
      }
      if (size !== stat.size || size > MAX + 36) throw fail();
      const data = bytes.subarray(0, size);
      if (!data.subarray(0, 8).equals(HEADER)) throw fail();
      const decipher = createDecipheriv(
        'aes-256-gcm',
        await this.#key(false),
        data.subarray(8, 20)
      );
      decipher.setAAD(Buffer.from(this.account));
      decipher.setAuthTag(data.subarray(20, 36));
      return JSON.parse(
        Buffer.concat([decipher.update(data.subarray(36)), decipher.final()]).toString('utf8')
      );
    } catch {
      throw fail();
    } finally {
      await handle.close();
    }
  }
  write(value: unknown): Promise<void> {
    // Capture before queuing: later mutations cannot alter the persisted snapshot.
    let plain: Buffer;
    try {
      plain = Buffer.from(JSON.stringify(value));
    } catch {
      return Promise.reject(fail());
    }
    if (plain.length > MAX) return Promise.reject(fail());
    const work = this.#writes.then(async () => {
      const key = await this.#key(true),
        nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(this.account));
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
      const data = Buffer.concat([HEADER, nonce, cipher.getAuthTag(), encrypted]);
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = this.file + '.' + randomUUID() + '.tmp';
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(data);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await replaceFile(temporary, this.file, this.platform.retryRename);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.#writes = work.catch(() => {});
    return work.catch(() => {
      throw fail();
    });
  }
}
