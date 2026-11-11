import { afterEach, expect, it, vi } from 'vitest';
import { RECOVERY_BUDGET } from '@video-compressor/shared';
import { runCatalogVariantRecovery } from '../apps/agent/src/team-bridge/catalog-variant-recovery';
import { settleCatalogVariantProcess } from '../apps/agent/src/team-bridge/catalog-variant-closure';
import type { CatalogVariantSnapshot } from '../apps/agent/src/team-bridge/catalog-variant-executor';

/**
 * Beta 2026-11-11, set ee5595a8 (API gateway paused 150 s mid-restitch): the
 * stitch died on a lost reply, its failure was never reported because the code
 * was not a "pre-upload" one, the native closure's finish answered 409 for as
 * long as the operation stayed running, and the variant kept heartbeating the
 * whole time, so no silence-based recovery could ever take it over.
 */
const id = (n: number) => '47346000-0000-4000-8000-' + String(n).padStart(12, '0');
afterEach(() => {
  vi.useRealTimers();
});

it('redelivers a terminal report whose reply was lost', async () => {
  const complete = vi
    .fn<() => Promise<Record<string, unknown>>>()
    .mockRejectedValueOnce(new Error('PROCESS_RESULT_UNCERTAIN'))
    .mockRejectedValueOnce(new TypeError('fetch failed'))
    .mockResolvedValue({ operationId: id(3), kind: 'terminal', state: 'failed' });
  await expect(
    settleCatalogVariantProcess({
      operationId: id(3),
      signal: new AbortController().signal,
      run: async () => {
        throw new Error('RESTITCH_SCREEN_FETCH_FAILED');
      },
      complete,
      reportDelaysMs: [1, 1, 1]
    })
  ).rejects.toThrow('RESTITCH_SCREEN_FETCH_FAILED');
  expect(complete).toHaveBeenCalledTimes(3);
});

it('still never reports an uncertain stop, but stops its heartbeat at once', async () => {
  const stop = new AbortController();
  stop.abort(new Error('PROCESS_RESULT_UNCERTAIN'));
  const complete = vi.fn();
  const ended = vi.fn();
  await expect(
    settleCatalogVariantProcess({
      operationId: id(3),
      signal: stop.signal,
      run: async () => {
        throw new Error('PROCESS_CANCELED');
      },
      complete,
      ended
    })
  ).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  expect(complete).not.toHaveBeenCalled();
  expect(ended).toHaveBeenCalledOnce();
});

