import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SPACE_DERIVATIVES_PER_IDLE_CLAIM,
  TeamRecoveryWorker,
  type RecoveryWorkerOptions
} from '../apps/agent/src/team-bridge/recovery-worker';
import {
  RecoveryJournal,
  type RecoveryRegistration
} from '../apps/agent/src/team-bridge/recovery-journal';
import type {
  RecoverySecrets,
  RecoverySecretStore
} from '../apps/agent/src/platform/recovery-credentials';
import type { SpaceDerivativeRequest } from '../apps/agent/src/team-bridge/r2-derivatives';
import {
  handleRecovery,
  type RecoveryHandlerDeps
} from '../supabase/functions/team-recovery/handler';
import { removeTemporaryDirectory } from './support/temp-dir.js';

/**
 * 057 T120: an R2 space's pictures are made in the background too (research R5). After a claim
 * that found no other work in an R2 space, the member's Soty asks team-recovery for the space's
 * picture jobs with the same claim credential and runs each through its own derivative bridge,
 * a few per idle claim, never beside other heavy work. A Drive space's claim says nothing new
 * and its agent never asks.
 */

const ACTOR = '34000000-0000-4000-8000-000000000009';
const TEAM = '34000000-0000-4000-8000-000000000001';
const DELEGATION = '34000000-0000-4000-8000-000000000002';
const INSTALL = '34000000-0000-4000-8000-000000000003';
const REQUEST = '34000000-0000-4000-8000-000000000004';
const OBJECT = '34000000-0000-4000-8000-0000000000a1';
const ENDPOINT = 'http://127.0.0.1:54321/functions/v1/team-recovery';
const dirs: string[] = [];
const workers: TeamRecoveryWorker[] = [];

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.shutdown();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await removeTemporaryDirectory(dir);
});

function job(index = 0) {
  return {
    teamId: TEAM,
    objectId: `${OBJECT.slice(0, 24)}${String(index).padStart(12, '0')}`,
    recipeVersion: 1,
    reason: 'browser_unsupported',
    materialId: '34000000-0000-4000-8000-0000000000b1',
    name: 'Clip.mov',
    category: 'video',
    contentId: 'f'.repeat(64),
    contentType: 'video/quicktime',
    bytes: '1000',
    made: [],
    needsMediaFacts: true,
    leaseToken: 'l'.repeat(43),
    leaseUntil: new Date(Date.now() + 600_000).toISOString(),
    source: {
      ticket: 't'.repeat(43),
      purpose: 'download_range',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      maxRangeBytes: 1024,
      maxUses: 1
    }
  };
}

async function fixture(input: {
  workspaceStorage?: 'r2';
  jobs?: number;
  bridgeBusy?: boolean;
  processBusy?: boolean;
  withBridge?: boolean;
}) {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'soty-space-derivative-bg-'));
  dirs.push(root);
  const journal = new RecoveryJournal(root);
  const registration: RecoveryRegistration = {
    actorId: ACTOR,
    teamId: TEAM,
    installationId: INSTALL,
    delegationId: DELEGATION,
    endpoint: ENDPOINT,
    account: 'soty-recovery-test'
  };
  await journal.save({
    registrations: [registration],
    checkpoints: [
      {
        delegationId: DELEGATION,
        requestId: REQUEST,
        operationId: null,
        stage: 'claiming',
        reason: null,
        updatedAt: new Date().toISOString()
      }
    ]
  });
  let data: RecoverySecrets = {
    refresh: 'r'.repeat(43),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    rotationId: REQUEST,
    claim: 'c'.repeat(43),
    claimExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    active: null
  };
  const secrets: RecoverySecretStore = {
    read: async () => data,
    write: async (_account, value) => {
      data = { ...value };
    },
    delete: async () => {}
  };
  let remaining = input.jobs ?? 0;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { action: string };
    const value =
      body.action === 'derivative_claim'
        ? { job: remaining-- > 0 ? job(remaining) : null }
        : {
            job: null,
            operationCredential: null,
            ...(input.workspaceStorage ? { workspaceStorage: input.workspaceStorage } : {})
          };
    return new Response(JSON.stringify({ ok: true, value }), { status: 200 });
  });
  const bridge = {
    busy: vi.fn(() => input.bridgeBusy ?? false),
    run: vi.fn(async (_request: SpaceDerivativeRequest) => ({ state: 'ready', accepted: [] }))
  };
  const options: RecoveryWorkerOptions = {
    environment: 'beta',
    currentActorId: () => ACTOR,
    journal,
    process: {
      process: vi.fn(),
      cancel: vi.fn(() => true),
      busy: vi.fn(() => input.processBusy ?? false)
    },
    secrets,
    fetch: fetcher,
    record: vi.fn(),
    ...(input.withBridge === false ? {} : { spaceDerivatives: bridge })
  };
  const worker = new TeamRecoveryWorker(options);
  workers.push(worker);
  await worker.load();
  await vi.advanceTimersByTimeAsync(0);
  await worker.idle();
  const actions = () =>
    fetcher.mock.calls.map(
      call => (JSON.parse(String(call[1]?.body)) as { action: string }).action
    );
  return { fetcher, bridge, actions };
}

