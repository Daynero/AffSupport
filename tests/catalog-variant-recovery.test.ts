import { expect, it, vi } from 'vitest';
import { runCatalogVariantRecovery } from '../apps/agent/src/team-bridge/catalog-variant-recovery';
import type { CatalogVariantSnapshot } from '../apps/agent/src/team-bridge/catalog-variant-executor';
import {
  HEARTBEAT_RETRY_MS,
  HEARTBEAT_STALL_MS
} from '../apps/agent/src/team-bridge/heartbeat-tolerance';
const id = (n: number) => '47000000-0000-4000-8000-' + String(n).padStart(12, '0');
it('routes library variants through trusted per-I/O parent authority and preserves the original operation', async () => {
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
  const call = vi.fn(
    async (action: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (action === 'variant_claim') return { setId: id(1) };
      if (action === 'variant_load') return snapshot as unknown as Record<string, unknown>;
      if (action === 'variant_save') {
        snapshot = structuredClone(body.snapshot) as CatalogVariantSnapshot;
        return { saved: true };
      }
      if (action === 'variant_reconcile') return { kind: 'absent' };
      if (action === 'variant_admit') return { operationId: id(3) };
      if (action === 'variant_dispatch') return { executionAllowed: true };
      if (action === 'variant_authorize') return { authorized: true };
      if (action === 'variant_process')
        return {
          operationId: id(3),
          state: 'running',
          agentContractVersion: 1,
          sourceGrant: { ...grant, purpose: 'process_input' },
          finalizeGrant: { ...grant, purpose: 'finalize' },
          transferUrl: 'http://127.0.0.1:54321/functions/v1/drive-transfer/range',
          cloudBaseUrl: 'http://127.0.0.1:54321/functions/v1/drive-ops',
          options: { restitchSelectionRootId: null }
        };
      throw new Error('unexpected action');
    }
  );
  const generic = vi.fn();
  const protectedProcess = vi.fn<
    NonNullable<Parameters<typeof runCatalogVariantRecovery>[0]['protectedProcess']>
  >(async (request, _enroll, _signal, authorize) => {
    await authorize();
    return {
      operationId: request.operationId,
      state: 'succeeded' as const,
      materialId: id(4),
      reused: false
    };
  });
  expect(
    await runCatalogVariantRecovery({
      nativeInstanceId: id(5),
      call,
      process: { process: generic, cancel: vi.fn() },
      protectedProcess,
      signal: new AbortController().signal
    })
  ).toBe(id(1));
  expect(generic).not.toHaveBeenCalled();
  expect(protectedProcess).toHaveBeenCalledOnce();
  expect(call.mock.calls.map(c => c[0])).toContain('variant_authorize');
  expect(snapshot.children[0]).toMatchObject({
    requestId: id(2),
    operationId: id(3),
    outputId: id(4),
    state: 'registered'
  });
});

