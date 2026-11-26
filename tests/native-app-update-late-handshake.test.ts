import { removeTemporaryDirectory } from './support/temp-dir';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

/**
 * 1.7.0 qualification, 2026-11-26: a slow (Rosetta) host answered the handshake late, and
 * after an acknowledged update the next candidate waited for the hourly check.
 */
const bridge = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../apps/agent/src/update/native-bridge', () => ({
  NativeUpdateBridge: class {
    request(...args: unknown[]) {
      return bridge.request(...args);
    }
  }
}));
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  await Promise.all(roots.splice(0).map(root => removeTemporaryDirectory(root)));
});

async function fixture(stage: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soty-late-handshake-'));
  roots.push(directory);
  let state = { ...nativeSnapshot(), stage } as ReturnType<typeof nativeSnapshot>;
  if (stage === 'native_ready') state = { ...state, nativeSuccess: true };
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(manifest)))
  );
  const calls: string[] = [];
  let helloFailures = 0;
  bridge.request.mockImplementation(
    async (action: string, payload: Record<string, unknown> = {}) => {
      calls.push(action);
      if (action === 'hello') {
        if (helloFailures-- > 0) throw new Error('APP_UPDATE_NATIVE_UNAVAILABLE');
        return {
          state,
          manifestURL: `${PRODUCTION_SITE_ORIGIN}/.well-known/wishly/stable.json`,
          publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
          channel: 'stable',
          target: 'macos-arm64'
        };
      }
      if (action === 'receipts') return { records: [] };
      if (action === 'pending') return { state, installerReady: false, handoffStarted: false };
      if (action === 'command' && payload.action === 'ack-visible')
        state = { ...state, revision: state.revision + 1, stage: 'ui_visible', uiSuccess: true };
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
    barrier: new AgentUpdateCoordinator(
      { busy: () => false, flush: async () => {}, pauseAdmission: () => () => {} },
      ms => ms
    ),
    power: new PowerGovernor(),
    hub: new ChannelHub(),
    origins: new Set(),
    bootId: '10000000-0000-4000-8000-000000000010',
    buildId: '8.0.0+998',
    sourceRevision: 'b'.repeat(40),
    toolsReady: () => true,
    diagnostics: new DiagnosticsLog(),
    exitForUpdate: async () => {}
  });
  return {
    service,
    calls,
    failHello: (count: number) => {
      helloFailures = count;
    },
    revision: () => state.revision,
    candidateId: () => state.candidateId
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

describe('native update handshake and successor checks', () => {
  it('a host that answers late still gets its startup check', async () => {
    const f = await fixture('idle');
    f.failHello(1);
    await expect(f.service.start()).rejects.toThrow();
    f.service.afterListening();
    await settle();
    expect(f.calls).not.toContain('offer');
    await f.service.start();
    await settle();
    expect(f.calls.filter(call => call === 'offer')).toHaveLength(1);
    f.service.afterListening();
    await settle();
    // Idempotent: no second interval, no duplicate startup check.
    expect(f.calls.filter(call => call === 'offer')).toHaveLength(1);
    await f.service.close();
  });

  it('looks for the next update right after the result is acknowledged', async () => {
    const f = await fixture('native_ready');
    await f.service.start();
    f.service.afterListening();
    await settle();
    expect(f.calls).not.toContain('offer');
    await f.service.command('ack-visible', {
      schemaVersion: 1,
      idempotencyKey: randomUUID(),
      expectedRevision: f.revision(),
      candidateId: f.candidateId()
    });
    await settle();
    expect(f.calls).toContain('offer');
    await f.service.close();
  });

  it('a start after an acknowledged update checks for a successor', async () => {
    const f = await fixture('ui_visible');
    await f.service.start();
    f.service.afterListening();
    await settle();
    expect(f.calls).toContain('offer');
    await f.service.close();
  });
});
