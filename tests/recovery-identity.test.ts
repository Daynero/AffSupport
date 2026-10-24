import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RecoveryJournal } from '../apps/agent/src/team-bridge/recovery-journal';
import { DiagnosticsLog } from '../apps/agent/src/server/diagnostics-log';
import { TeamRecoveryWorker } from '../apps/agent/src/team-bridge/recovery-worker';
import type { RecoverySecrets } from '../apps/agent/src/platform/recovery-credentials';
import { removeTemporaryDirectory } from './support/temp-dir';
const A = '46000000-0000-4000-8000-000000000001';
const B = '46000000-0000-4000-8000-000000000002';
const TEAM = '46000000-0000-4000-8000-000000000003';
const INSTALL = '46000000-0000-4000-8000-000000000004';
const DELEGATION = '46000000-0000-4000-8000-000000000005';
const REQUEST = '46000000-0000-4000-8000-000000000006';
const OP = '46000000-0000-4000-8000-000000000007';
const JOB = '46000000-0000-4000-8000-000000000008';
const workers: TeamRecoveryWorker[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.shutdown();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await removeTemporaryDirectory(root);
});
async function fixture(actor: string | null, registrationActor: string | undefined = A) {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'soty-recovery-identity-'));
  roots.push(root);
  const journal = new RecoveryJournal(root);
  const registration = {
    teamId: TEAM,
    installationId: INSTALL,
    delegationId: DELEGATION,
    endpoint: 'http://127.0.0.1:54321/functions/v1/team-recovery',
    account: 'soty-recovery-identity',
    ...(registrationActor === undefined ? {} : { actorId: registrationActor })
  };
  await journal.save({ registrations: [registration], checkpoints: [] });
  let identity = actor;
  const initial: RecoverySecrets = {
    refresh: 'r'.repeat(43),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    rotationId: REQUEST,
    claim: 'c'.repeat(43),
    claimExpiresAt: new Date(Date.now() + 300000).toISOString(),
    active: null
  };
  const saved = new Map<string, RecoverySecrets>([['soty-recovery-identity', initial]]);
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const action = JSON.parse(String(init?.body)).action;
    return response(
      action === 'disconnect' ? { revoked: true } : { job: null, operationCredential: null }
    );
  });
  const process = {
    process: vi.fn(async () => ({
      operationId: OP,
      state: 'succeeded' as const,
      materialId: null,
      reused: false
    })),
    cancel: vi.fn(() => true),
    busy: () => false
  };
  const record = vi.fn<(code: string, props: Record<string, string | number | boolean>) => void>();
  const options = {
    record,
    environment: 'beta' as const,
    journal,
    process,
    fetch: fetcher,
    currentActorId: () => identity,
    secrets: {
      read: async (key: string) => saved.get(key) ?? null,
      write: async (_key: string, value: RecoverySecrets) => {
        saved.set(_key, value);
      },
      delete: async (key: string) => {
        saved.delete(key);
      }
    }
  };
  const worker = new TeamRecoveryWorker(options);
  workers.push(worker);
  return {
    worker,
    record,
    fetcher,
    process,
    setActor: (value: string | null) => {
      identity = value;
    },
    actions: () =>
      fetcher.mock.calls.map(call => JSON.parse(String(call[1]?.body)).action as string)
  };
}
function response(value: object) {
  return new Response(JSON.stringify({ ok: true, value }), { status: 200 });
}
it('does not claim with a different verified account from the durable registration', async () => {
  const f = await fixture(B);
  await f.worker.load();
  await vi.advanceTimersByTimeAsync(0);
  await f.worker.idle();
  expect(f.actions()).not.toContain('claim');
  expect(f.process.process).not.toHaveBeenCalled();
  expect(f.worker.status(TEAM).enabled).toBe(false);
});
it('does not guess the actor for legacy registrations missing an authoritative binding', async () => {
  const f = await fixture(A);
  // Reproduce an existing journal from before actor binding was persisted.
  const saved = await f.worker.options.journal.load();
  for (const row of saved.registrations) delete (row as unknown as { actorId?: string }).actorId;
  await f.worker.options.journal.save(saved);
  await f.worker.load();
  await vi.advanceTimersByTimeAsync(0);
  await f.worker.idle();
  expect(f.actions()).not.toContain('claim');
  expect(f.worker.status(TEAM).enabled).toBe(false);
});
it('rechecks identity after a pending claim reply before checkpointing or starting native work', async () => {
  const f = await fixture(A);
  let reply!: (value: Response) => void;
  f.fetcher.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        reply = resolve;
      })
  );
  await f.worker.load();
  await vi.advanceTimersByTimeAsync(0);
  await vi.waitFor(() => expect(reply).toBeTypeOf('function'));
  expect(f.actions()).toContain('claim');
  f.setActor(B);
  const grant = {
    ticket: 't'.repeat(43),
    purpose: 'process_input',
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    maxRangeBytes: 1024,
    maxUses: 1
  };
  reply(
    response({
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
    })
  );
  await f.worker.idle();
  expect(f.actions()).not.toContain('checkpoint');
  expect(f.process.process).not.toHaveBeenCalled();
  expect(f.worker.status(TEAM).enabled).toBe(false);
});
it('waits without network while identity is unknown and resumes when the same actor is verified', async () => {
  const f = await fixture(null);
  await f.worker.load();
  await vi.advanceTimersByTimeAsync(0);
  await f.worker.idle();
  expect(f.actions()).toEqual([]);
  expect((await f.worker.options.journal.load()).registrations).toHaveLength(1);
  f.setActor(A);
  await vi.advanceTimersByTimeAsync(60000);
  await f.worker.idle();
  expect(f.actions()).toContain('claim');
});
it('never reactivates a retiring registration after restart, even if the old actor returns', async () => {
  const f = await fixture(B);
  f.fetcher.mockRejectedValue(new Error('offline'));
  await f.worker.load();
  await vi.advanceTimersByTimeAsync(0);
  await f.worker.idle();
  const saved = await f.worker.options.journal.load();
  expect(saved.registrations[0]).toMatchObject({ revoking: true });
  expect(f.record).toHaveBeenCalledWith(
    'recovery_retirement',
    expect.objectContaining({ stage: 'pending_server', delegation_id: DELEGATION })
  );
  expect(f.record.mock.calls.some(([, props]) => props.stage === 'server_confirmed')).toBe(false);
  expect(await f.worker.options.secrets!.read('soty-recovery-identity')).not.toBeNull();
  await f.worker.shutdown();
  f.setActor(A);
  f.fetcher.mockClear();
  f.fetcher.mockResolvedValue(response({ revoked: true }));
  const restarted = new TeamRecoveryWorker(f.worker.options);
  workers.push(restarted);
  await restarted.load();
  await vi.advanceTimersByTimeAsync(60000);
  await restarted.idle();
  expect(f.actions()).not.toContain('claim');
  expect(f.actions()).toEqual(['disconnect']);
  expect(await f.worker.options.secrets!.read('soty-recovery-identity')).toBeNull();
  expect((await restarted.options.journal.load()).registrations).toEqual([]);
  expect(f.record).toHaveBeenCalledWith(
    'recovery_retirement',
    expect.objectContaining({ stage: 'local_complete' })
  );
  const diagnostic = new DiagnosticsLog();
  for (const [code, props] of f.record.mock.calls) diagnostic.record('team', code, props);
  expect(diagnostic.rejectedCount()).toBe(0);
  const safe = JSON.stringify(diagnostic.since(0));
  expect(safe).not.toContain('r'.repeat(43));
  expect(safe).not.toContain('c'.repeat(43));
  expect(safe).not.toContain('soty-recovery-identity');
});
it('keeps confirmed retirement across a failed secret deletion and retries only local cleanup after restart', async () => {
  const f = await fixture(B);
  vi.spyOn(f.worker.options.secrets!, 'delete').mockRejectedValueOnce(new Error('storage busy'));
  await f.worker.load();
  await vi.advanceTimersByTimeAsync(0);
  await f.worker.idle();
  expect((await f.worker.options.journal.load()).registrations[0]).toMatchObject({
    revoking: true,
    revocationConfirmed: true
  });
  expect(f.record).toHaveBeenCalledWith(
    'recovery_retirement',
    expect.objectContaining({ stage: 'server_confirmed' })
  );
  expect(f.record).toHaveBeenCalledWith(
    'recovery_retirement',
    expect.objectContaining({ stage: 'pending_local_cleanup' })
  );
  expect(f.record.mock.calls.some(([, props]) => props.stage === 'local_complete')).toBe(false);
  await f.worker.shutdown();
  f.setActor(A);
  f.fetcher.mockClear();
  const restarted = new TeamRecoveryWorker(f.worker.options);
  workers.push(restarted);
  await restarted.load();
  await vi.advanceTimersByTimeAsync(60000);
  await restarted.idle();
  expect(f.actions()).toEqual([]);
  expect(await f.worker.options.secrets!.read('soty-recovery-identity')).toBeNull();
  expect((await restarted.options.journal.load()).registrations).toEqual([]);
});
it('does not enable a setup whose team was disabled while redeem was pending', async () => {
  const f = await fixture(A);
  await f.worker.load();
  const setup = f.worker.begin(TEAM, 'http://127.0.0.1:54321/functions/v1/team-recovery');
  let reply!: (value: Response) => void;
  f.fetcher.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        reply = resolve;
      })
  );
  const enrolling = f.worker.enroll(setup.enrollmentId, REQUEST);
  // Observe rejection immediately so an expected refusal is never an unhandled promise.
  const outcome = enrolling.then(
    () => 'enabled',
    error => error.message as string
  );
  await f.worker.remove(TEAM);
  reply(
    response({
      actorId: A,
      teamId: TEAM,
      installationId: INSTALL,
      delegationId: '46000000-0000-4000-8000-000000000009',
      refresh: 's'.repeat(43),
      expiresAt: new Date(Date.now() + 86400000).toISOString()
    })
  );
  expect(await outcome).toBe('PERMISSION_DENIED');
  expect(f.worker.status(TEAM).enabled).toBe(false);
  expect((await f.worker.options.journal.load()).registrations).toEqual([]);
});
it('keeps a prior actor retirement handle separate from a new setup for the same team', async () => {
  const f = await fixture(A);
  await f.worker.load();
  const originalFetch = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (url, init) => {
    const action = JSON.parse(String(init?.body)).action;
    if (action === 'disconnect') throw new Error('offline');
    if (action === 'redeem')
      return response({
        actorId: B,
        teamId: TEAM,
        installationId: INSTALL,
        delegationId: '46000000-0000-4000-8000-000000000010',
        refresh: 's'.repeat(43),
        expiresAt: new Date(Date.now() + 86400000).toISOString()
      });
    return originalFetch(url, init);
  });
  await f.worker.prepareActorChange(B);
  f.setActor(B);
  f.process.busy = () => true;
  const setup = f.worker.begin(TEAM, 'http://127.0.0.1:54321/functions/v1/team-recovery');
  await f.worker.enroll(setup.enrollmentId, REQUEST);
  const registrations = (await f.worker.options.journal.load()).registrations;
  const old = registrations.find(row => row.actorId === A)!;
  const current = registrations.find(row => row.actorId === B)!;
  expect(old.revoking).toBe(true);
  expect(current.account).not.toBe(old.account);
  expect((await f.worker.options.secrets!.read(old.account))?.refresh).toBe('r'.repeat(43));
  expect((await f.worker.options.secrets!.read(current.account))?.refresh).toBe('s'.repeat(43));
  f.fetcher.mockImplementation(originalFetch);
  await vi.advanceTimersByTimeAsync(60000);
  await f.worker.idle();
  expect(await f.worker.options.secrets!.read(old.account)).toBeNull();
  expect((await f.worker.options.secrets!.read(current.account))?.refresh).toBe('s'.repeat(43));
  expect(f.worker.status(TEAM).enabled).toBe(true);
});
it('persists the retirement marker even if an older permission block already has the same reason', async () => {
  const f = await fixture(A);
  const state = await f.worker.options.journal.load();
  state.checkpoints = [
    {
      delegationId: DELEGATION,
      requestId: REQUEST,
      operationId: null,
      stage: 'blocked',
      reason: 'permission_revoked',
      updatedAt: new Date().toISOString()
    }
  ];
  await f.worker.options.journal.save(state);
  await f.worker.load();
  await f.worker.prepareActorChange(B);
  expect((await f.worker.options.journal.load()).registrations[0]).toMatchObject({
    revoking: true
  });
});
it('retries durable retirement preparation after its first journal write fails', async () => {
  const f = await fixture(A);
  await f.worker.load();
  vi.spyOn(f.worker.options.journal, 'save').mockRejectedValueOnce(
    new Error('synthetic cache busy')
  );
  await expect(f.worker.prepareActorChange(B)).rejects.toThrow('synthetic cache busy');
  expect(f.record.mock.calls.some(([code]) => code === 'recovery_retirement')).toBe(false);
  await f.worker.prepareActorChange(B);
  expect(f.record).toHaveBeenCalledWith(
    'recovery_retirement',
    expect.objectContaining({ stage: 'pending_server' })
  );
  expect((await f.worker.options.journal.load()).registrations[0]).toMatchObject({
    revoking: true
  });
});