it('never repeats a report the server refused for good', async () => {
  const complete = vi.fn(async () => {
    throw new Error('PERMISSION_DENIED');
  });
  await expect(
    settleCatalogVariantProcess({
      operationId: id(3),
      signal: new AbortController().signal,
      run: async () => {
        throw new Error('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
      },
      complete,
      reportDelaysMs: [1, 1, 1]
    })
  ).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  expect(complete).toHaveBeenCalledOnce();
});

it('converges: lost terminal report, finish refused while running, heartbeat silenced', async () => {
  vi.useFakeTimers();
  let snapshot: CatalogVariantSnapshot = {
    setId: id(1),
    revision: 0,
    children: [{ index: 0, requestId: id(2), operationId: null, state: 'queued', outputId: null }]
  };
  const grant = {
    ticket: 't'.repeat(43),
    expiresAt: '2030-01-01T00:00:00Z',
    maxRangeBytes: 33554432,
    maxUses: 9
  };
  // The server side of the sequence.
  let operation: 'running' | 'failed' = 'running';
  let completeAttempts = 0;
  const heartbeats: number[] = [];
  const call = vi.fn(
    async (action: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (action === 'variant_load') return snapshot as unknown as Record<string, unknown>;
      if (action === 'variant_save') {
        snapshot = structuredClone(body.snapshot) as CatalogVariantSnapshot;
        return { saved: true };
      }
      if (action === 'variant_reconcile') return { kind: 'absent' };
      if (action === 'variant_admit') return { operationId: id(3) };
      if (action === 'variant_dispatch') return { executionAllowed: true };
      if (action === 'variant_heartbeat') {
        if (body.probe !== true) heartbeats.push(Date.now());
        return { continue: true, registered: false };
      }
      if (action === 'variant_complete') {
        completeAttempts += 1;
        // The first report is lost in the gateway, like the 13:47 outage.
        if (completeAttempts === 1) throw new Error('PROCESS_RESULT_UNCERTAIN');
        operation = 'failed';
        return { operationId: id(3), kind: 'terminal', state: 'failed' };
      }
      if (action === 'variant_process')
        return {
          operationId: id(3),
          state: 'running',
          agentContractVersion: 1,
          sourceGrant: { ...grant, purpose: 'process_input' },
          finalizeGrant: { ...grant, purpose: 'finalize' },
          transferUrl: 'http://127.0.0.1:54321/functions/v1/drive-transfer/range',
          cloudBaseUrl: 'http://127.0.0.1:54321/functions/v1/drive-ops',
          options: { restitchSelectionRootId: id(9), teamId: id(8) }
        };
      throw new Error('unexpected action ' + action);
    }
  );
  // The native closure: finish is refused while the operation is still running.
  let finishAttempts = 0;
  const finish = async () => {
    for (;;) {
      finishAttempts += 1;
      if (operation !== 'running') return true;
      if (finishAttempts > 40) throw new Error('LIVELOCK');
      await new Promise(resolve => setTimeout(resolve, 10_000));
    }
  };
  const protectedProcess: NonNullable<
    Parameters<typeof runCatalogVariantRecovery>[0]['protectedProcess']
  > = async (request, _enroll, signal, _authorize, complete, cancellationRequested, ended) => {
    try {
      return await settleCatalogVariantProcess({
        operationId: request.operationId,
        signal,
        complete,
        cancellationRequested,
        ended,
        run: async () => {
          // The stitch works for a minute, then one selection reply is lost.
          await new Promise(resolve => setTimeout(resolve, 60_000));
          throw new Error('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
        }
      });
    } finally {
      await finish();
    }
  };
  const done = runCatalogVariantRecovery({
    nativeInstanceId: id(5),
    initialSetId: id(1),
    call,
    process: { process: vi.fn(), cancel: vi.fn() },
    protectedProcess,
    signal: new AbortController().signal
  }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(60_000);
  const stitchEnded = Date.now();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  const outcome = await done;
  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toBe('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
  // The failure reached the server, so finish was accepted instead of looping.
  expect(operation).toBe('failed');
  expect(completeAttempts).toBe(2);
  expect(finishAttempts).toBe(1);
  // No heartbeat after the stitch ended: silence recovery stays possible.
  expect(heartbeats.length).toBeGreaterThan(0);
  expect(heartbeats.every(at => at <= stitchEnded)).toBe(true);
  expect(heartbeats.length).toBeLessThanOrEqual(60_000 / RECOVERY_BUDGET.heartbeatMs);
});

it('converges after an outage longer than the watchdog: silence lets the takeover close it', async () => {
  vi.useFakeTimers();
  let snapshot: CatalogVariantSnapshot = {
    setId: id(1),
    revision: 0,
    children: [{ index: 0, requestId: id(2), operationId: null, state: 'queued', outputId: null }]
  };
  const grant = {
    ticket: 't'.repeat(43),
    expiresAt: '2030-01-01T00:00:00Z',
    maxRangeBytes: 33554432,
    maxUses: 9
  };
  const start = Date.now();
  // The gateway is down from 10 s to 160 s.
  const down = () => Date.now() - start >= 10_000 && Date.now() - start < 160_000;
  let operation: 'running' | 'failed' = 'running';
  let lastLife = Date.now();
  const heartbeats: number[] = [];
  const call = vi.fn(
    async (action: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (action === 'variant_load') return snapshot as unknown as Record<string, unknown>;
      if (action === 'variant_save') {
        snapshot = structuredClone(body.snapshot) as CatalogVariantSnapshot;
        return { saved: true };
      }
      if (action === 'variant_reconcile') return { kind: 'absent' };
      if (action === 'variant_admit') return { operationId: id(3) };
      if (action === 'variant_dispatch') return { executionAllowed: true };
      if (action === 'variant_heartbeat') {
        if (down()) throw new Error('PROCESS_RESULT_UNCERTAIN');
        if (body.probe !== true) {
          heartbeats.push(Date.now());
          lastLife = Date.now();
        }
        return { continue: true, registered: false };
      }
      if (action === 'variant_complete') throw new Error('unexpected report of an uncertain stop');
      if (action === 'variant_process')
        return {
          operationId: id(3),
          state: 'running',
          agentContractVersion: 1,
          sourceGrant: { ...grant, purpose: 'process_input' },
          finalizeGrant: { ...grant, purpose: 'finalize' },
          transferUrl: 'http://127.0.0.1:54321/functions/v1/drive-transfer/range',
          cloudBaseUrl: 'http://127.0.0.1:54321/functions/v1/drive-ops',
          options: { restitchSelectionRootId: id(9), teamId: id(8) }
        };
      throw new Error('unexpected action ' + action);
    }
  );
  // Finish is refused while the operation runs; the server takes a variant over
  // after two minutes without a sign of life (20261207240000/345000).
  let finishAttempts = 0;
  const finish = async () => {
    for (;;) {
      finishAttempts += 1;
      if (!down() && Date.now() - lastLife >= 120_000) operation = 'failed';
      if (operation !== 'running') return true;
      if (finishAttempts > 40) throw new Error('LIVELOCK');
      await new Promise(resolve => setTimeout(resolve, 10_000));
    }
  };
  let stoppedAt = 0;
  const protectedProcess: NonNullable<
    Parameters<typeof runCatalogVariantRecovery>[0]['protectedProcess']
  > = async (request, _enroll, signal, _authorize, complete, cancellationRequested, ended) => {
    try {
      return await settleCatalogVariantProcess({
        operationId: request.operationId,
        signal,
        complete,
        cancellationRequested,
        ended,
        run: () =>
          new Promise((_, reject) =>
            signal.addEventListener('abort', () => {
              stoppedAt = Date.now();
              reject(new Error('PROCESS_CANCELED'));
            })
          )
      });
    } finally {
      await finish();
    }
  };
  const done = runCatalogVariantRecovery({
    nativeInstanceId: id(5),
    initialSetId: id(1),
    call,
    process: { process: vi.fn(), cancel: vi.fn() },
    protectedProcess,
    signal: new AbortController().signal
  }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  const outcome = await done;
  expect((outcome as Error).message).toBe('PROCESS_RESULT_UNCERTAIN');
  // The watchdog stopped the stitch inside the outage …
  expect(stoppedAt - start).toBeGreaterThanOrEqual(90_000);
  expect(stoppedAt - start).toBeLessThan(160_000);
  // … no heartbeat followed, even after the gateway came back …
  expect(heartbeats.every(at => at < stoppedAt)).toBe(true);
  // … so the takeover fired and finish was accepted, instead of looping.
  expect(operation).toBe('failed');
  expect(finishAttempts).toBeLessThan(40);
});
