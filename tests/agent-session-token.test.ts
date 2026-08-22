import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSessionToken } from '../apps/agent/src/server/session-token.js';

const temporaries: string[] = [];

async function scratchFile() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soty-session-token-'));
  temporaries.push(directory);
  return path.join(directory, 'session-token.json');
}

afterEach(async () => {
  for (const directory of temporaries.splice(0)) {
    await chmod(directory, 0o700).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

describe('the Agent pairing token across restarts', () => {
  it('answers to the same token after a restart', async () => {
    // The reason this file exists: a per-boot token silently unpaired every
    // browser that already held one, and the user had to re-pair by hand before
    // Soty would work again.
    const file = await scratchFile();

    const first = await resolveSessionToken(file);
    const second = await resolveSessionToken(file);

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });

  it('stores the token privately and nowhere else', async () => {
    const file = await scratchFile();

    const token = await resolveSessionToken(file);

    const stored = JSON.parse(await readFile(file, 'utf8'));
    expect(stored.token).toBe(token);
    expect(typeof stored.createdAt).toBe('string');
  });

  it('mints a new token rather than trusting a damaged file', async () => {
    for (const damaged of ['not json at all', '{}', '{"token":"short"}', '{"token":42}']) {
      const file = await scratchFile();
      await writeFile(file, damaged, 'utf8');

      const token = await resolveSessionToken(file);

      expect(token).toMatch(/^[a-f0-9]{64}$/);
      expect(token).not.toBe('short');
    }
  });

  it('still starts when the token cannot be written', async () => {
    // A read-only or full disk must cost the user a re-pair after restart, never
    // an Agent that refuses to start.
    const directory = await mkdtemp(path.join(os.tmpdir(), 'soty-session-token-ro-'));
    temporaries.push(directory);
    const nested = path.join(directory, 'locked');
    await mkdir(nested);
    await chmod(nested, 0o500);

    const token = await resolveSessionToken(path.join(nested, 'session-token.json'));

    expect(token).toMatch(/^[a-f0-9]{64}$/);
  });
});