it('records an unknown server outcome when the last protected retirement handle is missing', async () => {
  const f = await fixture(B);
  await f.worker.options.secrets!.delete('soty-recovery-identity');
  await f.worker.load();
  await vi.advanceTimersByTimeAsync(0);
  await f.worker.idle();
  expect(f.record).toHaveBeenCalledWith(
    'recovery_retirement',
    expect.objectContaining({ stage: 'server_unknown' })
  );
  expect(f.actions()).toEqual([]);
  expect(f.worker.status(TEAM).enabled).toBe(false);
});
it.each([
  { actor: undefined, code: 'AGENT_UPDATE_REQUIRED' },
  { actor: 'malformed', code: 'INVALID_RESPONSE' },
  { actor: B, code: 'PERMISSION_DENIED' }
])(
  'keeps a refused setup handle for retirement and reports the correct failure $code',
  async ({ actor, code }) => {
    const f = await fixture(A);
    await f.worker.options.journal.save({ registrations: [], checkpoints: [] });
    await f.worker.load();
    const setup = f.worker.begin(TEAM, 'http://127.0.0.1:54321/functions/v1/team-recovery');
    const id = '46000000-0000-4000-8000-000000000011';
    f.fetcher.mockImplementation(async (_url, init) => {
      if (JSON.parse(String(init?.body)).action === 'redeem')
        return response({
          ...(actor === undefined ? {} : { actorId: actor }),
          teamId: TEAM,
          installationId: setup.installationId,
          delegationId: id,
          refresh: 'z'.repeat(43),
          expiresAt: new Date(Date.now() + 86400000).toISOString()
        });
      throw new Error('retirement offline');
    });
    await expect(f.worker.enroll(setup.enrollmentId, REQUEST)).rejects.toThrow(code);
    const pending = (await f.worker.options.journal.load()).registrations.find(
      row => row.delegationId === id
    )!;
    expect(pending.revoking).toBe(true);
    expect((await f.worker.options.secrets!.read(pending.account))?.refresh).toBe('z'.repeat(43));
    expect(f.worker.status(TEAM).enabled).toBe(false);
    expect(f.process.process).not.toHaveBeenCalled();
  }
);
