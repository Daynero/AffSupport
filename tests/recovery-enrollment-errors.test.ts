import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { registerRecoveryRoutes } from '../apps/agent/src/team-bridge/recovery-enrollment';
import type { TeamRecoveryWorker } from '../apps/agent/src/team-bridge/recovery-worker';
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
it.each(['AGENT_UPDATE_REQUIRED', 'PERMISSION_DENIED', 'INVALID_RESPONSE'])(
  'preserves the closed setup failure %s at the native route',
  async code => {
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
  }
);
it('does not expose an unrecognized upstream error or credential', async () => {
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
  expect(response.json()).toEqual({ error: 'AUTH_REQUIRED' });
});
