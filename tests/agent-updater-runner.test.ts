import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESTITCH_DETECTOR_VERSION } from '@video-compressor/shared';
import {
  parseUpdaterCredential,
  UpdaterCredentialStore,
  type UpdaterCredential
} from '../apps/agent/src/team-bridge/updater-credential.js';
import { UpdaterRunner } from '../apps/agent/src/team-bridge/updater-runner.js';

/**
 * Feature 023, delivery 2: the desktop app as a space's re-stitching computer — where its secret
 * lives, when it asks for work, how a job runs through the process bridge, and how it stops.
 */

const credential: UpdaterCredential = {
  teamId: '23300000-0000-4000-8000-000000000001',
  deviceId: '23300000-0000-4000-8000-000000000002',
  secret: 'b'.repeat(64),
  cloudBaseUrl: 'https://project.supabase.co/functions/v1/drive-ops'
};

const grant = {
  ticket: 't'.repeat(40),
  purpose: 'process_input',
  expiresAt: 'x',
  maxRangeBytes: 1,
  maxUses: 1
};
const job = {
  jobId: '23300000-0000-4000-8000-000000000003',
  leaseToken: 'L'.repeat(43),
  operationId: '23300000-0000-4000-8000-000000000004',
  toolId: 'restitch',
  options: {
    defaults: { configured: true },
    prepared: { detectorVersion: RESTITCH_DETECTOR_VERSION, profile: {} }
  },
  sourceGrant: grant,
  finalizeGrant: { ...grant, purpose: 'finalize' }
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'soty-updater-'));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function setup(
  options: {
    claim?: unknown;
    claimStatus?: number;
    canWork?: boolean;
    heartbeatCancel?: boolean;
    process?: () => Promise<unknown>;
  } = {}
) {
  const store = new UpdaterCredentialStore(path.join(dir, 'device.json'));
  const calls: Array<{ route: string; body: Record<string, unknown>; secret: string | null }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const route = String(url).split('/updater/')[1]!;
    calls.push({
      route,
      body: JSON.parse(String(init?.body)),
      secret: new Headers(init?.headers).get('x-soty-device-secret')
    });
    if (route === 'claim') return json(options.claim ?? { job: null }, options.claimStatus ?? 200);
    if (route === 'heartbeat') return json({ cancel: options.heartbeatCancel ?? false });
    return json({ recorded: true });
  });
  const bridge = {
    process: vi.fn(
      options.process ??
        (async () => ({
          operationId: job.operationId,
          state: 'succeeded',
          materialId: 'm',
          reused: false,
          discovered: { detectorVersion: RESTITCH_DETECTOR_VERSION }
        }))
    ),
    cancel: vi.fn(() => true)
  };
  const runner = new UpdaterRunner({
    store,
    bridge: bridge as never,
    canWork: () => options.canWork ?? true,
    build: '1.2.0',
    contracts: { teamUpdaterRestitch: 1 },
    fetch: fetchImpl as unknown as typeof fetch,
    random: () => 0
  });
  return { store, runner, bridge, calls };
}

describe('the credential', () => {
  it('is stored readable by this user only and read back', async () => {
    const { store } = setup();
    await store.write(credential);
    if (process.platform !== 'win32') {
      expect((await stat(path.join(dir, 'device.json'))).mode & 0o777).toBe(0o600);
    }
    expect(await store.read()).toEqual(credential);
    await store.clear();
    expect(await store.read()).toBeNull();
  });

  it('refuses a foreign address, a short secret and a bad id', () => {
    expect(parseUpdaterCredential(credential)).toEqual(credential);
    expect(
      parseUpdaterCredential({
        ...credential,
        cloudBaseUrl: 'http://evil.test/functions/v1/drive-ops'
      })
    ).toBeNull();
    expect(
      parseUpdaterCredential({ ...credential, cloudBaseUrl: 'https://x.test/functions/v1/other' })
    ).toBeNull();
    expect(parseUpdaterCredential({ ...credential, secret: 'abc' })).toBeNull();
    expect(parseUpdaterCredential({ ...credential, deviceId: 'nope' })).toBeNull();
    expect(
      parseUpdaterCredential({
        ...credential,
        cloudBaseUrl: 'http://127.0.0.1:54321/functions/v1/drive-ops'
      })
    ).not.toBeNull();
  });
});

