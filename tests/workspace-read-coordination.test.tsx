// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useScopedRefresh } from '../apps/web/src/team/useScopedRefresh';
import { createReadCoordinator } from '../apps/web/src/team/readCoordinator';
import { deferred } from './fixtures/catalog-sync';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('coalesces 100 signals and retains a signal arriving during the follow-up', async () => {
  const first = deferred<void>();
  const second = deferred<void>();
  const read = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockResolvedValue(undefined);
  const owner = createReadCoordinator(read);
  const pending = owner.request();
  for (let i = 0; i < 100; i++) void owner.request();
  expect(read).toHaveBeenCalledTimes(1);
  first.resolve();
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(2);
  void owner.request();
  second.resolve();
  await pending;
  expect(read).toHaveBeenCalledTimes(3);
  owner.stop();
});

it('stops hidden polling and performs one visible catch-up', async () => {
  vi.useFakeTimers();
  let visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
    () => visibility as DocumentVisibilityState
  );
  const load = vi.fn().mockResolvedValue('current');
  renderHook(() => useScopedRefresh({ scope: 'a', load, revision: 0, intervalMs: 1000 }));
  await act(async () => {});
  expect(load).toHaveBeenCalledTimes(1);
  visibility = 'hidden';
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => vi.advanceTimersByTimeAsync(100_000));
  expect(load).toHaveBeenCalledTimes(1);
  visibility = 'visible';
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(load).toHaveBeenCalledTimes(2);
});

it('aborts an obsolete scope and never exposes its late response', async () => {
  const old = deferred<string>();
  let oldSignal: AbortSignal | undefined;
  const load = vi.fn((signal: AbortSignal) => {
    if (load.mock.calls.length === 1) {
      oldSignal = signal;
      return old.promise;
    }
    return Promise.resolve('new');
  });
  const view = renderHook(({ scope }) => useScopedRefresh({ scope, load, revision: 0 }), {
    initialProps: { scope: 'old' }
  });
  await act(async () => {});
  view.rerender({ scope: 'new' });
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => {});
  expect(view.result.current.value).toBe('new');
  await act(async () => old.resolve('private old'));
  expect(view.result.current.value).toBe('new');
});

it('releases a stalled read at its deadline, ignores its late result and recovers', async () => {
  vi.useFakeTimers();
  const stalled = deferred<string>();
  const load = vi.fn().mockReturnValueOnce(stalled.promise).mockResolvedValue('recovered');
  const view = renderHook(() =>
    useScopedRefresh({ scope: 'a', load, revision: 0, intervalMs: 60_000 })
  );
  await act(async () => {});
  const signal = load.mock.calls[0]![0] as AbortSignal;
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(signal.aborted).toBe(true);
  expect(view.result.current.error).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  await act(async () => view.result.current.reload());
  expect(view.result.current.value).toBe('recovered');
  await act(async () => stalled.resolve('obsolete'));
  expect(view.result.current.value).toBe('recovered');
});

it('foreground catch-up bypasses an old failure backoff exactly once', async () => {
  let visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
    () => visibility as DocumentVisibilityState
  );
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error('unavailable'))
    .mockResolvedValue('recovered');
  const view = renderHook(() => useScopedRefresh({ scope: 'a', load, revision: 0 }));
  await act(async () => {});
  expect(view.result.current.error).toBe(true);
  visibility = 'hidden';
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  visibility = 'visible';
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(load).toHaveBeenCalledTimes(2);
  expect(view.result.current.value).toBe('recovered');
});

it('returns the final canonical value of a coalesced batch and no value after retirement', async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const owner = createReadCoordinator<string>(read);
  const pending = owner.request();
  void owner.request();
  first.resolve('older');
  await Promise.resolve();
  second.resolve('canonical');
  expect(await pending).toBe('canonical');
  owner.stop();
  expect(await owner.request()).toBeUndefined();
});

it('confirms its post-invocation read without waiting for future continuous signals', async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  const third = deferred<string>();
  const reads = [first, second, third];
  let index = 0;
  const strictReads: boolean[] = [];
  const owner: ReturnType<typeof createReadCoordinator<string>> = createReadCoordinator(
    async () => {
      strictReads.push(owner.hasFreshRequests());
      return reads[index++]!.promise;
    }
  );
  const draining = owner.request();
  const confirmed = owner.requestFresh();
  first.resolve('before invocation');
  await vi.waitFor(() => expect(index).toBe(2));
  void owner.request();
  second.resolve('confirmed');
  expect(await confirmed).toBe('confirmed');
  expect(index).toBe(3);
  expect(strictReads).toEqual([false, true, false]);
  const laterFailure = new Error('later background failure');
  third.reject(laterFailure);
  await expect(draining).rejects.toBe(laterFailure);
  expect(await confirmed).toBe('confirmed');
});

it('does not hide a failed confirmation behind a later successful background read', async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  const failure = new Error('confirmation failed');
  const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const owner = createReadCoordinator<string>(read);
  const confirmed = owner.requestFresh();
  const rejected = expect(confirmed).rejects.toBe(failure);
  const later = owner.request();
  first.reject(failure);
  await rejected;
  second.resolve('later recovery');
  expect(await later).toBe('later recovery');
});

it('confirms only a registry read begun after the fresh request', async () => {
  const old = deferred<string>();
  const fresh = deferred<string>();
  const load = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const view = renderHook(() => useScopedRefresh({ scope: 'a', load, revision: 0 }));
  await act(async () => {});
  let confirmed = false;
  let pending!: Promise<boolean>;
  act(() => {
    pending = view.result.current.reloadFresh().then(value => {
      confirmed = value;
      return value;
    });
  });
  await act(async () => old.resolve('before acceptance'));
  expect(confirmed).toBe(false);
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => {
    fresh.resolve('after acceptance');
    await pending;
  });
  expect(confirmed).toBe(true);
  expect(view.result.current.value).toBe('after acceptance');
});
