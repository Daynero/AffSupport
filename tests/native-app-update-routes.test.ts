import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { NativeAppUpdateService } from '../apps/agent/src/update/service';
import { AgentUpdateCoordinator } from '../apps/agent/src/update/coordinator';
import { ChannelHub } from '../apps/agent/src/server/sse';
import { PowerGovernor } from '../apps/agent/src/power/governor';
import { DiagnosticsLog } from '../apps/agent/src/server/diagnostics-log';
describe('native update HTTP boundary', () => {
  it('refuses unsupported hosts and browser-supplied authority before invoking native IPC', async () => {
    const barrier = new AgentUpdateCoordinator(
      { busy: () => false, flush: async () => {}, pauseAdmission: () => () => {} },
      ms => ms
    );
    const power = new PowerGovernor();
    const service = new NativeAppUpdateService({
      host: {
        socketPath: '/does-not-exist',
        receiptDirectory: '/does-not-exist',
        token: 'private',
        launcherPid: 1,
        bundleRoot: '/Soty.app'
      },
      barrier,
      power,
      origins: new Set(),
      hub: new ChannelHub(),
      bootId: 'boot',
      buildId: 'build',
      sourceRevision: 'source',
      toolsReady: () => true,
      diagnostics: new DiagnosticsLog({ instanceId: '10000000-0000-4000-8000-000000000001' }),
      exitForUpdate: async () => {}
    });
    const app = Fastify();
    service.register(app);
    try {
      expect((await app.inject({ url: '/api/app-update' })).statusCode).toBe(501);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/app-update/accept',
            payload: { url: 'https://evil.test', expectedRevision: 1 }
          })
        ).statusCode
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/app-update/accept',
            payload: {
              schemaVersion: 1,
              idempotencyKey: '10000000-0000-4000-8000-000000000001',
              expectedRevision: 0,
              candidateId: null
            }
          })
        ).statusCode
      ).toBe(501);
    } finally {
      await service.close();
      await power.shutdown();
      await app.close();
    }
  });
});
