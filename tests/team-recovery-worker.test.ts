import { removeTemporaryDirectory } from './support/temp-dir.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { TeamProcessBridge } from '../apps/agent/src/team-bridge/process';
import { TeamOperationEvents } from '../apps/agent/src/team-bridge/events';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TeamRecoveryWorker,
  recoveryEndpoint
} from '../apps/agent/src/team-bridge/recovery-worker';
import {
  RecoveryJournal,
  type RecoveryRegistration
} from '../apps/agent/src/team-bridge/recovery-journal';
import type {
  RecoverySecrets,
  RecoverySecretStore
} from '../apps/agent/src/platform/recovery-credentials';
const TEAM = '34000000-0000-4000-8000-000000000001';
const DELEGATION = '34000000-0000-4000-8000-000000000002';
const INSTALL = '34000000-0000-4000-8000-000000000003';
const REQUEST = '34000000-0000-4000-8000-000000000004';
const OP = '34000000-0000-4000-8000-000000000005';
const JOB = '34000000-0000-4000-8000-000000000006';
const dirs: string[] = [];
const workers: TeamRecoveryWorker[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.shutdown();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await removeTemporaryDirectory(dir);
});
async function fixture(stage: 'claiming' | 'running' = 'claiming') {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'soty-recovery-worker-'));
  dirs.push(root);
  const journal = new RecoveryJournal(root);
  const registration: RecoveryRegistration = {
    teamId: TEAM,
    installationId: INSTALL,
    delegationId: DELEGATION,
    endpoint: 'http://127.0.0.1:54321/functions/v1/team-recovery',
    account: 'soty-recovery-test'
  };
  await journal.save({
    registrations: [registration],
    checkpoints: [
      {
        delegationId: DELEGATION,
        requestId: REQUEST,
        operationId: stage === 'running' ? OP : null,
        stage,
        reason: null,
        updatedAt: new Date().toISOString()
      }
    ]
  });
  let data: RecoverySecrets = {
    refresh: 'r'.repeat(43),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    rotationId: REQUEST,
    claim: 'c'.repeat(43),
    claimExpiresAt: new Date(Date.now() + 300000).toISOString(),
    active: null
  };
  const secrets: RecoverySecretStore = {
    read: async () => data,
    write: async (_account, value) => {
      data = { ...value };
    },
    delete: async () => undefined
  };
  const process = { process: vi.fn(), cancel: vi.fn(() => true), busy: vi.fn(() => false) };
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ ok: true, value: { job: null, operationCredential: null } }), {
        status: 200
      })
  );
  const record = vi.fn();
  const worker = new TeamRecoveryWorker({
    environment: 'beta',
    journal,
    process,
    secrets,
    fetch: fetcher,
    record
  });
  workers.push(worker);
  return {
    worker,
    record,
    journal,
    process,
    fetcher,
    setSecrets: (value: RecoverySecrets) => {
      data = value;
    },
    getSecrets: () => data
  };
}
describe('background recovery worker', () => {
  it('refuses production targets from a beta installation', () => {
    expect(() =>
      recoveryEndpoint('https://example.supabase.co/functions/v1/team-recovery', 'beta')
    ).toThrow();
    expect(() =>
      recoveryEndpoint('https://user:secret@example.test/functions/v1/team-recovery', 'production')
    ).toThrow();
  });
  it('quarantines corrupt metadata and permits explicit setup without replaying work', async () => {
    const f = await fixture();
    await writeFile(path.join(f.journal.root, 'recovery.json'), '{truncated');
    await expect(f.worker.load()).rejects.toThrow('INVALID_RESPONSE');
    expect(f.worker.status(TEAM)).toMatchObject({
      enabled: false,
      state: 'blocked',
      reason: 'needs_agent_setup'
    });
    expect(
      f.worker.begin(TEAM, 'http://127.0.0.1:54321/functions/v1/team-recovery').ticketDigest
    ).toMatch(/^[0-9a-f]{64}$/u);
    expect(f.process.process).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('keeps idle claims at one per 30 seconds and does not spin', async () => {
    const f = await fixture();
    await f.worker.load();
    await vi.advanceTimersByTimeAsync(0);
    await f.worker.idle();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29000);
    await f.worker.idle();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await f.worker.idle();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.process.process).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });
  it('does not start a late claim after explicit disable', async () => {
    const f = await fixture();
    let resolveClaim!: (value: Response) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    f.fetcher.mockImplementation(() => {
      entered();
      return new Promise(resolve => {
        resolveClaim = resolve;
      });
    });
    await f.worker.load();
    await vi.advanceTimersByTimeAsync(0);
    await started;
    const removal = f.worker.remove(TEAM);
    const grant = {
      ticket: 't'.repeat(43),
      purpose: 'process_input',
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      maxRangeBytes: 1024,
      maxUses: 1
    };
    resolveClaim(
      new Response(
        JSON.stringify({
          ok: true,
          value: {
            operationCredential: 'x'.repeat(43),
            job: {
              jobId: JOB,
              operationId: OP,
              leaseToken: 'l'.repeat(43),
              toolId: 'restitch',
              options: {},
              sourceGrant: grant,
              finalizeGrant: { ...grant, purpose: 'finalize' }
            }
          }
        })
      )
    );
    await removal;
    await f.worker.idle();
    expect(f.process.process).not.toHaveBeenCalled();
    expect(f.worker.status(TEAM).enabled).toBe(false);
  });
  it('executes a broker claim through the native bridge and settles only after its output receipt', async () => {
    const f = await fixture();
    const delegate = vi.fn(async () => ({
      file: '/synthetic/output.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 6
    }));
    const cleanup = vi.fn(async () => undefined);
    const uploadResult = vi.fn(async () => ({
      operationId: OP,
      state: 'succeeded' as const,
      materialId: JOB,
      reused: false
    }));
    const bridge = new TeamProcessBridge({
      events: new TeamOperationEvents(),
      delegates: { restitch: delegate },
      transfer: {
        downloadSource: vi.fn(async () => ({
          workspace: '/synthetic',
          file: '/synthetic/source.mp4',
          sizeBytes: 6,
          sourceVersion: '7',
          sourceChecksum: null,
          cleanup
        })),
        uploadResult
      }
    });
    f.process.process.mockImplementation(request => bridge.process(request));
    const grant = {
      ticket: 't'.repeat(43),
      purpose: 'process_input',
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      maxRangeBytes: 1024,
      maxUses: 8
    };
    const actions: string[] = [];
    f.fetcher.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      actions.push(body.action);
      if (body.action === 'settle') expect(uploadResult).toHaveBeenCalledOnce();
      const value =
        body.action === 'claim'
          ? {
              operationCredential: 'x'.repeat(43),
              job: {
                jobId: JOB,
                operationId: OP,
                leaseToken: 'l'.repeat(43),
                toolId: 'restitch',
                options: { mode: 'optimal', prepared: { stale: true } },
                sourceGrant: grant,
                finalizeGrant: { ...grant, purpose: 'finalize' }
              }
            }
          : { pending: false };
      return new Response(JSON.stringify({ ok: true, value }));
    });
    await f.worker.load();
    await vi.advanceTimersByTimeAsync(0);
    await f.worker.idle();
    expect(actions).toEqual(['claim', 'checkpoint', 'settle']);
    expect(f.process.process).toHaveBeenCalledWith(
      expect.objectContaining({ options: { mode: 'optimal', prepared: null } })
    );
    expect(delegate).toHaveBeenCalledOnce();
    expect(uploadResult).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(f.getSecrets().active).toBeNull();
    expect((await f.journal.load()).checkpoints[0]).toMatchObject({
      operationId: OP,
      stage: 'settled'
    });
    expect(JSON.stringify(f.record.mock.calls)).not.toContain('x'.repeat(43));
  });
  it('does not replay an uncertain operation after restart', async () => {
    const f = await fixture('running');
    const grant = {
      ticket: 't'.repeat(43),
      purpose: 'process_input',
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      maxRangeBytes: 1024,
      maxUses: 1
    };
    f.setSecrets({
      ...f.getSecrets(),
      active: {
        operationCredential: 'x'.repeat(43),
        job: {
          jobId: JOB,
          operationId: OP,
          leaseToken: 'l'.repeat(43),
          toolId: 'restitch',
          options: {},
          sourceGrant: grant,
          finalizeGrant: { ...grant, purpose: 'finalize' }
        }
      }
    });
    f.fetcher.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, value: { pending: true } }), { status: 200 })
    );
    await f.worker.load();
    await vi.advanceTimersByTimeAsync(0);
    await f.worker.idle();
    expect(f.process.process).not.toHaveBeenCalled();
    expect(f.worker.status(TEAM)).toMatchObject({
      state: 'blocked',
      reason: 'checkpoint_unavailable'
    });
  });
  it('honors a larger Retry-After and stops if it exceeds the episode budget', async () => {
    const f = await fixture();
    f.fetcher.mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: false, error: { code: 'RATE_LIMITED' } }), {
          status: 429,
          headers: { 'retry-after': '120' }
        })
    );
    await f.worker.load();
    await vi.advanceTimersByTimeAsync(0);
    await f.worker.idle();
    await vi.advanceTimersByTimeAsync(119000);
    await f.worker.idle();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await f.worker.idle();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    f.fetcher.mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: false, error: { code: 'RATE_LIMITED' } }), {
          status: 429,
          headers: { 'retry-after': '601' }
        })
    );
    await vi.advanceTimersByTimeAsync(120000);
    await f.worker.idle();
    expect(f.worker.status(TEAM)).toMatchObject({ state: 'blocked', reason: 'retry_exhausted' });
  });
  it('does not claim another operation while the existing process bridge is busy', async () => {
    const f = await fixture();
    f.process.busy.mockReturnValue(true);
    await f.worker.load();
    await vi.advanceTimersByTimeAsync(0);
    await f.worker.idle();
    expect(f.fetcher).not.toHaveBeenCalled();
    f.process.busy.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(30000);
    await f.worker.idle();
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it('persists the three-episode ceiling and probes only once per recovery episode', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const f = await fixture();
    f.fetcher.mockImplementation(async (_url, options) => {
      const action = JSON.parse(String(options?.body)).action;
      if (action === 'probe')
        return new Response(JSON.stringify({ ok: true, value: { allowed: true } }));
      if (action === 'rotate')
        return new Response(
          JSON.stringify({
            ok: true,
            value: {
              refresh: 'r'.repeat(43),
              claim: 'c'.repeat(43),
              claimExpiresAt: new Date(Date.now() + 300000).toISOString()
            }
          })
        );
      throw new Error('network');
    });
    await f.worker.load();
    await vi.advanceTimersByTimeAsync(0);
    await f.worker.idle();
    for (let episode = 0; episode < 3; episode++) {
      for (const delay of [2000, 4000, 8000, 16000, 30000]) {
        await vi.advanceTimersByTimeAsync(delay);
        await f.worker.idle();
      }
      if (episode < 2) {
        await vi.advanceTimersByTimeAsync(60000);
        await f.worker.idle();
      }
    }
    const actions = () => f.fetcher.mock.calls.map(([, o]) => JSON.parse(String(o?.body)).action);
    expect(actions().filter(a => a === 'claim')).toHaveLength(18);
    expect(actions().filter(a => a === 'probe')).toHaveLength(2);
    expect((await f.journal.load()).checkpoints[0].retryEpisodes).toHaveLength(3);
    const count = f.fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3600000);
    await f.worker.idle();
    expect(f.fetcher).toHaveBeenCalledTimes(count);
    await f.worker.shutdown();
    const restarted = new TeamRecoveryWorker(f.worker.options);
    workers.push(restarted);
    await restarted.load();
    await vi.advanceTimersByTimeAsync(0);
    await restarted.idle();
    expect(f.fetcher).toHaveBeenCalledTimes(count);
    expect(restarted.status(TEAM)).toMatchObject({ state: 'blocked', reason: 'retry_exhausted' });
  });
  it('stops retrying after one bounded transient episode and preserves the request ID', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const f = await fixture();
    f.fetcher.mockRejectedValue(new Error('network'));
    await f.worker.load();
    await vi.advanceTimersByTimeAsync(0);
    await f.worker.idle();
    for (const delay of [2000, 4000, 8000, 16000, 30000]) {
      await vi.advanceTimersByTimeAsync(delay);
      await f.worker.idle();
    }
    expect(f.fetcher).toHaveBeenCalledTimes(6);
    expect(f.worker.status(TEAM)).toMatchObject({ state: 'blocked', reason: 'retry_exhausted' });
    const requestIds = f.fetcher.mock.calls.map(
      ([, options]) => JSON.parse(String(options?.body)).requestId
    );
    expect(new Set(requestIds)).toEqual(new Set([REQUEST]));
    f.fetcher.mockImplementation(
      async () => new Response(JSON.stringify({ ok: true, value: { job: null } }))
    );
    await f.worker.retry(TEAM);
    await vi.advanceTimersByTimeAsync(0);
    await f.worker.idle();
    expect(f.worker.status(TEAM)).toMatchObject({ state: 'settled', reason: null });
    expect(f.process.process).not.toHaveBeenCalled();
  });
});
