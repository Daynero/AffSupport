import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The secret that makes this computer a space's re-stitching computer (023).
 *
 * Handed over once by the web right after enrolment and kept in the support directory, readable by
 * this user only. It unlocks nothing but claiming the updater's re-stitch work for one space: every
 * file it touches still goes through short-lived grants the server mints and re-checks. It is never
 * logged, never returned by a route, and removed when the member switches the computer off.
 */

export interface UpdaterCredential {
  teamId: string;
  deviceId: string;
  secret: string;
  /** drive-ops' public address, as the web reaches it; the runner derives its routes from it. */
  cloudBaseUrl: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SECRET = /^[0-9a-f]{64}$/u;

/** drive-ops over https, or over http on this machine (the local beta stack). */
export function safeCloudBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const loopback = ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !url.pathname.replace(/\/$/u, '').endsWith('/functions/v1/drive-ops')
  ) {
    return null;
  }
  return url.toString().replace(/\/$/u, '');
}

export function parseUpdaterCredential(value: unknown): UpdaterCredential | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const cloudBaseUrl = safeCloudBaseUrl(record.cloudBaseUrl);
  if (
    typeof record.teamId !== 'string' ||
    !UUID.test(record.teamId) ||
    typeof record.deviceId !== 'string' ||
    !UUID.test(record.deviceId) ||
    typeof record.secret !== 'string' ||
    !SECRET.test(record.secret) ||
    !cloudBaseUrl
  ) {
    return null;
  }
  return {
    teamId: record.teamId.toLowerCase(),
    deviceId: record.deviceId.toLowerCase(),
    secret: record.secret,
    cloudBaseUrl
  };
}

export class UpdaterCredentialStore {
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;
  }

  async read(): Promise<UpdaterCredential | null> {
    try {
      return parseUpdaterCredential(JSON.parse(await readFile(this.#file, 'utf8')));
    } catch {
      return null;
    }
  }

  /** Written beside itself and renamed into place, so a crash never leaves half a secret. */
  async write(credential: UpdaterCredential): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });
    const staged = `${this.#file}.${process.pid}.tmp`;
    await writeFile(staged, `${JSON.stringify(credential)}\n`, { mode: 0o600 });
    // The mode passed to writeFile is masked by the umask; this is not.
    await chmod(staged, 0o600).catch(() => undefined);
    await rename(staged, this.#file);
  }

  async clear(): Promise<void> {
    await rm(this.#file, { force: true });
  }
}
