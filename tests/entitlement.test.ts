import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ENTITLEMENT_OFFLINE_GRACE_MS,
  ENTITLEMENT_TOKEN_PREFIX,
  EntitlementGate
} from '../apps/agent/src/entitlement/entitlement.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

function issueToken(payload: Record<string, unknown>, key = privateKey): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signed = `${ENTITLEMENT_TOKEN_PREFIX}.${encoded}`;
  const signature = signBytes('sha256', Buffer.from(signed, 'utf8'), {
    key,
    dsaEncoding: 'ieee-p1363'
  });
  return `${signed}.${signature.toString('base64url')}`;
}

function validPayload(nowMs: number, ttlSeconds = 12 * 3600) {
  const iat = Math.floor(nowMs / 1000);
  return { v: 1, sub: 'user-1', plan: 'free', iat, exp: iat + ttlSeconds };
}

let directory = '';
afterEach(async () => {
  if (directory) await removeTemporaryDirectory(directory);
  directory = '';
});

async function makeGate(now: () => number, publicKey: string | null = publicKeyBase64) {
  directory = directory || (await mkdtemp(path.join(os.tmpdir(), 'wishly-entitlement-')));
  return new EntitlementGate({
    publicKeyBase64: publicKey,
    stateFile: path.join(directory, 'entitlement.json'),
    now
  });
}