async function activeCpu(mode: 'canceled' | 'unknown' | 'registered' | 'flaky' | 'denied') {
  const { RECOVERY_BUDGET } = await import('@video-compressor/shared');
  const { settleCatalogVariantProcess } =
    await import('../apps/agent/src/team-bridge/catalog-variant-closure');
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
  const timeline: string[] = [];
  let release!: () => void,
    cleaned = false,
    heartbeats = 0;
  const call = vi.fn(
    async (action: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (action === 'variant_claim') return { setId: id(1) };
      if (action === 'variant_load') return snapshot as unknown as Record<string, unknown>;
      if (action === 'variant_save') {
        snapshot = structuredClone(body.snapshot) as CatalogVariantSnapshot;
        return { saved: true };
      }
      if (action === 'variant_reconcile') return { kind: 'absent' };
      if (action === 'variant_admit') return { operationId: id(3) };
      if (action === 'variant_dispatch') return { executionAllowed: true };
      if (action === 'variant_heartbeat') {
        if (mode === 'unknown') throw new Error('https://private-provider/?token=secret');
        if (mode === 'denied') throw new Error('PERMISSION_DENIED');
        if (mode === 'flaky') {
          heartbeats++;
          // Gateway 499 / an isolate at its limit: no JSON, then recovery.
          if (heartbeats <= 2) throw new Error('PROCESS_RESULT_UNCERTAIN');
          return { continue: true, registered: false };
        }
        return mode === 'registered'
          ? { continue: true, registered: true }
          : { continue: false, registered: false, reason: 'canceled' };
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
          options: {}
        };
      throw new Error('unexpected action');
    }
  );
  const closureCall = vi.fn(async () => {
    expect(cleaned).toBe(true);
    timeline.push('server_complete');
    return { kind: 'terminal', state: 'canceled', operationId: id(3) };
  });
  const protectedProcess = vi.fn<
    NonNullable<Parameters<typeof runCatalogVariantRecovery>[0]['protectedProcess']>
  >(async (request, _enroll, signal, _authorize, complete) =>
    settleCatalogVariantProcess({
      operationId: request.operationId,
      signal,
      complete,
      run: async () => {
        timeline.push('cpu');
        try {
          await new Promise<void>((resolve, reject) => {
            release = resolve;
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
          return { operationId: id(3), state: 'succeeded', materialId: id(4), reused: false };
        } finally {
          await Promise.resolve();
          cleaned = true;
          timeline.push('cleanup');
        }
      }
    })
  );
  const result = runCatalogVariantRecovery({
    nativeInstanceId: id(5),
    call,
    closureCall,
    process: { process: vi.fn(), cancel: vi.fn() },
    protectedProcess,
    signal: new AbortController().signal
  }).then(
    value => ({ value, error: null }),
    error => ({ value: null, error: error as Error })
  );
  await vi.waitFor(() => expect(protectedProcess).toHaveBeenCalledOnce());
  return {
    result,
    call,
    closureCall,
    timeline,
    release: () => release(),
    read: () => snapshot,
    budget: RECOVERY_BUDGET
  };
}
it('heartbeat promptly cancels CPU and completes only after the original bridge cleanup', async () => {
  vi.useFakeTimers();
  try {
    const f = await activeCpu('canceled');
    await vi.advanceTimersByTimeAsync(f.budget.heartbeatMs);
    expect((await f.result).error?.message).toBe('PROCESS_CANCELED');
    expect(f.timeline).toEqual(['cpu', 'cleanup', 'server_complete']);
    expect(f.closureCall).toHaveBeenCalledOnce();
    expect(f.read().children[0]?.operationId).toBe(id(3));
    expect(f.call.mock.calls.filter(call => call[0] === 'variant_admit')).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});
it('authorization uncertainty drains CPU but retains the unknown original execution without claiming user cancellation', async () => {
  vi.useFakeTimers();
  try {
    const f = await activeCpu('unknown');
    // A heartbeat lost in transport is retried; the stitch keeps running until
    // 90 s pass without one success, well inside the server's 2-minute takeover.
    await vi.advanceTimersByTimeAsync(f.budget.heartbeatMs * 2);
    expect(f.timeline).toEqual(['cpu']);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_STALL_MS - f.budget.heartbeatMs * 2);
    expect((await f.result).error?.message).toBe('PROCESS_RESULT_UNCERTAIN');
    expect(f.timeline).toEqual(['cpu', 'cleanup']);
    expect(f.closureCall).not.toHaveBeenCalled();
    expect(f.read().children[0]).toMatchObject({
      operationId: id(3),
      requestId: id(2),
      state: 'unknown'
    });
    const sent = f.call.mock.calls.filter(call => call[0] === 'variant_heartbeat').length;
    expect(sent).toBeGreaterThanOrEqual(3);
    await vi.advanceTimersByTimeAsync(f.budget.heartbeatMs * 3);
    expect(f.call.mock.calls.filter(call => call[0] === 'variant_heartbeat')).toHaveLength(sent);
  } finally {
    vi.useRealTimers();
  }
});
it('a heartbeat that fails in transport under load is retried and the stitch finishes', async () => {
  // Beta 2026-11-11, set a0f1fd63: one heartbeat timed out at the gateway and
  // 1.4.2 aborted its own stitch, leaving the variant unknown and its operation running.
  vi.useFakeTimers();
  try {
    const f = await activeCpu('flaky');
    await vi.advanceTimersByTimeAsync(f.budget.heartbeatMs + 2 * HEARTBEAT_RETRY_MS);
    expect(f.call.mock.calls.filter(call => call[0] === 'variant_heartbeat')).toHaveLength(3);
    // Recovered: the 90 s watchdog was re-armed by the success and never fires.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_STALL_MS * 2);
    expect(f.timeline).toEqual(['cpu']);
    f.release();
    expect((await f.result).error).toBeNull();
    expect(f.read().children[0]).toMatchObject({ outputId: id(4), state: 'registered' });
  } finally {
    vi.useRealTimers();
  }
});
it('a definitive refusal on a heartbeat still stops the stitch at once', async () => {
  vi.useFakeTimers();
  try {
    const f = await activeCpu('denied');
    await vi.advanceTimersByTimeAsync(f.budget.heartbeatMs);
    expect((await f.result).error?.message).toBe('PROCESS_RESULT_UNCERTAIN');
    expect(f.call.mock.calls.filter(call => call[0] === 'variant_heartbeat')).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});
it('an original registered result wins a late cancel observation and starts no replacement operation', async () => {
  vi.useFakeTimers();
  try {
    const f = await activeCpu('registered');
    await vi.advanceTimersByTimeAsync(f.budget.heartbeatMs);
    f.release();
    expect((await f.result).error).toBeNull();
    expect(f.read().children[0]).toMatchObject({
      operationId: id(3),
      outputId: id(4),
      state: 'registered'
    });
    expect(f.closureCall).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it('uses the agent backend origin for variant transfer URLs, never the server-reported loopback one', async () => {
  // Production 1.4.1: team-recovery issued http://127.0.0.1:54321 URLs, the native
  // source guard rejected them locally and every restitch failed at "downloading"
  // with PERMISSION_DENIED before any request reached drive-transfer.
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
  const call = vi.fn(
    async (action: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (action === 'variant_claim') return { setId: id(1) };
      if (action === 'variant_load') return snapshot as unknown as Record<string, unknown>;
      if (action === 'variant_save') {
        snapshot = structuredClone(body.snapshot) as CatalogVariantSnapshot;
        return { saved: true };
      }
      if (action === 'variant_reconcile') return { kind: 'absent' };
      if (action === 'variant_admit') return { operationId: id(3) };
      if (action === 'variant_dispatch') return { executionAllowed: true };
      if (action === 'variant_authorize') return { authorized: true };
      if (action === 'variant_process')
        return {
          operationId: id(3),
          state: 'running',
          agentContractVersion: 1,
          sourceGrant: { ...grant, purpose: 'process_input' },
          finalizeGrant: { ...grant, purpose: 'finalize' },
          transferUrl: 'http://127.0.0.1:54321/functions/v1/drive-transfer/range',
          cloudBaseUrl: 'http://127.0.0.1:54321/functions/v1/drive-ops',
          options: { restitchSelectionRootId: id(6) }
        };
      throw new Error('unexpected action');
    }
  );
  const seen: Array<{ transferUrl: string; cloudBaseUrl: string }> = [];
  const protectedProcess = vi.fn<
    NonNullable<Parameters<typeof runCatalogVariantRecovery>[0]['protectedProcess']>
  >(async request => {
    seen.push({ transferUrl: request.transferUrl, cloudBaseUrl: request.cloudBaseUrl });
    return {
      operationId: request.operationId,
      state: 'succeeded' as const,
      materialId: id(4),
      reused: false
    };
  });
  await runCatalogVariantRecovery({
    nativeInstanceId: id(5),
    functionsBase: 'https://yvvvignywfmbdgkcxtfk.supabase.co/functions/v1',
    call,
    process: { process: vi.fn(), cancel: vi.fn() },
    protectedProcess,
    signal: new AbortController().signal
  });
  expect(seen).toEqual([
    {
      transferUrl: 'https://yvvvignywfmbdgkcxtfk.supabase.co/functions/v1/drive-transfer/range',
      cloudBaseUrl: 'https://yvvvignywfmbdgkcxtfk.supabase.co/functions/v1/drive-ops'
    }
  ]);
});
