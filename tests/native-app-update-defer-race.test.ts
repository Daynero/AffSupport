import { createHash, generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeAppUpdateService } from '../apps/agent/src/update/service';
import { AgentUpdateCoordinator } from '../apps/agent/src/update/coordinator';
import { ChannelHub } from '../apps/agent/src/server/sse';
import { DiagnosticsLog } from '../apps/agent/src/server/diagnostics-log';
import { PowerGovernor } from '../apps/agent/src/power/governor';
import {
  PRODUCTION_SITE_ORIGIN,
  releaseManifestSigningPayload
} from '../packages/shared/src/release';
import { nativeSnapshot } from './support/native-app-updates';
const bridge = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../apps/agent/src/update/native-bridge', () => ({
  NativeUpdateBridge: class {
    request(...args: unknown[]) {
      return bridge.request(...args);
    }
  }
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
describe('defer at the final candidate freshness boundary', () => {
  it('honors a native-confirmed defer while the network read is pending', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'soty-defer-race-'));
    const power = new PowerGovernor();
    const resume = vi.fn();
    const barrier = new AgentUpdateCoordinator(
      { busy: () => false, flush: async () => {}, pauseAdmission: () => resume },
      ms => ms
    );
    let state = nativeSnapshot();
    state.candidate!.archive.sha256 = createHash('sha256').update('hello').digest('hex');
    state.candidateId = `${state.candidate!.target}:${state.candidate!.archive.sha256}`;
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const manifest = {
      schemaVersion: 1,
      channel: 'stable',
      version: '9.0.0',
      buildNumber: '999',
      buildId: '9.0.0+999',
      nativeUpdates: { 'macos-arm64': state.candidate },
      signature: ''
    };
    manifest.signature = sign('sha256', Buffer.from(releaseManifestSigningPayload(manifest)), {
      key: keys.privateKey,
      dsaEncoding: 'ieee-p1363'
    }).toString('base64url');
    let freshReached!: () => void;
    const reached = new Promise<void>(done => {
      freshReached = done;
    });
    let finishFresh!: (response: Response) => void;
    const pendingFresh = new Promise<Response>(done => {
      finishFresh = done;
    });
    let checks = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        checks++;
        if (checks === 1) return Promise.resolve(new Response(JSON.stringify(manifest)));
        freshReached();
        return pendingFresh;
      })
    );
    bridge.request.mockImplementation(
      async (action: string, payload: Record<string, unknown> = {}) => {
        if (action === 'hello')
          return {
            state,
            manifestURL: `${PRODUCTION_SITE_ORIGIN}/.well-known/wishly/stable.json`,
            publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
            channel: 'stable',
            target: 'macos-arm64'
          };
        if (action === 'receipts') return { records: [] };
        if (action === 'pending') return { state, installerReady: false, handoffStarted: false };
        if (action === 'command') {
          state = {
            ...state,
            revision: state.revision + 1,
            stage: payload.action === 'accept' ? 'consented' : 'deferred'
          };
          return state;
        }
        if (action === 'draining' || action === 'drained') {
          state = {
            ...state,
            revision: state.revision + 1,
            stage: action,
            lastProvenStage: action
          };
          return state;
        }
        return state;
      }
    );
    const service = new NativeAppUpdateService({
      host: {
        socketPath: path.join(directory, 'host.sock'),
        receiptDirectory: directory,
        token: 'private',
        launcherPid: 1,
        bundleRoot: '/Soty.app'
      },
      barrier,
      power,
      hub: new ChannelHub(),
      origins: new Set(),
      bootId: '10000000-0000-4000-8000-000000000010',
      buildId: '8.0.0+998',
      sourceRevision: 'b'.repeat(40),
      toolsReady: () => true,
      diagnostics: new DiagnosticsLog(),
      exitForUpdate: async () => {
        throw new Error('must not exit');
      }
    });
    try {
      await service.start();
      await service.command('accept', {
        schemaVersion: 1,
        idempotencyKey: randomUUID(),
        expectedRevision: state.revision,
        candidateId: state.candidateId
      });
      await reached;
      const deferred = await service.command('defer', {
        schemaVersion: 1,
        idempotencyKey: randomUUID(),
        expectedRevision: state.revision,
        candidateId: state.candidateId
      });
      expect(deferred.stage).toBe('deferred');
      expect(barrier.accepting()).toBe(true);
      expect(resume).toHaveBeenCalledOnce();
      finishFresh(new Response(JSON.stringify(manifest)));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(bridge.request.mock.calls.some(call => call[0] === 'install')).toBe(false);
    } finally {
      await service.close();
      await power.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
