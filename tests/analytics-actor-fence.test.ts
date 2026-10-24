// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProductAnalytics, type PendingAnalyticsEvent } from '../apps/web/src/analytics/service';
const A = 'e1670000-0000-4000-8000-000000000001';
const B = 'e1670000-0000-4000-8000-000000000002';
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
it('tracks an expected actor only while the current analytics identity still matches', async () => {
  const send = vi.fn(async (_events: PendingAnalyticsEvent[]) => true);
  const tracker = new ProductAnalytics(send, null);
  tracker.setUser(A);
  tracker.trackForActor(A, 'user_signed_out', {});
  await tracker.flush();
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0]![0]).toEqual([
    expect.objectContaining({ user_id: A, event_name: 'user_signed_out' })
  ]);
});
it('never relabels an old actor callback under a replacement session', async () => {
  const send = vi.fn(async (_events: PendingAnalyticsEvent[]) => true);
  const tracker = new ProductAnalytics(send, null);
  tracker.setUser(A);
  await Promise.resolve();
  tracker.setUser(B);
  tracker.trackForActor(A, 'user_signed_out', {});
  await tracker.flush();
  expect(send).not.toHaveBeenCalled();
  tracker.trackForActor(B, 'user_signed_out', {});
  await tracker.flush();
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0]![0]).toEqual([expect.objectContaining({ user_id: B })]);
});
it('drops old actor outcomes after analytics signout', async () => {
  const send = vi.fn(async (_events: PendingAnalyticsEvent[]) => true);
  const tracker = new ProductAnalytics(send, null);
  tracker.setUser(A);
  tracker.setUser(null);
  tracker.trackForActor(A, 'user_signed_out', {});
  await tracker.flush();
  expect(send).not.toHaveBeenCalled();
});
