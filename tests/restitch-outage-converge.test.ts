import { afterEach, expect, it, vi } from 'vitest';
import { TeamOperationEvents } from '../apps/agent/src/team-bridge/events.js';
import {
  TeamProcessBridge,
  type TeamProcessDelegate,
  type TeamProcessTransfer
} from '../apps/agent/src/team-bridge/process.js';
import {
  mayHaveUploaded,
  settleCatalogVariantProcess
} from '../apps/agent/src/team-bridge/catalog-variant-closure';
import { runCatalogVariantRecovery } from '../apps/agent/src/team-bridge/catalog-variant-recovery';
import type { CatalogVariantSnapshot } from '../apps/agent/src/team-bridge/catalog-variant-executor';

/**
 * Beta 2026-11-11, set e1741a2a (gateway paused 150 s): the video was built
 * 8 s into the outage; the authorization read before the upload gave up after
 * ~65 s and the run ended PROCESS_RESULT_UNCERTAIN with nothing uploaded. That
 * stop was never reported, finish was refused while the operation ran, and only
 * the silence takeover (minutes later) settled it.
 */
afterEach(() => {
  vi.useRealTimers();
});
const grant = (purpose: 'process_input' | 'finalize') =>
  ({
    ticket: `opaque-${purpose}-ticket-with-enough-entropy`,
    purpose,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxRangeBytes: 4,
    maxUses: 8
  }) as const;
function protectedRun(options: { authorize: () => Promise<void>; upload?: () => Promise<never> }) {
  const transfer: TeamProcessTransfer = {
    downloadSource: vi.fn().mockResolvedValue({
      workspace: '/tmp/converge',
      file: '/tmp/converge/source',
      sizeBytes: 6,
      sourceVersion: '1',
      sourceChecksum: 'check',
      cleanup: vi.fn().mockResolvedValue(undefined)
    }),
    uploadResult: vi.fn(options.upload ?? (async () => Promise.reject(new Error('unexpected'))))
  };
  const delegate: TeamProcessDelegate = vi.fn().mockResolvedValue({
    file: '/tmp/converge/output',
    mimeType: 'video/mp4',
    sizeBytes: 6,
    cleanup: vi.fn().mockResolvedValue(undefined)
  });
  const bridge = new TeamProcessBridge({
    transfer,
    delegates: {},
    events: new TeamOperationEvents()
  });
  return {
    transfer,
    run: bridge.processProtected(
      {
        operationId: 'operation-converge',
        toolId: 'restitch',
        options: {},
        sourceGrant: grant('process_input'),
        finalizeGrant: grant('finalize'),
        transferUrl: 'https://project.supabase.co/functions/v1/drive-transfer/range',
        cloudBaseUrl: 'https://project.supabase.co/functions/v1/drive-ops'
      },
      {
        transfer,
        delegate,
        signal: new AbortController().signal,
        authorize: vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockResolvedValueOnce(undefined)
          .mockImplementation(options.authorize)
      }
    )
  };
}

