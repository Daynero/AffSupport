// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { LaunchGeneration } from '../packages/shared/src/team/launches';
import { useLaunchElapsed } from '../apps/web/src/team/launches/useLaunchElapsed';
const generation = { id: 'gen', attemptNo: 1 } as LaunchGeneration;
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.useRealTimers();
});
it('keeps one clock through preparation, acceptance, new child and catalog stages, then freezes on failure', async () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook(
    ({ gen, pending, active }) => useLaunchElapsed('launch', gen, pending, active),
    {
      initialProps: { gen: null as LaunchGeneration | null, pending: true, active: true }
    }
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  rerender({ gen: generation, pending: false, active: true });
  expect(result.current).toBe('00:05');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  rerender({
    gen: { ...generation, restitchOperationId: 'child', stage: 'restitch_processing' },
    pending: false,
    active: true
  });
  expect(result.current).toBe('00:10');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  rerender({ gen: { ...generation, stage: 'catalog_creating' }, pending: false, active: true });
  expect(result.current).toBe('00:15');
  rerender({ gen: { ...generation, state: 'failed' }, pending: false, active: false });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(result.current).toBe('00:15');
  rerender({ gen: generation, pending: true, active: true });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_000);
  });
  rerender({ gen: { ...generation, attemptNo: 2 }, pending: false, active: true });
  expect(result.current).toBe('00:03');
});
it('retains elapsed time when the same generation is reopened', async () => {
  vi.useFakeTimers();
  const first = renderHook(() => useLaunchElapsed('launch', generation, false, true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(12_000);
  });
  first.unmount();
  const next = renderHook(() => useLaunchElapsed('launch', generation, false, true));
  expect(next.result.current).toBe('00:12');
});
it('does not fabricate a historical duration when opening an old failed generation', () => {
  const { result } = renderHook(() => useLaunchElapsed('launch', generation, false, false));
  expect(result.current).toBeNull();
});
