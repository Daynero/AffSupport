// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useDurableLaunchBatches } from '../apps/web/src/team/launches/useDurableLaunchBatches.js';
import { batchCommand, batchReceipt, batchUuid } from './fixtures/launch-batches.js';
import { setPrivateCacheScope } from '../apps/web/src/team/private-cache-scope.js';
import { TeamApiError } from '../apps/web/src/api/team.js';
import type { DurableLaunchBatch, LaunchBatchCommand } from '@video-compressor/shared';
import { launchBatchAdmission } from '../apps/web/src/team/launches/analytics.js';
vi.mock('../apps/web/src/team/launches/analytics.js', () => ({
  launchBatchAdmission: vi.fn(),
  launchObservedGeneration: vi.fn()
}));
const client = { submit: vi.fn(), read: vi.fn(), list: vi.fn(), cancel: vi.fn() };
const empty = { items: [], hasMore: false, nextCursor: null };
const settled = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
function input(command: LaunchBatchCommand | null = batchCommand()) {
  return {
    teamId: batchUuid(1),
    actorId: batchUuid(2),
    command,
    reconcileEpoch: 0,
    enabled: true,
    onSubmitted: vi.fn(),
    onChanged: vi.fn(),
    client
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
  setPrivateCacheScope(batchUuid(2), 'team');
  client.read.mockResolvedValue(null);
  client.list.mockResolvedValue(empty);
  client.submit.mockImplementation(async command => batchReceipt(command));
  client.cancel.mockImplementation(async (_team, key) => ({
    ...batchReceipt(),
    requestKey: key,
    cancelRequestedAt: new Date().toISOString()
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setPrivateCacheScope(null, '');
});
it('recovers an applied acceptance with a lost reply after unmount, using stored opaque intent and protected readback', async () => {
  let accepted: DurableLaunchBatch | null = null;
  client.submit.mockImplementation(async command => {
    accepted = batchReceipt(command);
    throw new TypeError('offline');
  });
  const first = renderHook(useDurableLaunchBatches, { initialProps: input() });
  await settled();
  expect(first.result.current.pendingCommand).not.toBeNull();
  first.unmount();
  client.read.mockImplementation(async () => accepted);
  const next = renderHook(useDurableLaunchBatches, { initialProps: input(null) });
  await settled();
  expect(next.result.current.batches).toHaveLength(1);
  expect(next.result.current.pendingCommand).toBeNull();
  expect(client.submit).toHaveBeenCalledOnce();
});
it('replays identical immutable keys after an unavailable receipt resolves to absent, with paced retries', async () => {
  client.submit.mockRejectedValue(new TypeError('offline'));
  const props = input(),
    view = renderHook(useDurableLaunchBatches, { initialProps: props });
  await settled();
  client.read.mockRejectedValue(new TypeError('offline'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  view.rerender({ ...props, reconcileEpoch: 1 });
  await settled();
  expect(client.submit).toHaveBeenCalledOnce();
  client.read.mockResolvedValue(null);
  client.submit.mockImplementation(async command => batchReceipt(command));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20000);
  });
  view.rerender({ ...props, reconcileEpoch: 2 });
  await settled();
  expect(client.submit).toHaveBeenCalledTimes(2);
  expect(client.submit.mock.calls[0][0]).toEqual(client.submit.mock.calls[1][0]);
  expect(view.result.current.pendingCommand).toBeNull();
});
it('never submits after ownership changes during the protected absence read, including same actor signing back in', async () => {
  let release!: (value: null) => void;
  client.read.mockImplementation(
    () =>
      new Promise(r => {
        release = r;
      })
  );
  renderHook(useDurableLaunchBatches, { initialProps: input() });
  await settled();
  setPrivateCacheScope(null, '');
  setPrivateCacheScope(batchUuid(2), 'team');
  await act(async () => release(null));
  await settled();
  expect(client.submit).not.toHaveBeenCalled();
});
it('does not submit after permission is removed while reading the request', async () => {
  let release!: (value: null) => void;
  client.read.mockImplementation(
    () =>
      new Promise(r => {
        release = r;
      })
  );
  const props = input(),
    view = renderHook(useDurableLaunchBatches, { initialProps: props });
  await settled();
  view.rerender({ ...props, enabled: false });
  await act(async () => release(null));
  await settled();
  expect(client.submit).not.toHaveBeenCalled();
});
it('rejects a validly shaped but mismatched acceptance without losing the pending command', async () => {
  client.submit.mockResolvedValue({ ...batchReceipt(), requestKey: batchUuid(999) });
  const view = renderHook(useDurableLaunchBatches, { initialProps: input() });
  await settled();
  expect(view.result.current.batches).toEqual([]);
  expect(view.result.current.pendingCommand?.requestKey).toBe(batchUuid(3));
});
it('rejects a receipt with the same request but altered child membership/version', async () => {
  const receipt = batchReceipt();
  receipt.items[0].expectedVersion = '99';
  client.submit.mockResolvedValue(receipt);
  const view = renderHook(useDurableLaunchBatches, { initialProps: input() });
  await settled();
  expect(view.result.current.batches).toEqual([]);
  expect(view.result.current.pendingCommand).not.toBeNull();
});
it('does not regress canonical progress after a stale head read', async () => {
  const receipt = batchReceipt();
  receipt.items[0].generation!.stateVersion = '5';
  receipt.items[0].generation!.state = 'succeeded';
  client.list.mockResolvedValue({ ...empty, items: [receipt] });
  const props = input(null),
    view = renderHook(useDurableLaunchBatches, { initialProps: props });
  await settled();
  client.list.mockResolvedValue({ ...empty, items: [batchReceipt()] });
  view.rerender({ ...props, reconcileEpoch: 1 });
  await settled();
  expect(view.result.current.batches[0].items[0].generation?.state).toBe('succeeded');
});
it('bounds a hung receipt read and continues list observation without blindly submitting', async () => {
  client.read.mockImplementation(() => new Promise(() => {}));
  const view = renderHook(useDurableLaunchBatches, { initialProps: input() });
  await settled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15001);
  });
  expect(client.submit).not.toHaveBeenCalled();
  expect(client.list).toHaveBeenCalled();
  expect(view.result.current.reconnecting).toBe(true);
});
it('uses the same cancellation key after a lost reply and clears it only on a canonical receipt', async () => {
  const receipt = batchReceipt();
  client.list.mockResolvedValue({ ...empty, items: [receipt] });
  const props = input(null),
    view = renderHook(useDurableLaunchBatches, { initialProps: props });
  await settled();
  client.cancel.mockRejectedValueOnce(new TypeError('offline'));
  act(() => view.result.current.cancel(receipt));
  await settled();
  expect(view.result.current.canceling.size).toBe(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  view.rerender({ ...props, reconcileEpoch: 1 });
  await settled();
  expect(client.cancel).toHaveBeenCalledTimes(2);
  expect(client.cancel.mock.calls[0][2]).toBe(client.cancel.mock.calls[1][2]);
  expect(view.result.current.canceling.size).toBe(0);
});
it('keeps failed cancellation cleanup observable even if the parent generation is terminal', async () => {
  const receipt = batchReceipt(undefined, 'failed');
  receipt.items[0].cancelPending = true;
  receipt.items[0].cancelErrorCode = 'DRIVE_UNAVAILABLE';
  client.list.mockResolvedValue({ ...empty, items: [receipt] });
  const view = renderHook(useDurableLaunchBatches, { initialProps: input(null) });
  await settled();
  expect(view.result.current.pending).toBe(true);
});
it('restarts history traversal when new head batches would leave a gap before older loaded pages', async () => {
  const page = (n: number) => ({
    ...batchReceipt(batchCommand(1, n)),
    id: batchUuid(1000 + n),
    createdAt: new Date(Date.UTC(2026, 10, n)).toISOString()
  });
  const first = page(20),
    older = page(10),
    newest = page(30),
    gap = page(25);
  client.list.mockResolvedValue({
    items: [first],
    hasMore: true,
    nextCursor: { id: first.id, createdAt: first.createdAt }
  });
  const props = input(null),
    view = renderHook(useDurableLaunchBatches, { initialProps: props });
  await settled();
  client.list.mockResolvedValueOnce({ items: [older], hasMore: false, nextCursor: null });
  await act(async () => {
    await view.result.current.loadMore();
  });
  expect(view.result.current.hasMore).toBe(false);
  client.list.mockResolvedValue({
    items: [newest],
    hasMore: true,
    nextCursor: { id: newest.id, createdAt: newest.createdAt }
  });
  view.rerender({ ...props, reconcileEpoch: 1 });
  await settled();
  client.list.mockResolvedValueOnce({
    items: [gap, first, older],
    hasMore: false,
    nextCursor: null
  });
  await act(async () => {
    await view.result.current.loadMore();
  });
  expect(client.list.mock.calls.at(-1)?.[1]).toEqual({
    id: newest.id,
    createdAt: newest.createdAt
  });
  expect(view.result.current.batches.map(batch => batch.id)).toEqual([
    newest.id,
    gap.id,
    first.id,
    older.id
  ]);
});
it('settles definitive admission rejection without endless replay or pretending it succeeded', async () => {
  client.submit.mockRejectedValue(new TeamApiError('PERMISSION_DENIED', false));
  const props = input(),
    view = renderHook(useDurableLaunchBatches, { initialProps: props });
  await settled();
  expect(view.result.current.pendingCommand).toBeNull();
  expect(view.result.current.error).toBeInstanceOf(TeamApiError);
  expect(props.onSubmitted).toHaveBeenCalledOnce();
  view.rerender({ ...props, reconcileEpoch: 1 });
  await settled();
  expect(client.submit).toHaveBeenCalledOnce();
});

it('retains pending source preparation without a false failure, then observes its single acceptance', async () => {
  const receipt = batchReceipt();
  receipt.items[0] = {
    ...receipt.items[0],
    admission: 'pending',
    errorCode: 'DRIVE_UNAVAILABLE',
    generationId: null,
    generation: null
  };
  client.list.mockResolvedValue({ ...empty, items: [receipt] });
  const props = input(null),
    view = renderHook(useDurableLaunchBatches, { initialProps: props });
  await settled();
  expect(view.result.current.pending).toBe(true);
  expect(
    vi.mocked(launchBatchAdmission).mock.calls.filter(call => call[2] === receipt.items[0].launchId)
  ).toEqual([]);
  client.list.mockResolvedValue({ ...empty, items: [batchReceipt()] });
  view.rerender({ ...props, reconcileEpoch: 1 });
  await settled();
  view.rerender({ ...props, reconcileEpoch: 2 });
  await settled();
  expect(
    vi.mocked(launchBatchAdmission).mock.calls.filter(call => call[2] === receipt.items[0].launchId)
  ).toHaveLength(1);
  expect(view.result.current.batches[0].items[0].admission).toBe('accepted');
});

it('does not let two cancellations in backoff starve a third newly requested cancellation', async () => {
  const receipts = [3, 4, 5].map((key, index) => ({
    ...batchReceipt(batchCommand(1, key)),
    id: batchUuid(500 + index)
  }));
  client.list.mockResolvedValue({ ...empty, items: receipts });
  client.cancel.mockRejectedValue(new TypeError('offline'));
  const view = renderHook(useDurableLaunchBatches, { initialProps: input(null) });
  await settled();
  act(() => view.result.current.cancel(receipts[0]));
  await settled();
  act(() => view.result.current.cancel(receipts[1]));
  await settled();
  act(() => view.result.current.cancel(receipts[2]));
  await settled();
  expect(client.cancel.mock.calls.map(call => call[1])).toEqual(
    receipts.map(receipt => receipt.requestKey)
  );
});
