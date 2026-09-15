import { describe, expect, it } from 'vitest';
import * as web from '../apps/web/src/team/catalog-updater/limits.js';
import * as edge from '../supabase/functions/_shared/catalog-updater.js';

/** Feature 023 keeps the updater's rules in two places for a web-only release; they must agree. */
describe('web and edge agree on the updater', () => {
  it('on the intervals', () => {
    expect(web.UPDATER_INTERVALS).toEqual(edge.UPDATER_INTERVALS);
  });

  it('on which intervals exist', () => {
    expect(web.CUSTOM_INTERVAL_MAX_HOURS).toBe(edge.CUSTOM_INTERVAL_MAX_HOURS);
    for (const value of ['1h', '1d', '1w', '6h', '720h', '721h', '0h', '06h', '2d', 'x', 7]) {
      expect(web.parseUpdaterInterval(value)).toBe(edge.parseUpdaterInterval(value));
    }
  });

  it('on the ID offset', () => {
    for (const k of [0, 1, 2, 3, 10, 999, 87_600]) expect(web.idOffset(k)).toBe(edge.idOffset(k));
  });
});
