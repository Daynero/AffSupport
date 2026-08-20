import { describe, expect, it } from 'vitest';
import { analyticsEnabled } from '../apps/web/src/analytics/service';

/**
 * SC-003 demands zero production analytics events from beta activity. A single
 * flag is not enough for that: a mistyped or missing VITE_ANALYTICS_ENABLED
 * would silently restore telemetry, and the damage — polluted product metrics —
 * is discovered late. So the environment is an independent, non-overridable
 * condition, and these tests pin that behaviour.
 */
describe('analyticsEnabled', () => {
  it('is on by default in production', () => {
    expect(analyticsEnabled({})).toBe(true);
    expect(analyticsEnabled({ VITE_APP_ENVIRONMENT: 'production' })).toBe(true);
  });

  it('respects the flag in production', () => {
    expect(analyticsEnabled({ VITE_ANALYTICS_ENABLED: 'false' })).toBe(false);
    expect(analyticsEnabled({ VITE_ANALYTICS_ENABLED: 'true' })).toBe(true);
  });

  it('is off in beta', () => {
    expect(analyticsEnabled({ VITE_APP_ENVIRONMENT: 'beta' })).toBe(false);
  });

  it('stays off in beta even when the flag says otherwise', () => {
    // This is the whole point: a bad env file must not be able to re-enable it.
    expect(analyticsEnabled({ VITE_APP_ENVIRONMENT: 'beta', VITE_ANALYTICS_ENABLED: 'true' })).toBe(
      false
    );
  });

  it('falls back to production rules when the environment value is unusable', () => {
    // An unparseable environment means production, which is the stricter
    // reading for every other guard — here it simply means telemetry behaves
    // exactly as it does today rather than silently switching off.
    expect(analyticsEnabled({ VITE_APP_ENVIRONMENT: 'nonsense' })).toBe(true);
  });
});
