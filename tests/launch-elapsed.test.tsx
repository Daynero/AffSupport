// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { LaunchGeneration } from '../packages/shared/src/team/launches';
import { useLaunchElapsed } from '../apps/web/src/team/launches/useLaunchElapsed';
const generation = { id: 'gen', attemptNo: 1 } as LaunchGeneration;
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
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
it('keeps counting from the first sight when the launch is reopened in a new tab (1.4.3)', async () => {
  vi.useFakeTimers();
  const first = renderHook(() => useLaunchElapsed('launch', generation, false, true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(95_000);
  });
  first.unmount();
  // A new tab, window or browser context starts with an empty sessionStorage.
  sessionStorage.clear();
  const next = renderHook(() => useLaunchElapsed('launch', generation, false, true));
  expect(next.result.current).toBe('01:35');
});
it('counts from the server start on a computer that never saw the launch begin (1.4.3)', () => {
  // QA round 7: a reopened launch showed 00:31 for a generation running about 7 minutes.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-11T18:59:00Z'));
  const started = { ...generation, startedAt: '2026-11-11T18:52:00.000000Z' };
  const view = renderHook(() => useLaunchElapsed('other-computer', started, false, true));
  expect(view.result.current).toBe('07:00');
  // A server start in the future (clock skew) never yields a negative clock.
  view.unmount();
  localStorage.clear();
  const ahead = { ...generation, startedAt: '2026-11-11T19:05:00Z' };
  const skewed = renderHook(() => useLaunchElapsed('skewed', ahead, false, true));
  expect(skewed.result.current).toBe('00:00');
});

it('does not reset a confirmed attempt when a lost request enters preparation again', async () => {
  vi.useFakeTimers();
  const view = renderHook(({ pending }) => useLaunchElapsed('launch', generation, pending, true), {
    initialProps: { pending: false }
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(75_000);
  });
  view.rerender({ pending: true });
  expect(view.result.current).toBe('01:15');
  view.rerender({ pending: false });
  expect(view.result.current).toBe('01:15');
});

it('retains a stored attempt while reopened detail temporarily has no generation metadata', async () => {
  vi.useFakeTimers();
  const first = renderHook(() => useLaunchElapsed('launch', generation, false, true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(95_000);
  });
  first.unmount();
  const view = renderHook(({ gen }) => useLaunchElapsed('launch', gen, false, true), {
    initialProps: { gen: null as LaunchGeneration | null }
  });
  view.rerender({ gen: generation });
  expect(view.result.current).toBe('01:35');
});

it('does not move the clock backward when acceptance supplies a later server start', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-13T09:00:00Z'));
  const view = renderHook(({ gen, pending }) => useLaunchElapsed('launch', gen, pending, true), {
    initialProps: { gen: null as LaunchGeneration | null, pending: true }
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  view.rerender({ gen: { ...generation, startedAt: new Date().toISOString() }, pending: false });
  expect(view.result.current).toBe('00:20');
});

it('does not carry another launch clock into a reused progress component', async () => {
  vi.useFakeTimers();
  const view = renderHook(({ scope, gen }) => useLaunchElapsed(scope, gen, false, true), {
    initialProps: { scope: 'first', gen: generation }
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(90_000);
  });
  view.rerender({ scope: 'second', gen: { ...generation, id: 'second-gen' } });
  expect(view.result.current).toBe('00:00');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  view.rerender({ scope: 'first', gen: generation });
  expect(view.result.current).toBe('01:35');
});

it('keeps elapsed wall time through an observation outage instead of freezing at the error', async () => {
  vi.useFakeTimers();
  const running = { ...generation, state: 'running' as const };
  const view = renderHook(({ active }) => useLaunchElapsed('launch', running, false, active), {
    initialProps: { active: true }
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  view.rerender({ active: false });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  view.rerender({ active: true });
  expect(view.result.current).toBe('00:30');
});
