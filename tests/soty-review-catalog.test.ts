import { describe, expect, it } from 'vitest';
import { reviewCatalog } from '../apps/soty-review/src/review/catalog.js';
import { canonicalStateKinds } from '../apps/soty-review/src/review/model.js';

describe('Soty review catalog', () => {
  it('has stable unique surfaces and valid primary states', () => {
    const ids = reviewCatalog.surfaces.map(surface => surface.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(13);
    for (const surface of reviewCatalog.surfaces)
      expect(surface.states.some(state => state.id === surface.primaryStateId)).toBe(true);
  });

  it('records every canonical state as scenario or explicit N/A', () => {
    for (const surface of reviewCatalog.surfaces)
      for (const kind of canonicalStateKinds)
        expect(surface.coverage[kind].applicability).toMatch(/scenario|not-applicable/);
  });

  it('records explicit scope exclusions', () => {
    expect(reviewCatalog.exclusions.map(item => item.id)).toEqual(
      expect.arrayContaining(['marketing-home', 'legal-pages', 'admin-only', 'installer-release'])
    );
  });

  it('registers every automated and human approval evidence dimension', () => {
    expect(reviewCatalog.evidence).toEqual({
      motionModes: ['no-preference', 'reduce'],
      contentModes: ['standard', 'long'],
      interactionModes: ['pointer', 'keyboard'],
      checks: ['contrast', 'reflow', 'focus', 'overlap'],
      scenarios: [
        'primary-action',
        'timed-tool-entry',
        'basic',
        'advanced',
        'nested-return',
        'confirmation',
        'lifecycle'
      ]
    });
  });
});
