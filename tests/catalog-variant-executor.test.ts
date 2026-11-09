import { expect, it, vi } from 'vitest';
import {
  CatalogVariantExecutor,
  type CatalogVariantSnapshot,
  type CatalogVariantAuthority
} from '../apps/agent/src/team-bridge/catalog-variant-executor';
const id = (n: number) => '47000000-0000-4000-8000-' + String(n).padStart(12, '0');
function fixture(count = 5) {
  let stored: CatalogVariantSnapshot = {
    setId: id(1),
    revision: 0,
    children: Array.from({ length: count }, (_, index) => ({
      index,
      requestId: id(10 + index),
      operationId: null,
      state: 'queued',
      outputId: null
    }))
  };
  const authority: CatalogVariantAuthority = {
    load: vi.fn(async () => structuredClone(stored)),
    save: vi.fn(async (rev, next) => {
      if (rev !== stored.revision) return false;
      stored = structuredClone(next);
      return true;
    }),
    reconcile: vi.fn(async () => ({ kind: 'unknown' as const })),
    admit: vi.fn(async c => ({ operationId: id(50 + c.index) })),
    execute: vi.fn(async c => ({ outputId: id(100 + c.index) }))
  };
  return { authority, read: () => stored, executor: new CatalogVariantExecutor(authority) };
}
it('registers five distinct outputs sequentially with persisted original identities and monotonic K/N', async () => {
  const x = fixture(),
    progress: number[] = [];
  const result = await x.executor.run(new AbortController().signal, k => progress.push(k));
  expect(result.children.map(c => c.outputId)).toEqual([100, 101, 102, 103, 104].map(id));
  expect(progress).toEqual([0, 1, 2, 3, 4, 5]);
  expect(x.authority.execute).toHaveBeenCalledTimes(5);
  await x.executor.run(new AbortController().signal);
  expect(x.authority.execute).toHaveBeenCalledTimes(5);
});
it('reconciles an unknown upload after restart without executing another copy', async () => {
  const x = fixture(1);
  vi.mocked(x.authority.execute).mockRejectedValueOnce(Error('lost reply'));
  await expect(x.executor.run(new AbortController().signal)).rejects.toThrow('lost reply');
  expect(x.read().children[0]!.state).toBe('unknown');
  vi.mocked(x.authority.reconcile).mockResolvedValueOnce({
    kind: 'registered',
    outputId: id(100),
    operationId: id(50)
  });
  const restarted = new CatalogVariantExecutor(x.authority);
  expect((await restarted.run(new AbortController().signal)).children[0]!.state).toBe('registered');
  expect(x.authority.execute).toHaveBeenCalledTimes(1);
});
it('does not restart an unknown upload without authoritative absence', async () => {
  const x = fixture(1);
  vi.mocked(x.authority.execute).mockRejectedValueOnce(Error('lost reply'));
  await expect(x.executor.run(new AbortController().signal)).rejects.toThrow();
  await expect(x.executor.run(new AbortController().signal)).rejects.toThrow(
    'PROCESS_RESULT_UNCERTAIN'
  );
  expect(x.authority.execute).toHaveBeenCalledTimes(1);
});
it('refuses work after a failed revision CAS', async () => {
  const x = fixture();
  vi.mocked(x.authority.save).mockResolvedValueOnce(false);
  await expect(x.executor.run(new AbortController().signal)).rejects.toThrow(
    'PROCESS_RESULT_UNCERTAIN'
  );
  expect(x.authority.execute).not.toHaveBeenCalled();
});
it('retains registered output when cancellation races with registration and starts no next child', async () => {
  const x = fixture(),
    controller = new AbortController();
  vi.mocked(x.authority.execute).mockImplementationOnce(async () => {
    controller.abort();
    return { outputId: id(100) };
  });
  await expect(x.executor.run(controller.signal)).rejects.toThrow('PROCESS_CANCELED');
  expect(x.read().children[0]!.state).toBe('registered');
  expect(x.authority.execute).toHaveBeenCalledTimes(1);
});
it('reports bounded registered progress without claiming catalog publication and ignores observer failure', async () => {
  const x = fixture(1),
    events: unknown[] = [];
  const executor = new CatalogVariantExecutor(x.authority, event => {
    events.push(event);
    if (event.stage === 'processing') throw Error('observer failed');
  });
  await executor.run(new AbortController().signal);
  expect(events).toContainEqual({
    setId: id(1),
    childRequestId: id(10),
    childOperationId: id(50),
    stage: 'registered',
    ready: 1,
    total: 1
  });
  expect(events).toContainEqual({ setId: id(1), stage: 'ready', ready: 1, total: 1 });
});
it('reads a lost admission acknowledgement by original request identity before any new process is started', async () => {
  const x = fixture(1);
  vi.mocked(x.authority.admit).mockRejectedValueOnce(Error('lost admission'));
  await expect(x.executor.run(new AbortController().signal)).rejects.toThrow('lost admission');
  expect(x.authority.execute).not.toHaveBeenCalled();
  vi.mocked(x.authority.reconcile).mockResolvedValueOnce({
    kind: 'registered',
    operationId: id(50),
    outputId: id(100)
  });
  await x.executor.run(new AbortController().signal);
  expect(x.authority.admit).toHaveBeenCalledTimes(1);
  expect(x.authority.execute).not.toHaveBeenCalled();
});

it('keeps unknown diagnostic causes bounded and separates request from admitted operation', async () => {
  const x = fixture(1),
    events: unknown[] = [];
  vi.mocked(x.authority.execute).mockRejectedValueOnce(
    Error('https://private-provider/path?token=secret')
  );
  const executor = new CatalogVariantExecutor(x.authority, event => events.push(event));
  await expect(executor.run(new AbortController().signal)).rejects.toThrow();
  expect(events).toContainEqual(
    expect.objectContaining({
      stage: 'unknown',
      childRequestId: id(10),
      childOperationId: id(50),
      errorCode: 'PROCESS_RESULT_UNCERTAIN'
    })
  );
  expect(JSON.stringify(events)).not.toContain('private-provider');
});
