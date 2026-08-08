import { describe, expect, it } from 'vitest';
import { reviewCatalog } from '../apps/soty-review/src/review/catalog.js';
import { canonicalStateKinds } from '../apps/soty-review/src/review/model.js';

describe('Soty review inventory', () => {
  it('covers all twelve customer-facing groups plus the component showcase', () => {
    expect(reviewCatalog.surfaces.map(item => item.id)).toEqual(
      expect.arrayContaining([
        'auth-entry',
        'global-shell',
        'home-tools',
        'compressor',
        'landing-optimizer',
        'landing-gallery',
        'transcription',
        'team-lobby',
        'team-create-space',
        'team-workspace',
        'team-settings',
        'account-profile',
        'component-showcase'
      ])
    );
  });

  it('provides every canonical state with a stable scenario identifier', () => {
    for (const surface of reviewCatalog.surfaces) {
      expect(surface.states.map(state => state.kind)).toEqual(canonicalStateKinds);
      for (const decision of Object.values(surface.coverage))
        if (decision.applicability === 'scenario')
          expect(decision.scenarioId).toMatch(new RegExp(`^${surface.id}-`));
    }
  });
});