describe('background picture jobs of an R2 space (agent)', () => {
  it('takes the space’s picture jobs after an idle claim and runs each through the bridge', async () => {
    const f = await fixture({ workspaceStorage: 'r2', jobs: 2 });
    expect(f.actions()).toEqual([
      'claim',
      'derivative_claim',
      'derivative_claim',
      'derivative_claim'
    ]);
    // With the claim credential, saying contract 3; never a body-named actor or space.
    const asked = f.fetcher.mock.calls[1]!;
    expect(new Headers(asked[1]?.headers).get('x-team-recovery-credential')).toBe('c'.repeat(43));
    expect(JSON.parse(String(asked[1]?.body))).toEqual({
      action: 'derivative_claim',
      teamWorkspaceContractVersion: 3,
      protocolVersion: 2
    });
    expect(f.bridge.run).toHaveBeenCalledTimes(2);
    const request = f.bridge.run.mock.calls[0]![0];
    expect(request.transferUrl).toBe(
      'http://127.0.0.1:54321/functions/v1/space-storage/agent/source'
    );
    expect(request.cloudBaseUrl).toBe('http://127.0.0.1:54321/functions/v1/space-storage');
    expect(request.job).toMatchObject({ teamId: TEAM, bytes: 1000, needsMediaFacts: true });
  });

  it('takes a few per idle claim and leaves the rest for the next one', async () => {
    const f = await fixture({ workspaceStorage: 'r2', jobs: 20 });
    expect(f.bridge.run).toHaveBeenCalledTimes(SPACE_DERIVATIVES_PER_IDLE_CLAIM);
  });

  it('never asks in a Drive space, without a bridge, or beside other heavy work', async () => {
    for (const input of [
      { jobs: 3 },
      { workspaceStorage: 'r2' as const, jobs: 3, withBridge: false },
      { workspaceStorage: 'r2' as const, jobs: 3, bridgeBusy: true },
      { workspaceStorage: 'r2' as const, jobs: 3, processBusy: true }
    ]) {
      const f = await fixture(input);
      // (A busy process bridge already keeps the worker from claiming at all.)
      expect(f.actions()).not.toContain('derivative_claim');
      if (!input.processBusy) expect(f.actions()).toEqual(['claim']);
      expect(f.bridge.run).not.toHaveBeenCalled();
      for (const worker of workers.splice(0)) await worker.shutdown();
      vi.useRealTimers();
    }
  });
});

describe('background picture jobs of an R2 space (team-recovery)', () => {
  const SECRET = 'a'.repeat(43);
  const deps = (rpc: RecoveryHandlerDeps['rpc']): RecoveryHandlerDeps => ({
    user: vi.fn(async () => ACTOR),
    rpc,
    revoke: vi.fn(async () => {}),
    drive: vi.fn(async () => ({ job: null })),
    token: () => SECRET,
    hash: async () => 'hashed'
  });
  const call = (body: Record<string, unknown>, origin = false) =>
    new Request('https://synthetic.test', {
      method: 'POST',
      headers: {
        'x-team-recovery-credential': SECRET,
        ...(origin ? { origin: 'https://web.test' } : {})
      },
      body: JSON.stringify({ protocolVersion: 2, ...body })
    });
  const space = () => ({
    claim: vi.fn(async () => ({ job: null })),
    heartbeat: vi.fn(async () => ({})),
    complete: vi.fn(async () => ({})),
    derivativeClaim: vi.fn(async () => ({ job: null }))
  });

  it('hands the credential’s hash and the declared contract to the space, nothing else', async () => {
    const rpc = vi.fn(async () => ({}));
    const d = { ...deps(rpc), space: space() };
    await expect(
      handleRecovery(
        call({ action: 'derivative_claim', teamWorkspaceContractVersion: 3, teamId: TEAM }),
        d
      )
    ).resolves.toEqual({ job: null });
    expect(d.space.derivativeClaim).toHaveBeenCalledWith('hashed', { teamWorkspaceContract: 3 });
    // The hot recovery function is not asked: the space's own check reads the credential.
    expect(rpc).not.toHaveBeenCalled();
    await handleRecovery(call({ action: 'derivative_claim' }), d);
    expect(d.space.derivativeClaim).toHaveBeenLastCalledWith('hashed', {});
  });

  it('refuses a browser origin and a server without the space step', async () => {
    const d = { ...deps(vi.fn(async () => ({}))), space: space() };
    await expect(
      handleRecovery(call({ action: 'derivative_claim' }, true), d)
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(d.space.derivativeClaim).not.toHaveBeenCalled();
    await expect(
      handleRecovery(call({ action: 'derivative_claim' }), deps(vi.fn(async () => ({}))))
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });

  it('tells an R2 space’s agent its claim was idle in R2; a Drive response is unchanged', async () => {
    const registered: unknown[] = [];
    const rpc = (backend: 'r2' | null) =>
      vi.fn(async (action: string, _hash: string | null, input: Record<string, unknown>) => {
        if (action === 'claim')
          return { teamId: TEAM, actorId: ACTOR, ...(backend ? { storageBackend: backend } : {}) };
        registered.push(input.response);
        return input.response;
      });
    await handleRecovery(
      call({ action: 'claim', requestId: REQUEST, teamWorkspaceContractVersion: 3 }),
      { ...deps(rpc('r2')), space: space() }
    );
    await handleRecovery(call({ action: 'claim', requestId: REQUEST }), {
      ...deps(rpc(null)),
      space: space()
    });
    expect(registered).toEqual([
      { job: null, operationCredential: null, workspaceStorage: 'r2' },
      { job: null, operationCredential: null }
    ]);
  });
});
