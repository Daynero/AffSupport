import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerRecoveryRoutes } from '../apps/agent/src/team-bridge/recovery-enrollment';
import type { TeamRecoveryWorker } from '../apps/agent/src/team-bridge/recovery-worker';
const hasCapability = vi.hoisted(() => vi.fn(() => true));
vi.mock('../apps/agent/src/server/capabilities', () => ({ hasCapability }));
beforeEach(() => {
  hasCapability.mockReturnValue(true);
});
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
it.each([
  'AGENT_UPDATE_REQUIRED',
  'PERMISSION_DENIED',
  'INVALID_RESPONSE',
  'AUTH_REQUIRED',
  'DRIVE_UNAVAILABLE',
  'RATE_LIMITED',
  'UPDATE_PENDING',
  'EXPIRED'
])('preserves the closed setup failure %s at the native route', async code => {
  const app = Fastify();
  apps.push(app);
  registerRecoveryRoutes(
    app,
    {
      enroll: vi.fn(async () => {
        throw new Error(code);
      })
    } as unknown as TeamRecoveryWorker,
    () => true
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/team/recovery/confirm',
    payload: { enrollmentId: 'synthetic', challengeId: 'synthetic' }
  });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ error: code });
});
const team = 'cf560000-0000-4000-8000-000000000001';
function routes() {
  const app = Fastify();
  apps.push(app);
  const worker = {
    begin: vi.fn(() => ({ enrollmentId: 'manual' })),
    beginAutomatic: vi.fn(async () => ({ enrollmentId: 'automatic' })),
    enroll: vi.fn(async () => ({ enabled: true })),
    retry: vi.fn(async () => ({ retried: true })),
    status: vi.fn(() => ({ enabled: true })),
    remove: vi.fn(async () => ({ removed: true }))
  };
  const accepting = vi.fn(() => true);
  registerRecoveryRoutes(app, worker as unknown as TeamRecoveryWorker, accepting);
  return { app, worker, accepting };
}
it('keeps manual and automatic enrollment authority separate and returns confirmed worker results', async () => {
  const f = routes();
  const manual = await f.app.inject({
    method: 'POST',
    url: '/api/team/recovery/enroll',
    payload: { teamId: team, endpoint: 'https://synthetic.example/recovery' }
  });
  expect(manual.statusCode).toBe(200);
  expect(manual.json()).toEqual({ enrollmentId: 'manual' });
  expect(f.worker.begin).toHaveBeenCalledWith(team, 'https://synthetic.example/recovery');
  const automatic = await f.app.inject({
    method: 'POST',
    url: '/api/team/recovery/enroll',
    payload: {
      teamId: team,
      endpoint: 'https://synthetic.example/recovery',
      automatic: true,
      actorId: team
    }
  });
  expect(automatic.statusCode).toBe(200);
  expect(automatic.json()).toEqual({ enrollmentId: 'automatic' });
  expect(f.worker.beginAutomatic).toHaveBeenCalledWith(
    team,
    'https://synthetic.example/recovery',
    team
  );
  const confirmed = await f.app.inject({
    method: 'POST',
    url: '/api/team/recovery/confirm',
    payload: { enrollmentId: 'accepted', challengeId: 'challenge' }
  });
  expect(confirmed.json()).toEqual({ enabled: true });
  expect(f.worker.enroll).toHaveBeenCalledWith('accepted', 'challenge');
});
it.each(['/api/team/recovery/enroll', '/api/team/recovery/retry'])(
  'refuses %s before dispatch when unsupported or update admission is closed',
  async url => {
    const f = routes();
    hasCapability.mockReturnValue(false);
    let reply = await f.app.inject({
      method: 'POST',
      url,
      payload: { teamId: team, endpoint: 'https://synthetic.example/recovery' }
    });
    expect(reply.statusCode).toBe(501);
    expect(reply.json()).toEqual({ error: 'AGENT_REQUIRED' });
    hasCapability.mockReturnValue(true);
    f.accepting.mockReturnValue(false);
    reply = await f.app.inject({
      method: 'POST',
      url,
      payload: { teamId: team, endpoint: 'https://synthetic.example/recovery' }
    });
    expect(reply.statusCode).toBe(409);
    expect(reply.json()).toEqual({ error: 'UPDATE_PENDING' });
    expect(f.worker.begin).not.toHaveBeenCalled();
    expect(f.worker.beginAutomatic).not.toHaveBeenCalled();
    expect(f.worker.retry).not.toHaveBeenCalled();
  }
);
it.each([
  ['/api/team/recovery/enroll', []],
  ['/api/team/recovery/enroll', { teamId: team }],
  ['/api/team/recovery/enroll', { teamId: team, endpoint: 12 }],
  ['/api/team/recovery/enroll', { teamId: team, endpoint: 'endpoint', automatic: false }],
  ['/api/team/recovery/enroll', { teamId: team, endpoint: 'endpoint', automatic: true }],
  ['/api/team/recovery/confirm', { enrollmentId: 'id' }],
  ['/api/team/recovery/retry', { teamId: null }]
])('rejects invalid enrollment input at %s without dispatch', async (url, payload) => {
  const f = routes();
  const reply = await f.app.inject({ method: 'POST', url: String(url), payload });
  expect(reply.statusCode).toBe(400);
  expect(reply.json()).toEqual({ error: 'INVALID_INPUT' });
  for (const call of Object.values(f.worker)) expect(call).not.toHaveBeenCalled();
});
it.each(['PERMISSION_DENIED', 'private upstream failure'])(
  'sanitizes enrollment failure %s and never returns a false enrollment receipt',
  async message => {
    const f = routes();
    f.worker.beginAutomatic.mockRejectedValueOnce(new Error(message));
    const reply = await f.app.inject({
      method: 'POST',
      url: '/api/team/recovery/enroll',
      payload: {
        teamId: team,
        endpoint: 'https://synthetic.example/recovery',
        automatic: true,
        actorId: team
      }
    });
    expect(reply.statusCode).toBe(409);
    expect(reply.json()).toEqual({
      error: message === 'PERMISSION_DENIED' ? message : 'WRONG_STATE'
    });
  }
);
it('retries only the requested team and does not leak a failed worker result', async () => {
  const f = routes();
  const reply = await f.app.inject({
    method: 'POST',
    url: '/api/team/recovery/retry',
    payload: { teamId: team }
  });
  expect(reply.json()).toEqual({ retried: true });
  expect(f.worker.retry).toHaveBeenCalledWith(team);
  f.worker.retry.mockRejectedValueOnce(new Error('private failure'));
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/team/recovery/retry',
        payload: { teamId: team }
      })
    ).json()
  ).toEqual({ error: 'WRONG_STATE' });
});
it('validates status and removal identities before reaching the worker', async () => {
  const f = routes();
  for (const method of ['GET', 'DELETE'] as const) {
    const invalid = await f.app.inject({ method, url: '/api/team/recovery/invalid-id' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: 'INVALID_INPUT' });
  }
  expect(f.worker.status).not.toHaveBeenCalled();
  expect(f.worker.remove).not.toHaveBeenCalled();
  expect((await f.app.inject({ method: 'GET', url: `/api/team/recovery/${team}` })).json()).toEqual(
    { enabled: true }
  );
  expect(
    (await f.app.inject({ method: 'DELETE', url: `/api/team/recovery/${team}` })).json()
  ).toEqual({ removed: true });
  expect(f.worker.status).toHaveBeenCalledWith(team);
  expect(f.worker.remove).toHaveBeenCalledWith(team);
});
it('does not expose an unrecognized upstream error or misclassify local persistence failure as revoked authority', async () => {
  const app = Fastify();
  apps.push(app);
  registerRecoveryRoutes(
    app,
    {
      enroll: vi.fn(async () => {
        throw new Error('secret provider payload');
      })
    } as unknown as TeamRecoveryWorker,
    () => true
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/team/recovery/confirm',
    payload: { enrollmentId: 'synthetic', challengeId: 'synthetic' }
  });
  expect(response.json()).toEqual({ error: 'DRIVE_UNAVAILABLE' });
});
