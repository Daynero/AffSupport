import { expect, it, vi } from 'vitest';
import { retryTransient } from '../apps/agent/src/team-bridge/heartbeat-tolerance';
import { CatalogVideoForegroundController } from '../apps/agent/src/team-bridge/catalog-video-foreground';
import { NativeRestitchController } from '../apps/agent/src/team-bridge/native-restitch-controller';

/**
 * Beta 2026-11-11, set 4c9717d4: the API gateway paused for 150 s mid-restitch.
 * One lost reply on a selection call ended the stitch, the closure (finish)
 * lost its reply too and was never sent again, and the creation waited for its
 * dialog to be reopened.
 */
const transient = (error: unknown) => error instanceof Error && error.message === 'LOST';
const sleep = async () => {};

it('repeats an idempotent call that lost its reply until it answers', async () => {
  const call = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(new Error('LOST'))
    .mockRejectedValueOnce(new Error('LOST'))
    .mockResolvedValue('issued');
  await expect(retryTransient(call, { transient, sleep })).resolves.toBe('issued');
  expect(call).toHaveBeenCalledTimes(3);
});

it('never repeats a definitive refusal', async () => {
  const call = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('PERMISSION_DENIED'));
  await expect(retryTransient(call, { transient, sleep })).rejects.toThrow('PERMISSION_DENIED');
  expect(call).toHaveBeenCalledTimes(1);
});

it('gives up once the budget since the first failure is spent', async () => {
  let clock = 0;
  const call = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('LOST'));
  await expect(
    retryTransient(call, {
      transient,
      budgetMs: 90_000,
      delaysMs: [10_000],
      now: () => clock,
      sleep: async ms => {
        clock += ms;
      }
    })
  ).rejects.toThrow('LOST');
  // Attempts at 0, 10 s … 90 s; a wait past 90 s is not started.
  expect(call).toHaveBeenCalledTimes(10);
});

it('stops repeating when the run is aborted', async () => {
  const abort = new AbortController();
  const call = vi.fn<() => Promise<string>>().mockImplementation(async () => {
    abort.abort();
    throw new Error('LOST');
  });
  await expect(retryTransient(call, { transient, sleep, signal: abort.signal })).rejects.toThrow(
    'LOST'
  );
  expect(call).toHaveBeenCalledTimes(1);
});

const nid = (n: number) => 'b3450000-0000-4000-8000-' + String(n).padStart(12, '0');
const actor = nid(1),
  team = nid(2),
  root = nid(3),
  endpoint = 'http://127.0.0.1:54321/functions/v1/drive-ops';
function nativeSetup(lose: Record<string, number>) {
  let vault: unknown = null;
  const calls: string[] = [];
  const store = {
    read: vi.fn(async () => structuredClone(vault)),
    write: vi.fn(async (value: unknown) => {
      vault = structuredClone(value);
    })
  };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const action = new URL(String(input)).pathname.split('/').at(-1)!;
    calls.push(action);
    if ((lose[action] ?? 0) > 0) {
      lose[action]! -= 1;
      // What a paused gateway gives the agent: no JSON at all.
      return new Response('', { status: 499 });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const r = (vault as { records: Array<{ enrollmentId: string; nativeInstanceId: string }> })
      .records[0]!;
    let value: unknown = true;
    if (action === 'redeem')
      value = {
        grantId: r.enrollmentId,
        enrollmentId: r.enrollmentId,
        rootOperationId: root,
        teamId: team,
        actorId: actor,
        nativeInstanceId: r.nativeInstanceId,
        redeemed: true,
        expiresAt: '2030-01-01T00:00:00Z',
        purpose: 'restitch_native_control_v1',
        protocolVersion: 1,
        ticket: 't'.repeat(43)
      };
    if (action === 'claim')
      value = {
        rootOperationId: root,
        claimId: body.claimId,
        nativeInstanceId: r.nativeInstanceId,
        executorId: nid(4),
        epoch: 1,
        active: true
      };
    if (action === 'context')
      value = {
        selectionProtocol: 1,
        rootOperationId: root,
        teamId: team,
        actorId: actor,
        poolNamespaceId: nid(5),
        executorId: nid(4),
        epoch: 1,
        nativeInstanceId: r.nativeInstanceId,
        defaults: {
          configured: true,
          sourceMode: 'drive',
          operation: 'restitch',
          startImageIds: [],
          endImageIds: [],
          startEnabled: false,
          endEnabled: true,
          fitMode: 'cover',
          finalDurationMode: 'custom',
          customFinalDurationSeconds: 3,
          updatedAt: '',
          updatedBy: null
        },
        source: {
          materialId: nid(6),
          version: '1',
          checksum: 'a'.repeat(32),
          sizeBytes: 4,
          mimeType: 'video/mp4'
        }
      };
    return new Response(JSON.stringify({ ok: true, value }), {
      headers: { 'content-type': 'application/json' }
    });
  });
  const controller = new NativeRestitchController({
    endpoint,
    environment: 'beta',
    currentActorId: () => actor,
    vault: store,
    journal: { load: vi.fn(async () => []), save: vi.fn(async () => {}) },
    cache: {} as never,
    fetch: fetcher,
    run: vi.fn(),
    transientRetry: { delaysMs: [1], sleep }
  });
  return { controller, calls };
}

it('a lost reply on the selection context no longer ends the restitch', async () => {
  const f = nativeSetup({ context: 1 });
  const enrollment = await f.controller.prepare({ rootOperationId: root, teamId: team }, 'process');
  await f.controller.redeem(enrollment.enrollmentId);
  const result = await f.controller.process(enrollment.enrollmentId, root, async () => ({
    operationId: root,
    state: 'succeeded',
    materialId: nid(8),
    reused: false
  }));
  expect(result).toMatchObject({ state: 'succeeded' });
  expect(f.calls.filter(action => action === 'context')).toHaveLength(2);
  await f.controller.shutdown();
});

