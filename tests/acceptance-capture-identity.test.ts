import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingAnalyticsEvent } from '../apps/web/src/analytics/service';
const auth = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock('../apps/web/src/lib/config', () => ({
  publicConfig: { ok: true, value: { environment: 'beta', supabaseUrl: 'http://127.0.0.1:54321' } }
}));
vi.mock('../apps/web/src/lib/supabase', () => ({ getSupabaseClient: () => ({ auth }) }));
import {
  ACCEPTANCE_CAPTURE_KEY,
  acceptanceCaptureAdmitted,
  captureAcceptanceEvent,
  resetAcceptanceCapture
} from '../apps/web/src/analytics/acceptance-capture';
const campaign = 'acceptance-identity-test';
const event = { event_id: 'one', user_id: 'actor-a' } as PendingAnalyticsEvent;
describe('capture identity across asynchronous session lookup', () => {
  let storage: Map<string, string>;
  beforeEach(() => {
    vi.useFakeTimers();
    storage = new Map([[ACCEPTANCE_CAPTURE_KEY, campaign]]);
    vi.stubGlobal('window', {
      location: { origin: 'http://127.0.0.1:5175' },
      sessionStorage: { getItem: (key: string) => storage.get(key) ?? null }
    });
    resetAcceptanceCapture();
    auth.getSession.mockReset();
  });
  afterEach(() => {
    resetAcceptanceCapture();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });
  it('never reads acceptance storage or Auth from a production track with analytics disabled', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_ANALYTICS_ENABLED', 'false');
    const storageRead = vi.fn(() => campaign);
    vi.stubGlobal('window', {
      location: { origin: 'http://127.0.0.1:5175' },
      addEventListener: vi.fn(),
      sessionStorage: { getItem: storageRead }
    });
    vi.stubGlobal('document', { addEventListener: vi.fn() });
    const { ProductAnalytics } = await import('../apps/web/src/analytics/service');
    const sender = vi.fn();
    const tracker = new ProductAnalytics(sender, null);
    tracker.setUser('actor-a');
    tracker.track('home_viewed', {});
    await vi.advanceTimersByTimeAsync(3000);
    expect(storageRead).not.toHaveBeenCalled();
    expect(auth.getSession).not.toHaveBeenCalled();
    expect(sender).not.toHaveBeenCalled();
  });
  for (const invalidate of ['remove campaign', 'replace campaign', 'sign out'] as const) {
    it(`rejects a delayed session after ${invalidate}`, async () => {
      let resolve!: (value: unknown) => void;
      auth.getSession.mockImplementation(
        () =>
          new Promise(done => {
            resolve = done;
          })
      );
      const sender = vi.fn().mockResolvedValue(true);
      captureAcceptanceEvent(event, sender);
      await vi.advanceTimersByTimeAsync(2000);
      expect(auth.getSession).toHaveBeenCalledOnce();
      if (invalidate === 'remove campaign') storage.clear();
      else if (invalidate === 'replace campaign')
        storage.set(ACCEPTANCE_CAPTURE_KEY, 'acceptance-other-test');
      else resetAcceptanceCapture();
      resolve({
        error: null,
        data: {
          session: { user: { id: 'actor-a', user_metadata: { acceptance_namespace: campaign } } }
        }
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(sender).not.toHaveBeenCalled();
      expect(acceptanceCaptureAdmitted('actor-a')).toBe(false);
    });
  }
  it('does not admit the previous actor after a new actor creates a queue', async () => {
    let resolve!: (value: unknown) => void;
    auth.getSession.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done;
        })
    );
    const oldSender = vi.fn().mockResolvedValue(true);
    captureAcceptanceEvent(event, oldSender);
    await vi.advanceTimersByTimeAsync(2000);
    captureAcceptanceEvent(
      { ...event, event_id: 'two', user_id: 'actor-b' },
      vi.fn().mockResolvedValue(true)
    );
    resolve({
      error: null,
      data: {
        session: { user: { id: 'actor-a', user_metadata: { acceptance_namespace: campaign } } }
      }
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(oldSender).not.toHaveBeenCalled();
    expect(acceptanceCaptureAdmitted('actor-a')).toBe(false);
  });
});
