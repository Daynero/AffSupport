import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { startMinimalAgent, type MinimalAgent } from './support/minimal-agent.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const actorA = '11111111-1111-4111-8111-111111111111';
const actorB = '22222222-2222-4222-8222-222222222222';
let agent: MinimalAgent | null = null;
afterEach(async () => {
  await agent?.stop();
  agent = null;
});
function token(sub: string) {
  const iat = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ v: 1, sub, plan: 'free', iat, exp: iat + 3600 })
  ).toString('base64url');
  const message = `wat1.${payload}`;
  return `${message}.${sign('sha256', Buffer.from(message), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
async function start() {
  agent = await startMinimalAgent({
    entitlementPublicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  });
}
function post(
  url: string,
  payload: Record<string, unknown>,
  paired = true,
  origin = 'http://127.0.0.1:5173'
) {
  return agent!.app.inject({
    method: 'POST',
    url,
    payload,
    headers: {
      host: '127.0.0.1:43120',
      origin,
      ...(paired ? { 'x-session-token': agent!.token } : {})
    }
  });
}
describe('paired actor-scoped entitlement logout', () => {
  it('advertises the installation scope only through paired health', async () => {
    agent = await startMinimalAgent({ recoveryInstallationId: actorA });
    const paired = await agent.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '127.0.0.1:43120', 'x-session-token': agent.token }
    });
    expect(paired.json().recoveryInstallationId).toBe(actorA);
    expect(paired.json().capabilities).not.toContain('team-background-recovery-actor-bound');
    const unpaired = await agent.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '127.0.0.1:43120' }
    });
    expect(unpaired.statusCode).toBe(401);
    const publicHealth = await agent.app.inject({
      method: 'GET',
      url: '/health',
      headers: { host: '127.0.0.1:43120' }
    });
    expect(publicHealth.json().recoveryInstallationId).toBeUndefined();
    expect(publicHealth.json().entitlementRevision).toBeUndefined();
  });

  it('allows cleanup without a current entitlement but still requires pairing and an allowed origin', async () => {
    await start();
    expect((await post('/api/entitlement/logout', { actorId: actorA }, false)).statusCode).toBe(
      401
    );
    expect(
      (await post('/api/entitlement/logout', { actorId: actorA }, true, 'https://foreign.invalid'))
        .statusCode
    ).toBe(403);
    const response = await post('/api/entitlement/logout', { actorId: actorA });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ cleared: false });
  });
  it('preserves a new actor on stale logout and clears the matching actor', async () => {
    await start();
    const snapshot = await agent!.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '127.0.0.1:43120', 'x-session-token': agent!.token }
    });
    expect(
      (
        await post('/api/entitlement', {
          token: token(actorB),
          revision: snapshot.json().entitlementRevision
        })
      ).statusCode
    ).toBe(200);
    expect((await post('/api/entitlement/logout', { actorId: actorA })).json()).toEqual({
      cleared: false
    });
    const before = await agent!.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '127.0.0.1:43120', 'x-session-token': agent!.token }
    });
    expect(before.json().entitlement.entitled).toBe(true);
    expect((await post('/api/entitlement/logout', { actorId: actorB })).json()).toEqual({
      cleared: true
    });
    const after = await agent!.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '127.0.0.1:43120', 'x-session-token': agent!.token }
    });
    expect(after.json().entitlement.reason).toBe('missing');
  });
  it('rejects malformed actor selectors without accepting authority from other hints', async () => {
    await start();
    expect(
      (await post('/api/entitlement/logout', { actorId: {}, token: token(actorA) })).statusCode
    ).toBe(400);
  });
});
