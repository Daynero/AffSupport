// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  useLaunchProgressWatch,
  LAUNCH_PROGRESS_QUIET_MS,
  LAUNCH_STATUS_READ_MS
} from '../apps/web/src/team/launches/useLaunchProgressWatch';
import { readLaunchPreparation } from '../apps/web/src/team/launches/preparation';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('reconciles a quiet stage once without advancing it or starting recurring polling', async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockResolvedValue(undefined);
  const { result, rerender } = renderHook(
    ({ evidence }) => useLaunchProgressWatch(true, evidence, read),
    { initialProps: { evidence: 'same-stage' } }
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LAUNCH_PROGRESS_QUIET_MS);
  });
  expect(read).toHaveBeenCalledOnce();
  expect(result.current.quiet).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LAUNCH_PROGRESS_QUIET_MS * 3);
  });
  expect(read).toHaveBeenCalledOnce();
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