describe('entitlement gate', () => {
  it('is unenforced and always entitled without a public key', async () => {
    const gate = await makeGate(() => Date.now(), null);
    expect(gate.enforced).toBe(false);
    expect(gate.status()).toMatchObject({
      enforced: false,
      entitled: true,
      reason: 'not-enforced'
    });
  });

  it('reports missing entitlement before any token is accepted', async () => {
    const gate = await makeGate(() => Date.now());
    expect(gate.enforced).toBe(true);
    expect(gate.status()).toMatchObject({ enforced: true, entitled: false, reason: 'missing' });
  });

  it('accepts a validly signed token and persists it across restarts', async () => {
    const now = Date.parse('2026-07-29T12:00:00Z');
    const gate = await makeGate(() => now);
    const status = await gate.acceptToken(issueToken(validPayload(now)), gate.identityRevision());
    expect(status).toMatchObject({ entitled: true, reason: 'active' });

    const persisted = JSON.parse(
      await readFile(path.join(directory, 'entitlement.json'), 'utf8')
    ) as { sub: string };
    expect(persisted.sub).toBe('user-1');

    const restarted = await makeGate(() => now);
    await restarted.load();
    expect(restarted.status()).toMatchObject({ entitled: true, reason: 'active' });
  });

  it('keeps working through the offline grace window, then expires', async () => {
    let now = Date.parse('2026-07-29T12:00:00Z');
    const gate = await makeGate(() => now);
    await gate.acceptToken(issueToken(validPayload(now)), gate.identityRevision());

    now += 13 * 3600 * 1000; // past the 12h token, inside the grace window
    expect(gate.status()).toMatchObject({ entitled: true, reason: 'grace' });

    now += ENTITLEMENT_OFFLINE_GRACE_MS;
    expect(gate.status()).toMatchObject({ entitled: false, reason: 'expired' });
  });

  it('rejects tampered, foreign-key, expired, and future-dated tokens', async () => {
    const now = Date.parse('2026-07-29T12:00:00Z');
    const gate = await makeGate(() => now);

    const token = issueToken(validPayload(now));
    const [prefix, , signature] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...validPayload(now), plan: 'team' }),
      'utf8'
    ).toString('base64url');
    await expect(
      gate.acceptToken(`${prefix}.${forgedPayload}.${signature}`, gate.identityRevision())
    ).rejects.toThrow('ENTITLEMENT_TOKEN_INVALID');

    const foreignKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    await expect(
      gate.acceptToken(issueToken(validPayload(now), foreignKey), gate.identityRevision())
    ).rejects.toThrow('ENTITLEMENT_TOKEN_INVALID');

    const expired = validPayload(now - 24 * 3600 * 1000, 3600);
    await expect(gate.acceptToken(issueToken(expired), gate.identityRevision())).rejects.toThrow(
      'ENTITLEMENT_TOKEN_INVALID'
    );

    const future = validPayload(now + 3600 * 1000);
    await expect(gate.acceptToken(issueToken(future), gate.identityRevision())).rejects.toThrow(
      'ENTITLEMENT_TOKEN_INVALID'
    );

    expect(gate.status()).toMatchObject({ entitled: false, reason: 'missing' });
  });

  it('never downgrades to an older token', async () => {
    const now = Date.parse('2026-07-29T12:00:00Z');
    const gate = await makeGate(() => now);
    const longLived = await gate.acceptToken(
      issueToken(validPayload(now)),
      gate.identityRevision()
    );
    const shorter = await gate.acceptToken(
      issueToken(validPayload(now, 3600)),
      gate.identityRevision()
    );
    expect(shorter.graceUntil).toBe(longLived.graceUntil);
  });

  it('records the newly selected verified account even when its token expires sooner', async () => {
    const now = Date.now();
    const gate = await makeGate(() => now);
    await gate.acceptToken(
      issueToken({ ...validPayload(now), sub: 'account-a' }),
      gate.identityRevision()
    );
    const selected = await gate.acceptToken(
      issueToken({ ...validPayload(now, 3600), sub: 'account-b' }),
      gate.identityRevision()
    );
    expect(selected.graceUntil).toBe(
      new Date(validPayload(now, 3600).exp * 1000 + ENTITLEMENT_OFFLINE_GRACE_MS).toISOString()
    );
    const stored = JSON.parse(await readFile(path.join(directory, 'entitlement.json'), 'utf8'));
    expect(stored.sub).toBe('account-b');
  });

  it('restores only signed identity during offline grace and clears it after grace expires', async () => {
    let now = Date.parse('2026-07-29T12:00:00Z');
    const gate = await makeGate(() => now);
    expect(gate.currentActorId()).toBeNull();
    await gate.acceptToken(issueToken(validPayload(now)), gate.identityRevision());
    now += 13 * 3600 * 1000;
    const restarted = await makeGate(() => now);
    await restarted.load();
    expect(restarted.currentActorId()).toBe('user-1');
    now += ENTITLEMENT_OFFLINE_GRACE_MS;
    expect(restarted.currentActorId()).toBeNull();
  });
  it('keeps legacy entitlement compatibility but never trusts unsigned identity', async () => {
    const now = Date.parse('2026-07-29T12:00:00Z');
    const gate = await makeGate(() => now);
    await writeFile(path.join(directory, 'entitlement.json'), JSON.stringify(validPayload(now)));
    await gate.load();
    expect(gate.status().entitled).toBe(true);
    expect(gate.currentActorId()).toBeNull();
    await gate.acceptToken(issueToken(validPayload(now)), gate.identityRevision());
    expect(gate.currentActorId()).toBe('user-1');
    const restarted = await makeGate(() => now);
    await restarted.load();
    expect(restarted.currentActorId()).toBe('user-1');
  });
  it('uses signed claims rather than edited cached account and expiry fields', async () => {
    const now = Date.parse('2026-07-29T12:00:00Z');
    const gate = await makeGate(() => now);
    await gate.acceptToken(issueToken(validPayload(now)), gate.identityRevision());
    const file = path.join(directory, 'entitlement.json');
    const raw = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...raw, sub: 'forged-account', exp: raw.exp + 864000 }));
    const restarted = await makeGate(() => now);
    await restarted.load();
    expect(restarted.currentActorId()).toBe('user-1');
    expect(restarted.status().graceUntil).toBe(
      new Date(validPayload(now).exp * 1000 + ENTITLEMENT_OFFLINE_GRACE_MS).toISOString()
    );
  });
  it('does not fall back to unsigned identity when a cached token has an invalid signature', async () => {
    const now = Date.parse('2026-07-29T12:00:00Z');
    const gate = await makeGate(() => now);
    const foreignKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    await writeFile(
      path.join(directory, 'entitlement.json'),
      JSON.stringify({ ...validPayload(now), token: issueToken(validPayload(now), foreignKey) })
    );
    await gate.load();
    expect(gate.currentActorId()).toBeNull();
    expect(gate.status().entitled).toBe(false);
  });
  it('rejects a stale simultaneous identity and permits a fresh explicit publication', async () => {
    const now = Date.parse('2026-07-29T12:00:00Z');
    const gate = await makeGate(() => now);
    const captured = gate.identityRevision();
    const results = await Promise.allSettled([
      gate.acceptToken(issueToken({ ...validPayload(now), sub: 'account-a' }), captured),
      gate.acceptToken(issueToken({ ...validPayload(now), sub: 'account-b' }), captured)
    ]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    await gate.acceptToken(
      issueToken({ ...validPayload(now), sub: 'account-b' }),
      gate.identityRevision()
    );
    expect(gate.currentActorId()).toBe('account-b');
    const file = path.join(directory, 'entitlement.json');
    // Windows user-profile ACLs require separate native acceptance; mode bits are POSIX evidence.
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o077).toBe(0);
    const restarted = await makeGate(() => now);
    await restarted.load();
    expect(restarted.currentActorId()).toBe('account-b');
  });
  it('does not publish a new identity when its private cache cannot be committed', async () => {
    const now = Date.parse('2026-07-29T12:00:00Z');
    const gate = await makeGate(() => now);
    await mkdir(path.join(directory, 'entitlement.json'));
    await expect(
      gate.acceptToken(issueToken(validPayload(now)), gate.identityRevision())
    ).rejects.toThrow();
    expect(gate.currentActorId()).toBeNull();
    expect(gate.status().entitled).toBe(false);
  });
  it('continues serialized updates after an invalid token is refused', async () => {
    const now = Date.parse('2026-07-29T12:00:00Z');
    const gate = await makeGate(() => now);
    const results = await Promise.allSettled([
      gate.acceptToken('invalid', gate.identityRevision()),
      gate.acceptToken(issueToken(validPayload(now)), gate.identityRevision())
    ]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'fulfilled']);
    expect(gate.currentActorId()).toBe('user-1');
  });

  it('refuses an oversized cached identity even when it contains a valid token', async () => {
    const now = Date.parse('2026-07-29T12:00:00Z');
    const gate = await makeGate(() => now);
    await writeFile(
      path.join(directory, 'entitlement.json'),
      JSON.stringify({
        ...validPayload(now),
        token: issueToken(validPayload(now)),
        padding: 'x'.repeat(20000)
      })
    );
    await gate.load();
    expect(gate.currentActorId()).toBeNull();
    expect(gate.status().entitled).toBe(false);
  });

  it('prepares the old actor transition before publishing or caching the next actor', async () => {
    const now = Date.parse('2026-07-29T12:00:00Z');
    const gate = await makeGate(() => now);
    await gate.acceptToken(
      issueToken({ ...validPayload(now), sub: 'account-a' }),
      gate.identityRevision()
    );
    let calls = 0;
    gate.onBeforeActorChange(async actor => {
      calls++;
      expect(actor).toBe('account-b');
      expect(gate.currentActorId()).toBe('account-a');
      expect(JSON.parse(await readFile(path.join(directory, 'entitlement.json'), 'utf8')).sub).toBe(
        'account-a'
      );
    });
    await gate.acceptToken(
      issueToken({ ...validPayload(now), sub: 'account-b' }),
      gate.identityRevision()
    );
    expect(calls).toBe(1);
    expect(gate.currentActorId()).toBe('account-b');
  });
  it('keeps the prior actor when durable transition preparation fails', async () => {
    const now = Date.parse('2026-07-29T12:00:00Z');
    const gate = await makeGate(() => now);
    await gate.acceptToken(
      issueToken({ ...validPayload(now), sub: 'account-a' }),
      gate.identityRevision()
    );
    gate.onBeforeActorChange(async () => {
      throw new Error('SYNTHETIC_JOURNAL_FAILURE');
    });
    await expect(
      gate.acceptToken(
        issueToken({ ...validPayload(now), sub: 'account-b' }),
        gate.identityRevision()
      )
    ).rejects.toThrow('SYNTHETIC_JOURNAL_FAILURE');
    expect(gate.currentActorId()).toBe('account-a');
    const restarted = await makeGate(() => now);
    await restarted.load();
    expect(restarted.currentActorId()).toBe('account-a');
  });

  it('durably clears only the signed actor requested by logout before restart', async () => {
    const now = Date.parse('2026-07-29T12:00:00Z');
    const gate = await makeGate(() => now);
    await gate.acceptToken(
      issueToken({ ...validPayload(now), sub: 'account-a' }),
      gate.identityRevision()
    );
    const prepared: (string | null)[] = [];
    gate.onBeforeActorChange(async actor => {
      prepared.push(actor);
    });
    expect(await gate.clearActor('account-b')).toBe(false);
    expect(gate.currentActorId()).toBe('account-a');
    expect(prepared).toEqual([]);
    expect(await gate.clearActor('account-a')).toBe(true);
    expect(prepared).toEqual([null]);
    expect(gate.currentActorId()).toBeNull();
    expect(gate.status().entitled).toBe(false);
    const restarted = await makeGate(() => now);
    await restarted.load();
    expect(restarted.currentActorId()).toBeNull();
    expect(restarted.status().entitled).toBe(false);
  });

  it('serializes stale logout after a new account without clearing the new actor', async () => {
    const now = Date.parse('2026-07-29T12:00:00Z');
    const gate = await makeGate(() => now);
    await gate.acceptToken(
      issueToken({ ...validPayload(now), sub: 'account-a' }),
      gate.identityRevision()
    );
    const next = gate.acceptToken(
      issueToken({ ...validPayload(now), sub: 'account-b' }),
      gate.identityRevision()
    );
    const logout = gate.clearActor('account-a');
    await next;
    expect(await logout).toBe(false);
    expect(gate.currentActorId()).toBe('account-b');
  });

  it('does not clear identity when durable logout preparation fails', async () => {
    const now = Date.parse('2026-07-29T12:00:00Z');
    const gate = await makeGate(() => now);
    await gate.acceptToken(issueToken(validPayload(now)), gate.identityRevision());
    gate.onBeforeActorChange(async () => {
      throw new Error('SYNTHETIC_JOURNAL_FAILURE');
    });
    await expect(gate.clearActor('user-1')).rejects.toThrow('SYNTHETIC_JOURNAL_FAILURE');
    expect(gate.currentActorId()).toBe('user-1');
    const restarted = await makeGate(() => now);
    await restarted.load();
    expect(restarted.currentActorId()).toBe('user-1');
  });

  it('can retire a verified stored subject after its entitlement grace expires', async () => {
    let now = Date.parse('2026-07-29T12:00:00Z');
    const gate = await makeGate(() => now);
    await gate.acceptToken(issueToken(validPayload(now, 60)), gate.identityRevision());
    now += ENTITLEMENT_OFFLINE_GRACE_MS + 61_000;
    expect(gate.currentActorId()).toBeNull();
    expect(gate.status().reason).toBe('expired');
    const prepared: (string | null)[] = [];
    gate.onBeforeActorChange(async actor => {
      prepared.push(actor);
    });
    expect(await gate.clearActor('user-1')).toBe(true);
    expect(prepared).toEqual([null]);
    expect(gate.status().reason).toBe('missing');
  });

  it('does not create a verified actor in an unenforced development gate', async () => {
    const gate = await makeGate(() => Date.now(), null);
    expect(gate.currentActorId()).toBeNull();
  });

  it('treats an unparseable embedded key as unenforced instead of bricking', async () => {
    const gate = await makeGate(() => Date.now(), 'not-a-key');
    expect(gate.enforced).toBe(false);
    expect(gate.status()).toMatchObject({ enforced: false, entitled: true });
  });
});
