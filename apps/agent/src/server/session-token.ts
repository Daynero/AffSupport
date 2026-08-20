import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applicationSupportRoot } from '../files/support-dir.js';

/** A pairing token is 32 random bytes, hex-encoded. */
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Where the pairing token lives.
 *
 * Its own file, mode 0600, next to the other agent-owned state. It is keyed to
 * the machine and never synced: it authorises loopback callers, so carrying it
 * to another computer would be meaningless at best.
 */
export function sessionTokenPath(): string {
  return (
    process.env.AGENT_SESSION_TOKEN_PATH ??
    path.join(applicationSupportRoot(), 'session-token.json')
  );
}

/**
 * Returns the pairing token this agent should answer to, reusing the stored
 * one when it is still readable and well-formed.
 *
 * The token used to be minted per boot, which quietly made every agent restart
 * an unpairing: the browser kept the previous token in localStorage, `/api/*`
 * answered 401, and the user had to re-pair by hand before Soty would work
 * again. Surviving a restart is the whole point of persisting it.
 *
 * Failure is never fatal. An unreadable file, a corrupt one, or a directory
 * that cannot be written yields a fresh in-memory token, so an agent on a
 * read-only or full disk still starts and still pairs — it just goes back to
 * needing a re-pair after a restart, which is exactly the old behaviour.
 */
export async function resolveSessionToken(filePath = sessionTokenPath()): Promise<string> {
  const stored = await readStoredToken(filePath);
  if (stored) return stored;
  const token = randomBytes(32).toString('hex');
  await writeToken(filePath, token).catch(() => {
    // Best effort: the agent runs with a per-boot token instead.
  });
  return token;
}

async function readStoredToken(filePath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const token = (parsed as { token?: unknown }).token;
  return typeof token === 'string' && TOKEN_PATTERN.test(token) ? token : null;
}

/**
 * Writes the token atomically through a temp file in the same directory, so a
 * crash mid-write leaves either the old token or the new one — never a
 * half-written file that reads as corrupt and forces a re-pair on next boot.
 *
 * The temp file is created 0600 as well: a token that is briefly world-readable
 * is a token that leaked.
 */
async function writeToken(filePath: string, token: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  const payload = { token, createdAt: new Date().toISOString() };
  try {
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