describe('asking for work', () => {
  it('does not ask when not enrolled or when the computer is busy', async () => {
    const idle = setup();
    await idle.runner.start();
    await idle.runner.tick();
    expect(idle.calls).toHaveLength(0);

    const busy = setup({ canWork: false });
    await busy.runner.enroll(credential);
    await busy.runner.tick();
    expect(busy.calls).toHaveLength(0);
    await busy.runner.shutdown();
  });

  it('claims with its secret, runs the job through the bridge, and reports what it learned', async () => {
    const { runner, bridge, calls } = setup({ claim: { job } });
    await runner.enroll(credential);
    await runner.tick();
    expect(calls[0]).toMatchObject({
      route: 'claim',
      secret: credential.secret,
      body: {
        deviceId: credential.deviceId,
        build: '1.2.0',
        toolContracts: { teamUpdaterRestitch: 1 }
      }
    });
    expect(bridge.process).toHaveBeenCalledWith({
      operationId: job.operationId,
      toolId: 'restitch',
      options: job.options,
      sourceGrant: job.sourceGrant,
      finalizeGrant: job.finalizeGrant,
      transferUrl: 'https://project.supabase.co/functions/v1/drive-transfer/range',
      cloudBaseUrl: credential.cloudBaseUrl
    });
    expect(calls.at(-1)).toMatchObject({
      route: 'complete',
      body: {
        deviceId: credential.deviceId,
        jobId: job.jobId,
        leaseToken: job.leaseToken,
        outcome: 'finalized',
        discovered: { detectorVersion: RESTITCH_DETECTOR_VERSION }
      }
    });
    expect(runner.busy()).toBe(false);
    await runner.shutdown();
  });

  it('drops a preparation from an older detector', async () => {
    const stale = { ...job, options: { ...job.options, prepared: { detectorVersion: 0 } } };
    const { runner, bridge } = setup({ claim: { job: stale } });
    await runner.enroll(credential);
    await runner.tick();
    expect(bridge.process).toHaveBeenCalledWith(
      expect.objectContaining({ options: { defaults: job.options.defaults, prepared: null } })
    );
    await runner.shutdown();
  });

  it('reports a failed run with its code', async () => {
    const { runner, calls } = setup({
      claim: { job },
      process: async () => {
        throw new Error('STITCH_IMAGE_UNAVAILABLE');
      }
    });
    await runner.enroll(credential);
    await runner.tick();
    expect(calls.at(-1)).toMatchObject({
      route: 'complete',
      body: { outcome: 'failed', errorCode: 'STITCH_IMAGE_UNAVAILABLE' }
    });
    await runner.shutdown();
  });

  it('backs off for a long time when the server refuses the computer', async () => {
    vi.useFakeTimers();
    const { runner, calls } = setup({
      claim: { error: { code: 'PERMISSION_DENIED' } },
      claimStatus: 403
    });
    await runner.enroll(credential);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(calls).toHaveLength(2);
    await runner.shutdown();
  });
});

describe('stopping', () => {
  async function running(heartbeatCancel: boolean) {
    vi.useFakeTimers();
    let finish: (value: unknown) => void = () => undefined;
    const context = setup({
      claim: { job },
      heartbeatCancel,
      process: () => new Promise(resolve => (finish = resolve))
    });
    await context.runner.enroll(credential);
    const ticking = context.runner.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(context.runner.busy()).toBe(true);
    const settle = async () => {
      finish({ operationId: job.operationId, state: 'canceled', materialId: null, reused: false });
      await ticking;
    };
    return { ...context, settle };
  }

  it('cancels the run when the heartbeat says the updater no longer wants it, and reports nothing', async () => {
    const { runner, bridge, calls, settle } = await running(true);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(calls.at(-1)?.route).toBe('heartbeat');
    expect(bridge.cancel).toHaveBeenCalledWith(job.operationId);
    await settle();
    expect(calls.map(call => call.route)).not.toContain('complete');
    await runner.shutdown();
  });

  it('keeps the run while the heartbeat says go on', async () => {
    const { runner, bridge, settle } = await running(false);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(bridge.cancel).not.toHaveBeenCalled();
    await settle();
    await runner.shutdown();
  });

  it('forgets the secret and cancels the run when switched off', async () => {
    const { runner, bridge, settle } = await running(false);
    await runner.unenroll();
    expect(bridge.cancel).toHaveBeenCalledWith(job.operationId);
    await settle();
    await expect(readFile(path.join(dir, 'device.json'), 'utf8')).rejects.toThrow();
    expect(runner.status()).toEqual({ enrolled: null, working: false });
    await runner.shutdown();
  });
});
