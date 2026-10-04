// @vitest-environment jsdom
import { act, renderHook, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useFinancePeriod } from '../apps/web/src/team/accounts/finance/useFinancePeriod';
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it('rolls a clean today view over at midnight without polling and keeps a dirty day pinned', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-10T23:59:59Z'));
  const view = renderHook(({ dirty }) => useFinancePeriod(dirty, 'UTC'), {
    initialProps: { dirty: false }
  });
  expect(view.result.current.date).toBe('2026-09-10');
  act(() => vi.advanceTimersByTime(1100));
  expect(view.result.current.date).toBe('2026-09-11');
  view.rerender({ dirty: true });
  act(() => vi.advanceTimersByTime(86400000));
  expect(view.result.current.today).toBe('2026-09-12');
  expect(view.result.current.date).toBe('2026-09-11');
  view.rerender({ dirty: false });
  expect(view.result.current.date).toBe('2026-09-12');
});
it('never rolls a manually selected historical date forward', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-10T23:59:59Z'));
  const view = renderHook(() => useFinancePeriod(false, 'UTC'));
  act(() => view.result.current.setDate('2026-08-01'));
  act(() => vi.advanceTimersByTime(1100));
  expect(view.result.current.date).toBe('2026-08-01');
  expect(view.result.current.today).toBe('2026-09-11');
});
