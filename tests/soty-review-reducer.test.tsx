import { describe, expect, it } from 'vitest';
import { reviewReducer, type ReviewState } from '../apps/soty-review/src/review/reducer.js';

const state: ReviewState = {
  route: { kind: 'catalog', theme: 'light', locale: 'uk' },
  advanced: false,
  overlay: 'none',
  demoStep: 0
};

describe('Soty local demo reducer', () => {
  it('performs deterministic in-memory transitions', () => {
    expect(reviewReducer(state, { type: 'toggle-disclosure' }).advanced).toBe(true);
    expect(reviewReducer(state, { type: 'open-overlay', overlay: 'confirmation' }).overlay).toBe(
      'confirmation'
    );
    expect(reviewReducer(state, { type: 'advance-demo' }).demoStep).toBe(1);
  });

  it('does not select a state outside a screen', () => {
    expect(reviewReducer(state, { type: 'select-state', stateId: 'active' })).toBe(state);
  });
});
