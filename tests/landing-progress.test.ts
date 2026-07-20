import { describe, expect, it } from 'vitest';
import type { LandingAsset } from '../packages/shared/src/types.js';
import { landingOptimizationProgress } from '../apps/agent/src/landing/optimizer.js';

describe('landing optimizer aggregate progress', () => {
  it('reserves the end of the progress bar for rewriting and packaging', () => {
    expect(
      landingOptimizationProgress([
        asset('optimized', null),
        asset('processing', 50),
        asset('pending', null),
        asset('skipped', null)
      ])
    ).toBe(55);
    expect(
      landingOptimizationProgress([
        asset('optimized', null),
        asset('optimized', null),
        asset('skipped', null),
        asset('failed', null)
      ])
    ).toBe(88);
  });

  it('clamps malformed per-file progress and handles an empty landing', () => {
    expect(landingOptimizationProgress([])).toBe(0);
    expect(landingOptimizationProgress([asset('processing', 140)])).toBe(88);
    expect(landingOptimizationProgress([asset('processing', -20)])).toBe(0);
  });
});

function asset(status: LandingAsset['status'], progress: number | null): LandingAsset {
  return {
    id: crypto.randomUUID(),
    relPath: 'images/hero.jpg',
    fileName: 'hero.jpg',
    type: 'image',
    status,
    originalSize: 1_000,
    optimizedSize: status === 'optimized' ? 500 : null,
    savedBytes: status === 'optimized' ? 500 : null,
    savedPercent: status === 'optimized' ? 50 : null,
    progress,
    newRelPath: null,
    note: null,
    preview: null
  };
}