it('redelivers the closure whose reply was lost instead of leaving the claim open', async () => {
  const f = nativeSetup({ finish: 2 });
  const enrollment = await f.controller.prepare({ rootOperationId: root, teamId: team }, 'process');
  await f.controller.redeem(enrollment.enrollmentId);
  await expect(
    f.controller.process(enrollment.enrollmentId, root, async () => ({
      operationId: root,
      state: 'succeeded',
      materialId: nid(8),
      reused: false
    }))
  ).resolves.toMatchObject({ state: 'succeeded' });
  expect(f.calls.filter(action => action === 'finish')).toHaveLength(3);
  await f.controller.shutdown();
});

const fid = (n: number) => '47345000-0000-4000-8000-' + String(n).padStart(12, '0');
const binding = {
  protocolVersion: 1,
  teamId: fid(1),
  sourceMaterialId: fid(2),
  requestKey: 'product-catalog:' + fid(3)
};
const granted = (body: Record<string, unknown>) => ({
  ...body,
  executorId: body.enrollmentId,
  actorId: fid(4),
  teamId: binding.teamId,
  sourceMaterialId: binding.sourceMaterialId,
  requestKey: binding.requestKey,
  expectedVersion: null,
  ticket: 't'.repeat(43)
});
function foreground(options: {
  run: (
    setId: string,
    ticket: string,
    enrollmentId: string,
    signal: AbortSignal
  ) => Promise<unknown>;
  redeem?: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  vault?: { read: () => Promise<unknown>; write: (value: unknown) => Promise<void> };
  native?: string;
  reconcileCanceled?: () => Promise<boolean>;
}) {
  let saved: unknown = null;
  const redeem = vi.fn(options.redeem ?? (async (body: Record<string, unknown>) => granted(body)));
  const run = vi.fn(options.run);
  const controller = new CatalogVideoForegroundController({
    nativeInstanceId: options.native ?? fid(5),
    currentActorId: () => fid(4),
    allowed: () => true,
    vault: options.vault ?? {
      read: async () => saved,
      write: async value => {
        saved = structuredClone(value);
      }
    },
    redeem,
    run,
    reconcileCanceled: options.reconcileCanceled,
    resumeDelaysMs: [1, 1, 1]
  });
  return { controller, run, redeem, saved: () => saved };
}
const attachOf = (receipt: { enrollmentId: string; nativeInstanceId: string }) => ({
  protocolVersion: 1,
  teamId: binding.teamId,
  setId: fid(7),
  enrollmentId: receipt.enrollmentId,
  nativeInstanceId: receipt.nativeInstanceId
});

it('tries an interrupted creation again without its dialog', async () => {
  let runs = 0;
  const f = foreground({
    run: async () => {
      runs += 1;
      if (runs === 1) throw new Error('PROCESS_RESULT_UNCERTAIN');
    }
  });
  const receipt = await f.controller.prepare(binding);
  await f.controller.attach(attachOf(receipt));
  await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2));
  // Each attempt asks the server first: it decides whether the set may continue.
  expect(f.redeem).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect((f.saved() as Array<{ state: string }>)[0]!.state).toBe('ready'));
  await f.controller.shutdown();
});

it('stops trying once the server refuses for good', async () => {
  let redeems = 0;
  const f = foreground({
    run: async () => {
      throw new Error('PROCESS_RESULT_UNCERTAIN');
    },
    redeem: async body => {
      redeems += 1;
      if (redeems > 1) throw new Error('EXPIRED');
      return granted(body);
    }
  });
  const receipt = await f.controller.prepare(binding);
  await f.controller.attach(attachOf(receipt));
  await vi.waitFor(() => expect(f.redeem).toHaveBeenCalledTimes(2));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(f.redeem).toHaveBeenCalledTimes(2);
  expect(f.run).toHaveBeenCalledTimes(1);
  await f.controller.shutdown();
});

it('never resumes a run this agent stopped itself', async () => {
  const f = foreground({
    run: (_set, _ticket, _enrollment, signal) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('PROCESS_CANCELED')))
      )
  });
  const receipt = await f.controller.prepare(binding);
  await f.controller.attach(attachOf(receipt));
  await f.controller.prepareActorChange(null);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(f.redeem).toHaveBeenCalledTimes(1);
  await f.controller.shutdown();
});

it('a restarted agent resumes its interrupted set once the server allows the takeover', async () => {
  // The first agent dies mid-run: its vault still says 'running'.
  const first = foreground({ run: () => new Promise(() => {}) });
  const receipt = await first.controller.prepare(binding);
  await first.controller.attach(attachOf(receipt));
  const snapshot = structuredClone(first.saved());
  let redeems = 0;
  const restarted = foreground({
    native: fid(12),
    vault: { read: async () => structuredClone(snapshot), write: async () => {} },
    reconcileCanceled: async () => false,
    run: async () => {},
    redeem: async body => {
      redeems += 1;
      // Not silent for two minutes yet: the server refuses the takeover once.
      if (redeems === 1) throw new Error('PROCESS_RESULT_UNCERTAIN');
      return granted(body);
    }
  });
  await restarted.controller.load();
  await vi.waitFor(() => expect(restarted.run).toHaveBeenCalledTimes(1));
  expect(restarted.redeem).toHaveBeenCalledTimes(2);
  expect(restarted.redeem.mock.calls[1]?.[0]).toMatchObject({
    executionNativeInstanceId: fid(12),
    expectedExecutionNativeInstanceId: fid(5)
  });
  await restarted.controller.shutdown();
});