it('a run that failed before its upload says so, whatever its code', async () => {
  const f = protectedRun({
    authorize: async () => {
      throw new Error('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
    }
  });
  const error = await f.run.catch((cause: unknown) => cause);
  expect(f.transfer.uploadResult).not.toHaveBeenCalled();
  expect(mayHaveUploaded(error)).toBe(false);
});

it('a run that failed inside its upload may have produced output', async () => {
  const f = protectedRun({
    authorize: async () => undefined,
    upload: async () => Promise.reject(new Error('DRIVE_UNAVAILABLE'))
  });
  const error = await f.run.catch((cause: unknown) => cause);
  expect(f.transfer.uploadResult).toHaveBeenCalledOnce();
  expect(mayHaveUploaded(error)).toBe(true);
});

const preUpload = (code: string) =>
  Object.assign(new Error(code), { uploadStarted: false as const });
const id = (n: number) => '47346100-0000-4000-8000-' + String(n).padStart(12, '0');

it('reports an uncertain failure before upload instead of leaving it to the takeover', async () => {
  const complete = vi
    .fn<() => Promise<Record<string, unknown>>>()
    .mockRejectedValueOnce(new Error('PROCESS_RESULT_UNCERTAIN'))
    .mockResolvedValue({ operationId: id(3), kind: 'terminal', state: 'failed' });
  await expect(
    settleCatalogVariantProcess({
      operationId: id(3),
      signal: new AbortController().signal,
      run: async () => {
        throw preUpload('PROCESS_RESULT_UNCERTAIN');
      },
      complete,
      reportDelaysMs: [1]
    })
  ).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  expect(complete).toHaveBeenCalledTimes(2);
  expect(complete).toHaveBeenLastCalledWith('failed', 'PROCESS_FAILED');
});

it('reports a watchdog stop before upload once the server answers', async () => {
  const stop = new AbortController();
  stop.abort(new Error('PROCESS_RESULT_UNCERTAIN'));
  const complete = vi.fn(async () => ({ operationId: id(3), kind: 'terminal', state: 'failed' }));
  await expect(
    settleCatalogVariantProcess({
      operationId: id(3),
      signal: stop.signal,
      run: async () => {
        throw preUpload('PROCESS_RESULT_UNCERTAIN');
      },
      complete
    })
  ).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  expect(complete).toHaveBeenCalledWith('failed', 'PROCESS_FAILED');
});

it('still never reports an uncertain failure once the upload may have begun', async () => {
  const complete = vi.fn();
  await expect(
    settleCatalogVariantProcess({
      operationId: id(3),
      signal: new AbortController().signal,
      run: async () => {
        throw Object.assign(new Error('PROCESS_RESULT_UNCERTAIN'), { uploadStarted: true });
      },
      complete
    })
  ).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  expect(complete).not.toHaveBeenCalled();
});

it('converges within seconds of the gateway returning: the exact e1741a2a sequence', async () => {
  vi.useFakeTimers();
  let snapshot: CatalogVariantSnapshot = {
    setId: id(1),
    revision: 0,
    children: [{ index: 0, requestId: id(2), operationId: null, state: 'queued', outputId: null }]
  };
  const start = Date.now();
  // Gateway down from 17 s to 167 s (14:07:44–14:10:14 against a 14:07:27 start).
  const down = () => Date.now() - start >= 17_000 && Date.now() - start < 167_000;
  const lost = () => new Error('PROCESS_RESULT_UNCERTAIN');
  let operation: 'running' | 'failed' = 'running';
  let reportedAt = 0;
  const call = vi.fn(
    async (action: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (action === 'variant_load') return snapshot as unknown as Record<string, unknown>;
      if (action === 'variant_save') {
        if (down()) throw lost();
        snapshot = structuredClone(body.snapshot) as CatalogVariantSnapshot;
        return { saved: true };
      }
      if (action === 'variant_reconcile') return { kind: 'absent' };
      if (action === 'variant_admit') return { operationId: id(3) };
      if (action === 'variant_dispatch') return { executionAllowed: true };
      if (action === 'variant_heartbeat') {
        if (down()) throw lost();
        return { continue: true, registered: false };
      }
      if (action === 'variant_complete') {
        if (down()) throw lost();
        operation = 'failed';
        reportedAt = Date.now();
        return { operationId: id(3), kind: 'terminal', state: 'failed' };
      }
      if (action === 'variant_process')
        return {
          operationId: id(3),
          state: 'running',
          agentContractVersion: 1,
          sourceGrant: { ...grant('process_input'), purpose: 'process_input' },
          finalizeGrant: { ...grant('finalize'), purpose: 'finalize' },
          transferUrl: 'http://127.0.0.1:54321/functions/v1/drive-transfer/range',
          cloudBaseUrl: 'http://127.0.0.1:54321/functions/v1/drive-ops',
          options: { restitchSelectionRootId: id(9), teamId: id(8) }
        };
      throw new Error('unexpected action ' + action);
    }
  );
  let finishedAt = 0;
  const finish = async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (!down() && operation !== 'running') {
        finishedAt = Date.now();
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 10_000));
    }
    throw new Error('LIVELOCK');
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
          // Built 8 s into the outage; authorization before upload lost for 65 s.
          await new Promise(resolve => setTimeout(resolve, 25_000 + 65_000));
          throw preUpload('PROCESS_RESULT_UNCERTAIN');
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
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect((await done) as Error).toBeInstanceOf(Error);
  expect(operation).toBe('failed');
  // Reported and finished within a minute of the gateway's return, not by the
  // takeover two minutes after silence nor by the 15-minute sweep.
  expect(reportedAt - start).toBeGreaterThanOrEqual(167_000);
  expect(reportedAt - start).toBeLessThan(167_000 + 60_000);
  expect(finishedAt - start).toBeLessThan(167_000 + 60_000);
});
