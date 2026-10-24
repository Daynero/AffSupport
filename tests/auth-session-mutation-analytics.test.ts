// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProductAnalytics, type PendingAnalyticsEvent } from '../apps/web/src/analytics/service';
import { observeSessionLogout } from '../apps/web/src/auth/session-mutation-analytics';
const A = 'e1690000-0000-4000-8000-000000000001',
  B = 'e1690000-0000-4000-8000-000000000002';
function fixture() {
  const send = vi.fn(async (_events: PendingAnalyticsEvent[]) => true),
    tracker = new ProductAnalytics(send, null);
  tracker.setUser(A);
  return { send, tracker };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
it('sends correlated bounded intent, acquisition and closed failure through the actual typed analytics producer', async () => {
  const f = fixture(),
    observation = observeSessionLogout(A, f.tracker);
  observation.acquired();
  observation.failed(
    new Error('AUTH_SESSION_STATE_UNAVAILABLE', {
      cause: new Error('synthetic-private-path synthetic-session-secret')
    })
  );
  observation.completed();
  await f.tracker.flush();
  const events = f.send.mock.calls.flatMap(call => call[0]);
  expect(events.map(event => event.event_name)).toEqual([
    'operation_started',
    'operation_stage_started',
    'operation_failed'
  ]);
  const attempt = events[0]!.attempt_id;
  expect(attempt).toMatch(/^[a-f0-9-]{36}$/u);
  for (const event of events)
    expect(event).toMatchObject({
      user_id: A,
      flow_id: attempt,
      attempt_id: attempt,
      properties: { flow_step: 'auth_session_sdk_logout' }
    });
  expect(events.at(-1)?.properties).toMatchObject({
    error_code: 'AUTH_SESSION_STATE_UNAVAILABLE',
    error_fingerprint: 'auth:library:AUTH_SESSION_STATE_UNAVAILABLE',
    outcome: 'failure'
  });
  expect(JSON.stringify(events)).not.toMatch(
    /synthetic-private-path|synthetic-session-secret|access_token|refresh_token/u
  );
});
it('does not relabel a late old-actor terminal under the replacement account', async () => {
  const f = fixture(),
    observation = observeSessionLogout(A, f.tracker);
  await f.tracker.flush();
  f.tracker.setUser(B);
  observation.failed(new Error('AUTH_SESSION_LOCK_TIMEOUT'));
  await f.tracker.flush();
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.send.mock.calls[0]![0].map(event => event.event_name)).toEqual(['operation_started']);
});
it('keeps SDK success unobserved after analytics identity removal instead of fabricating a terminal', async () => {
  const f = fixture(),
    observation = observeSessionLogout(A, f.tracker);
  await f.tracker.flush();
  f.tracker.setUser(null);
  observation.completed();
  await f.tracker.flush();
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.send.mock.calls[0]![0].map(event => event.event_name)).toEqual(['operation_started']);
});
it('never inherits an unrelated current actor when no expected actor is available', async () => {
  const f = fixture(),
    observation = observeSessionLogout(undefined, f.tracker);
  observation.failed(new Error('private detail'));
  await f.tracker.flush();
  expect(f.send).not.toHaveBeenCalled();
});
it('does not let a telemetry exception block auth or disclose an arbitrary SDK error', () => {
  const observation = observeSessionLogout(A, {
    trackForActor: () => {
      throw new Error('SYNTHETIC_COLLECTOR_FAILURE');
    }
  });
  expect(() => observation.acquired()).not.toThrow();
  expect(() => observation.failed(new Error('private provider payload'))).not.toThrow();
});
