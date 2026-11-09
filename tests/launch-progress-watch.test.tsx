// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  useLaunchProgressWatch,
  LAUNCH_PROGRESS_QUIET_MS,
  LAUNCH_STATUS_READ_MS,
  LAUNCH_CANCEL_STATUS_POLL_MS
} from '../apps/web/src/team/launches/useLaunchProgressWatch';
import { readLaunchPreparation } from '../apps/web/src/team/launches/preparation';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('automatically reconciles unchanged stages without inventing progress', async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockResolvedValue(undefined);
  const { result, rerender } = renderHook(
    ({ evidence }) => useLaunchProgressWatch(true, evidence, read),
    { initialProps: { evidence: 'same-stage' } }
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LAUNCH_PROGRESS_QUIET_MS);
  });
  expect(read).toHaveBeenCalledTimes(3);
  expect(result.current.quiet).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LAUNCH_PROGRESS_QUIET_MS * 3);
  });
  expect(read).toHaveBeenCalledTimes(12);
  rerender({ evidence: 'new-authoritative-stage' });
  expect(result.current.quiet).toBe(false);
});

it('bounds a hung status read, aborts it, suppresses duplicate reads and allows retry', async () => {
  vi.useFakeTimers();
  const read = vi.fn((_signal: AbortSignal) => new Promise<void>(() => {}));
  const { result } = renderHook(() => useLaunchProgressWatch(true, 'stage', read));
  let first: Promise<void> = Promise.resolve();
  await act(async () => {
    first = result.current.refresh();
    await result.current.refresh();
  });
  expect(read).toHaveBeenCalledOnce();
  expect(result.current.checking).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LAUNCH_STATUS_READ_MS);
    await first;
  });
  expect(read.mock.calls[0][0].aborted).toBe(true);
  expect(result.current.checking).toBe(false);
  expect(result.current.readFailed).toBe(true);
  read.mockResolvedValueOnce(undefined);
  await act(async () => {
    await result.current.refresh();
  });
  expect(read).toHaveBeenCalledTimes(2);
  expect(result.current.readFailed).toBe(false);
});

it('discards an old read failure after a new generation replaces its evidence', async () => {
  vi.useFakeTimers();
  let fail: (error: Error) => void = () => {};
  const read = vi.fn(
    (_signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        fail = reject;
      })
  );
  const { result, rerender, unmount } = renderHook(
    ({ evidence }) => useLaunchProgressWatch(true, evidence, read),
    { initialProps: { evidence: 'old-run' } }
  );
  let pending: Promise<void> = Promise.resolve();
  await act(async () => {
    pending = result.current.refresh();
  });
  rerender({ evidence: 'new-run' });
  expect(read.mock.calls[0][0].aborted).toBe(true);
  await act(async () => {
    fail(new Error('old failure'));
    await pending;
  });
  expect(result.current.readFailed).toBe(false);
  expect(result.current.checking).toBe(false);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not let a late preflight read start generation after timeout or cancellation', async () => {
  vi.useFakeTimers();
  let resolve: (value: string) => void = () => {};
  const controller = new AbortController();
  const start = vi.fn();
  const pending = readLaunchPreparation(
    new Promise<string>(done => {
      resolve = done;
    }),
    controller.signal
  ).then(start);
  const rejection = expect(pending).rejects.toMatchObject({ reason: 'timeout' });
  await vi.advanceTimersByTimeAsync(15_000);
  await rejection;
  resolve('late');
  await Promise.resolve();
  expect(start).not.toHaveBeenCalled();
  const canceled = new AbortController();
  const next = readLaunchPreparation(new Promise<void>(() => {}), canceled.signal);
  const stopped = expect(next).rejects.toMatchObject({ reason: 'canceled' });
  canceled.abort();
  await stopped;
  expect(vi.getTimerCount()).toBe(0);
});

it('pauses automatic reads while hidden and stops them when the operation finishes', async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockResolvedValue(undefined);
  const visibility = vi.spyOn(document, 'visibilityState', 'get');
  visibility.mockReturnValue('hidden');
  const { rerender, unmount } = renderHook(
    ({ active }) => useLaunchProgressWatch(active, 'stage', read),
    { initialProps: { active: true } }
  );
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(read).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(read).toHaveBeenCalledOnce();
    rerender({ active: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(read).toHaveBeenCalledOnce();
  } finally {
    visibility.mockRestore();
    unmount();
  }
});

it('reads cancellation immediately and keeps its exact-generation cadence across changing progress evidence', async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockResolvedValue(undefined);
  const { rerender, unmount } = renderHook(
    ({ evidence, active, scope }) => useLaunchProgressWatch(active, evidence, read, scope),
    {
      initialProps: {
        evidence: 'cancel-requested',
        active: true,
        scope: 'team:original-generation' as string | undefined
      }
    }
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(read).toHaveBeenCalledOnce();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LAUNCH_CANCEL_STATUS_POLL_MS / 2);
  });
  rerender({ evidence: 'native-heartbeat-1', active: true, scope: 'team:original-generation' });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LAUNCH_CANCEL_STATUS_POLL_MS / 2);
  });
  expect(read).toHaveBeenCalledTimes(2);
  rerender({ evidence: 'confirmed-canceled', active: false, scope: undefined });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(read).toHaveBeenCalledTimes(2);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
