import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
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
    const status = await gate.acceptToken(issueToken(validPayload(now)));
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
    await gate.acceptToken(issueToken(validPayload(now)));

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
    await expect(gate.acceptToken(`${prefix}.${forgedPayload}.${signature}`)).rejects.toThrow(
      'ENTITLEMENT_TOKEN_INVALID'
    );

    const foreignKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    await expect(gate.acceptToken(issueToken(validPayload(now), foreignKey))).rejects.toThrow(
      'ENTITLEMENT_TOKEN_INVALID'
    );

    const expired = validPayload(now - 24 * 3600 * 1000, 3600);
    await expect(gate.acceptToken(issueToken(expired))).rejects.toThrow(
      'ENTITLEMENT_TOKEN_INVALID'
    );

    const future = validPayload(now + 3600 * 1000);
    await expect(gate.acceptToken(issueToken(future))).rejects.toThrow('ENTITLEMENT_TOKEN_INVALID');

    expect(gate.status()).toMatchObject({ entitled: false, reason: 'missing' });
  });

  it('never downgrades to an older token', async () => {
    const now = Date.parse('2026-07-29T12:00:00Z');
    const gate = await makeGate(() => now);
    const longLived = await gate.acceptToken(issueToken(validPayload(now)));
    const shorter = await gate.acceptToken(issueToken(validPayload(now, 3600)));
    expect(shorter.graceUntil).toBe(longLived.graceUntil);
  });

  it('treats an unparseable embedded key as unenforced instead of bricking', async () => {
    const gate = await makeGate(() => Date.now(), 'not-a-key');
    expect(gate.enforced).toBe(false);
    expect(gate.status()).toMatchObject({ enforced: false, entitled: true });
  });
});
