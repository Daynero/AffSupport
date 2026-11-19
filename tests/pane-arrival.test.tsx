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

it('says so just before the pane comes, and only then', () => {
  // The list is copied at that moment, so its reflow dissolves while the pane slides in (058).
  const order: string[] = [];
  const { result, rerender } = renderHook(
    ({ present }) => {
      const shown = usePaneArrival(present, 400, () => order.push('arrive'));
      order.push(shown ? 'shown' : 'hidden');
      return shown;
    },
    { initialProps: { present: false } }
  );
  rerender({ present: true });
  act(() => vi.advanceTimersByTime(400));
  expect(result.current).toBe(true);
  expect(order.filter(entry => entry !== 'hidden')).toEqual(['arrive', 'shown']);
  // Staying, and leaving, are not arrivals.
  rerender({ present: true });
  rerender({ present: false });
  expect(order.filter(entry => entry === 'arrive')).toHaveLength(1);
});
