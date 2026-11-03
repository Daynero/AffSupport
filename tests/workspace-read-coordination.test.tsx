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
