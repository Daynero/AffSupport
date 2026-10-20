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
it('pins the timezone with dirty dated drafts until their context is resolved', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-24T22:30:00Z'));
  const view = renderHook(({ dirty, zone }) => useFinancePeriod(dirty, zone), {
    initialProps: { dirty: true, zone: 'Europe/Berlin' }
  });
  expect(view.result.current.date).toBe('2026-10-25');
  view.rerender({ dirty: true, zone: 'UTC' });
  expect(view.result.current.today).toBe('2026-10-24');
  expect(view.result.current.date).toBe('2026-10-25');
  expect(view.result.current.timezone).toBe('Europe/Berlin');
  expect(view.result.current.pendingContext).toBe(true);
  view.rerender({ dirty: false, zone: 'UTC' });
  expect(view.result.current.timezone).toBe('UTC');
  expect(view.result.current.date).toBe('2026-10-24');
  expect(view.result.current.pendingContext).toBe(false);
});
it.each([
  ['2026-03-28T22:59:59Z', '2026-03-29', '2026-03-30', 23],
  ['2026-10-24T21:59:59Z', '2026-10-25', '2026-10-26', 25]
])('schedules local midnight across a %s DST transition', (instant, day, nextDay, hours) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(instant));
  const view = renderHook(() => useFinancePeriod(false, 'Europe/Berlin'));
  act(() => vi.advanceTimersByTime(1100));
  expect(view.result.current.date).toBe(day);
  act(() => vi.advanceTimersByTime(Number(hours) * 60 * 60 * 1000));
  expect(view.result.current.date).toBe(nextDay);
});
