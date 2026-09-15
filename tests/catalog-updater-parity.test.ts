import { describe, expect, it } from 'vitest';
import * as web from '../apps/web/src/team/catalog-updater/limits.js';
import * as edge from '../supabase/functions/_shared/catalog-updater.js';

/** Feature 023 keeps the updater's rules in two places for a web-only release; they must agree. */
describe('web and edge agree on the updater', () => {
  it('on the intervals', () => {
    expect(web.UPDATER_INTERVALS).toEqual(edge.UPDATER_INTERVALS);
  });

  it('on the ID offset', () => {
    for (const k of [0, 1, 2, 3, 10, 999, 87_600]) expect(web.idOffset(k)).toBe(edge.idOffset(k));
  });
});
