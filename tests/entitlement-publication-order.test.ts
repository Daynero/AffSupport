import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { ENTITLEMENT_PUBLICATION_REJECTIONS } from '../packages/shared/src/types';
import { startMinimalAgent, type MinimalAgent } from './support/minimal-agent';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const active = vi.hoisted(() => ({ agent: null as MinimalAgent | null }));
vi.mock('../apps/web/src/api/client', () => ({
  requestBody: async (url: string, body: unknown) => {
    const result = await active.agent!.app.inject({
      method: 'POST',
      url,
      payload: body as Record<string, unknown>,
      headers: {
        host: '127.0.0.1:43120',
        origin: 'http://127.0.0.1:5173',
        'x-session-token': active.agent!.token
      }
    });
    if (result.statusCode !== 200) throw new Error('NATIVE_REQUEST_REFUSED');
    return result.json();
  }
}));
afterEach(async () => {
  await active.agent?.stop();
  active.agent = null;
  vi.unstubAllGlobals();
});
function token(sub: string) {
  const iat = Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({ v: 1, sub, plan: 'free', iat, exp: iat + 3600 })
  ).toString('base64url');
  const message = `wat1.${body}`;
  return `${message}.${sign('sha256', Buffer.from(message), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
async function start() {
  active.agent = await startMinimalAgent({
    entitlementPublicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  });
}
async function health() {
  return (
    await active.agent!.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '127.0.0.1:43120', 'x-session-token': active.agent!.token }
    })
  ).json();
}
async function post(actor: string, revision?: string) {
  return active.agent!.app.inject({
    method: 'POST',
    url: '/api/entitlement',
    payload: { token: token(actor), ...(revision ? { revision } : {}) },
    headers: {
      host: '127.0.0.1:43120',
      origin: 'http://127.0.0.1:5173',
      'x-session-token': active.agent!.token
    }
  });
}
async function logout(actorId: string) {
  return active.agent!.app.inject({
    method: 'POST',
    url: '/api/entitlement/logout',
    payload: { actorId },
    headers: {
      host: '127.0.0.1:43120',
      origin: 'http://127.0.0.1:5173',
      'x-session-token': active.agent!.token
    }
  });
}
async function revision() {
  return (await health()).entitlementRevision ?? randomUUID();
}

describe('native identity publication ordering across callers', () => {
  it('refuses enforced publication without the paired native revision', async () => {
    await start();
    expect((await post(A)).statusCode).toBe(409);
    expect((await health()).entitlement.entitled).toBe(false);
    const rejection = active
      .agent!.diagnostics.since(0, 200)
      .find(r => r.code === 'identity_publication_rejected');
    expect(rejection?.props).toEqual({ reason: 'missing_revision' });
    expect(ENTITLEMENT_PUBLICATION_REJECTIONS).toContain(rejection!.props!.reason);
  });
  it('does not accept a publication captured before confirmed logout', async () => {
    await start();
    expect((await post(A, await revision())).statusCode).toBe(200);
    const old = await revision();
    expect((await logout(A)).json()).toEqual({ cleared: true });
    expect((await post(A, old)).statusCode).toBe(409);
    const rejected = active
      .agent!.diagnostics.since(0, 200)
      .filter(r => r.code === 'identity_publication_rejected');
    expect(rejected.at(-1)?.props).toEqual({ reason: 'stale_revision' });
    expect(JSON.stringify(rejected)).not.toContain(old);
    expect((await health()).entitlement.entitled).toBe(false);
  });
  it('preserves B when A arrives late after B was published', async () => {
    await start();
    await post(A, await revision());
    const old = await revision();
    expect((await post(B, old)).statusCode).toBe(200);
    expect((await post(A, old)).statusCode).toBe(409);
    expect((await logout(B)).json()).toEqual({ cleared: true });
  });
  it('fences outstanding A publication even when its logout finds B current', async () => {
    await start();
    await post(B, await revision());
    const old = await revision();
    expect((await logout(A)).json()).toEqual({ cleared: false });
    expect((await post(A, old)).statusCode).toBe(409);
    expect((await logout(B)).json()).toEqual({ cleared: true });
  });
  it('refuses a revision from a previous native instance', async () => {
    await start();
    const old = await revision();
    await active.agent!.stop();
    await start();
    expect((await post(A, old)).statusCode).toBe(409);
  });
  it('allows concurrent renewals for the same current actor', async () => {
    await start();
    await post(A, await revision());
    const same = await revision();
    const responses = await Promise.all([post(A, same), post(A, same)]);
    expect(responses.map(r => r.statusCode)).toEqual([200, 200]);
    expect((await health()).entitlementRevision).toBe(same);
  });
  it('does not resurrect A after another independent browser module confirmed logout', async () => {
    await start();
    await post(A, await revision());
    const old = await revision();
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      get length() {
        return values.size;
      },
      key: (i: number) => [...values.keys()][i] ?? null,
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => values.set(k, v),
      removeItem: (k: string) => values.delete(k)
    });
    vi.resetModules();
    const first = await import('../apps/web/src/api/entitlement-retirement');
    vi.resetModules();
    const second = await import('../apps/web/src/api/entitlement-retirement');
    let send!: () => void;
    let sent!: () => void;
    const delayed = new Promise<void>(resolve => {
      send = resolve;
    });
    const started = new Promise<void>(resolve => {
      sent = resolve;
    });
    const publication = first.publishAgentIdentity(first.agentIdentityRevision(), async () => {
      sent();
      await delayed;
      return (await post(A, old)).statusCode;
    });
    const outcome = publication.then(
      status => ({ status }),
      () => ({ status: 409 })
    );
    await started;
    expect(await second.retireAgentActor(A)).toBe('confirmed');
    send();
    await outcome;
    expect((await health()).entitlement.entitled).toBe(false);
  });
});
