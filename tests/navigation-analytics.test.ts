// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../apps/web/src/analytics/service.js', () => ({
  analytics: { track: vi.fn(), setLocale: vi.fn() }
}));

import {
  NAV_SESSION_CAP,
  NAV_SETTLE_WATCH_MS,
  beginNavigationAttempt,
  reportChunkFailure,
  setNavigationAnalyticsForTests,
  skeletonVisible
} from '../apps/web/src/lib/navigation-analytics';
import { sanitizeAnalyticsProperties } from '../apps/web/src/analytics/events';

const sent: Array<Record<string, unknown>> = [];
let roll = 0;

const start = {
  from: 'tools_home',
  to: 'team_tasks',
  motion: 'page',
  history: 'push'
} as const;

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  roll = 0;
  sessionStorage.clear();
  setNavigationAnalyticsForTests({
    sender: properties => sent.push(properties as unknown as Record<string, unknown>),
    random: () => roll
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('navigation attempt', () => {
  it('sends one settled attempt after the layout watch, with closed values only', async () => {
    const attempt = beginNavigationAttempt(start);
    attempt.prepared();
    attempt.committed('animated', 'none');
    attempt.animationDone();
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(NAV_SETTLE_WATCH_MS);
    expect(sent).toHaveLength(1);
    const event = sent[0]!;
    expect(event).toMatchObject({
      nav_from_screen: 'tools_home',
      nav_to_screen: 'team_tasks',
      nav_motion: 'page',
      nav_mode: 'animated',
      nav_final: 'settled',
      nav_history: 'push',
      skeleton_ms: 0,
      long_frame_count: 0
    });
    expect(String(event.flow_id)).toMatch(/^[0-9a-f-]{36}$/u);
    // Nothing about where the person was: the sanitizer keeps every key, and
    // no value is a path or an identifier other than the flow.
    const clean = sanitizeAnalyticsProperties(event, 'navigation_attempt_finished');
    expect(Object.keys(clean).sort()).toEqual(Object.keys(event).sort());
    for (const [key, value] of Object.entries(event)) {
      if (key === 'flow_id') continue;
      expect(String(value)).not.toMatch(/[/\\]/u);
    }
  });

  it('waits for the skeleton to go before it calls the content ready', async () => {
    const attempt = beginNavigationAttempt(start);
    attempt.committed('instant_reduced', 'none');
    const hide = skeletonVisible();
    await vi.advanceTimersByTimeAsync(500);
    hide();
    await vi.advanceTimersByTimeAsync(NAV_SETTLE_WATCH_MS);
    expect(sent).toHaveLength(1);
    expect(Number(sent[0]!.skeleton_ms)).toBeGreaterThanOrEqual(500);
    expect(Number(sent[0]!.duration_ms)).toBeGreaterThanOrEqual(500);
  });

  it('ends an unsettled attempt as superseded when the next one begins', () => {
    beginNavigationAttempt(start);
    beginNavigationAttempt({ ...start, to: 'team_explorer' });
    expect(sent[0]).toMatchObject({ nav_final: 'superseded', nav_to_screen: 'team_tasks' });
  });

  it('ends the current attempt as chunk_failed when its code does not load', () => {
    const attempt = beginNavigationAttempt(start);
    attempt.committed('animated', 'none');
    reportChunkFailure();
    expect(sent[0]).toMatchObject({ nav_final: 'chunk_failed' });
  });

  it('samples ordinary attempts and always sends the ones worth explaining', async () => {
    roll = 0.5;
    const ordinary = beginNavigationAttempt(start);
    ordinary.committed('animated', 'none');
    ordinary.animationDone();
    await vi.advanceTimersByTimeAsync(NAV_SETTLE_WATCH_MS);
    expect(sent).toHaveLength(0);

    const degraded = beginNavigationAttempt(start);
    degraded.committed('instant_lite', 'none');
    await vi.advanceTimersByTimeAsync(NAV_SETTLE_WATCH_MS + 50);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ nav_mode: 'instant_lite' });
  });

  it('sends no more than the session cap', () => {
    for (let index = 0; index < NAV_SESSION_CAP + 10; index += 1) {
      beginNavigationAttempt(start, { standalone: true }).finish('cancelled');
    }
    expect(sent).toHaveLength(NAV_SESSION_CAP);
  });
});
