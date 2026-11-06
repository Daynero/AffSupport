import { expect, it, vi } from 'vitest';
import { CatalogCommandCoordinator } from '../apps/web/src/team/catalog-updater/catalogCommandCoordinator';
const id = (n: number) => `47000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const intent = { commandId: id(1), catalogIds: [id(2)], createdAt: 1 };
const accepted = {
  commandId: id(1),
  kind: 'run',
  status: 'accepted',
  sourceAttemptId: null,
  requestedCount: 1,
  acceptedCount: 1,
  items: [{ catalogId: id(2), accepted: true, attemptId: id(3), reason: 'accepted' }]
};
function harness(overrides: Record<string, unknown> = {}) {
  const records = new Map();
  const request = vi.fn().mockRejectedValue(new TypeError('lost reply'));
  const read = vi.fn().mockResolvedValue(null);
  const cancel = vi.fn().mockResolvedValue(null);
  const changed = vi.fn();
  const deps = {
    journal: {
      list: () => [...records.values()],
      put: (value: typeof intent) => records.set(value.commandId, value),
      remove: (key: string) => records.delete(key)
    },
    request,
    read,
    cancel,
    wait: async <T>(work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) => work(signal),
    definiteRejection: () => false,
    isCurrent: () => true,
    changed,
    ...overrides
  };
  const coordinator = new CatalogCommandCoordinator(deps);
  return { coordinator, records, request, read, cancel, changed };
}
it('retains lost replies and only reads during subsequent reconciliation', async () => {
  const h = harness();
  expect((await h.coordinator.submit(intent)).kind).toBe('unknown');
  expect(h.coordinator.blocked(id(2))).toBe(true);
  expect((await h.coordinator.reconcile(id(1))).kind).toBe('unknown');
  h.read.mockResolvedValue(accepted);
  expect((await h.coordinator.reconcile(id(1))).kind).toBe('confirmed');
  expect(h.request).toHaveBeenCalledTimes(1);
  expect(h.records.size).toBe(0);
});
it('blocks overlapping commands synchronously', async () => {
  let release!: (value: unknown) => void;
  const request = vi.fn(
    () =>
      new Promise(resolve => {
        release = resolve;
      })
  );
  const h = harness({ request });
  const first = h.coordinator.submit(intent);
  expect((await h.coordinator.submit({ ...intent, commandId: id(4) })).kind).toBe('rejected');
  expect(request).toHaveBeenCalledTimes(1);
  release(accepted);
  expect((await first).kind).toBe('confirmed');
});
it('retains pending identity and suppresses settlement after disposal', async () => {
  let release!: (value: unknown) => void;
  const h = harness({
    request: () =>
      new Promise(resolve => {
        release = resolve;
      })
  });
  const first = h.coordinator.submit(intent);
  h.coordinator.dispose();
  const changes = h.changed.mock.calls.length;
  release(accepted);
  expect((await first).kind).toBe('obsolete');
  expect(h.changed).toHaveBeenCalledTimes(changes);
  expect(h.records.size).toBe(1);
});
it('checks the global actor epoch before dispatch even before React cleanup', async () => {
  let current = true;
  const h = harness({
    isCurrent: () => current,
    changed: () => {
      current = false;
    }
  });
  expect((await h.coordinator.submit(intent)).kind).toBe('obsolete');
  expect(h.request).not.toHaveBeenCalled();
  expect(h.records.size).toBe(1);
});
it('fails closed before writing when durable storage refuses the intent', async () => {
  const h = harness({
    journal: {
      list: () => [],
      put: () => {
        throw new Error('quota');
      },
      remove: () => {}
    }
  });
  expect((await h.coordinator.submit(intent)).kind).toBe('rejected');
  expect(h.request).not.toHaveBeenCalled();
});
it('does not trust malformed acknowledgement or remove its pending identity', async () => {
  const h = harness({ request: async () => ({ ...accepted, commandId: id(9) }) });
  expect((await h.coordinator.submit(intent)).kind).toBe('unknown');
  expect(h.records.size).toBe(1);
});
it('seals an unaccepted intent without creating a different command', async () => {
  const cancelled = {
    ...accepted,
    status: 'cancelled',
    acceptedCount: 0,
    items: [
      { catalogId: id(2), accepted: false, attemptId: null, reason: 'cancelled_before_acceptance' }
    ]
  };
  const h = harness({ cancel: async () => cancelled });
  await h.coordinator.submit(intent);
  expect(await h.coordinator.cancel(id(1))).toMatchObject({
    kind: 'confirmed',
    receipt: { status: 'cancelled' }
  });
  expect(h.request).toHaveBeenCalledTimes(1);
  expect(h.records.size).toBe(0);
});
it('bounds independent work at four and never turns a read failure into a write', async () => {
  const resolvers: Array<(value: unknown) => void> = [];
  const h = harness({ request: () => new Promise(resolve => resolvers.push(resolve)) });
  const pending = Array.from({ length: 4 }, (_, n) =>
    h.coordinator.submit({ commandId: id(10 + n), catalogIds: [id(20 + n)], createdAt: 1 })
  );
  expect(
    (await h.coordinator.submit({ commandId: id(30), catalogIds: [id(31)], createdAt: 1 })).kind
  ).toBe('rejected');
  resolvers.forEach(resolve => resolve(null));
  await Promise.all(pending);
  expect(h.records.size).toBe(4);
});

it('bounds an acknowledgement without claiming that its late server write was cancelled', async () => {
  const { withCatalogCommandDeadline } =
    await import('../apps/web/src/team/catalog-updater/catalogCommandCoordinator');
  vi.useFakeTimers();
  let release!: (value: string) => void;
  const remote = new Promise<string>(resolve => {
    release = resolve;
  });
  let signal!: AbortSignal;
  const pending = withCatalogCommandDeadline(child => {
    signal = child;
    return remote;
  }, new AbortController().signal);
  const assertion = expect(pending).rejects.toMatchObject({ code: 'PROCESS_RESULT_UNCERTAIN' });
  await vi.advanceTimersByTimeAsync(15_000);
  await assertion;
  expect(signal.aborted).toBe(true);
  release('late acknowledgement');
  await Promise.resolve();
  vi.useRealTimers();
});

it('binds a retained command independently of later caller-array mutation', async () => {
  let release!: (value: unknown) => void;
  const h = harness({
    request: () =>
      new Promise(resolve => {
        release = resolve;
      })
  });
  const input = { ...intent, catalogIds: [id(2)] };
  const pending = h.coordinator.submit(input);
  input.catalogIds[0] = id(9);
  const originalBlocked = h.coordinator.blocked(id(2));
  const unrelatedBlocked = h.coordinator.blocked(id(9));
  release(accepted);
  const result = await pending;
  expect(originalBlocked).toBe(true);
  expect(unrelatedBlocked).toBe(false);
  expect(result.kind).toBe('confirmed');
});
