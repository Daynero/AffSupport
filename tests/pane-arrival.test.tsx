// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePaneArrival } from '../apps/web/src/team/explorer/usePaneArrival';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

it('brings the pane after a pause, then follows the selection at once', () => {
  const { result, rerender } = renderHook(({ present }) => usePaneArrival(present, 400), {
    initialProps: { present: false }
  });
  expect(result.current).toBe(false);
  rerender({ present: true });
  expect(result.current).toBe(false);
  act(() => vi.advanceTimersByTime(399));
  expect(result.current).toBe(false);
  act(() => vi.advanceTimersByTime(1));
  expect(result.current).toBe(true);
  rerender({ present: false });
  expect(result.current).toBe(false);
});

it('never shows for a row a double-click opened', () => {
  const { result, rerender } = renderHook(({ present }) => usePaneArrival(present, 400), {
    initialProps: { present: false }
  });
  rerender({ present: true });
  act(() => vi.advanceTimersByTime(200));
  // The folder opened: the selection went with it.
  rerender({ present: false });
  act(() => vi.advanceTimersByTime(1000));
  expect(result.current).toBe(false);
});

it('shows at once for a selection that was there from the start', () => {
  const { result } = renderHook(() => usePaneArrival(true, 400));
  expect(result.current).toBe(true);
});
