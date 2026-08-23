import { describe, expect, it } from 'vitest';
import { phaseOf, type LandingAsset } from '../packages/shared/src/types.js';
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

describe('a landing job’s phase', () => {
  it('is the status itself for every state but processing', () => {
    // Six of the nine phases were only ever the status spelled a second time, assigned at a
    // different moment and therefore able to disagree with it.
    for (const status of ['preparing', 'ready', 'queued', 'completed', 'failed', 'cancelled'] as const)
      expect(phaseOf(status, null)).toBe(status);
  });

  it('names the step inside processing', () => {
    expect(phaseOf('processing', 'optimizing')).toBe('optimizing');
    expect(phaseOf('processing', 'rewriting')).toBe('rewriting');
    expect(phaseOf('processing', 'packaging')).toBe('packaging');
  });

  it('ignores a step recorded against a job that is no longer processing', () => {
    // Stale bookkeeping must not outrank the status. A job that reported `packaging` while
    // its status said `cancelled` is exactly the disagreement deriving the phase removes.
    expect(phaseOf('cancelled', 'packaging')).toBe('cancelled');
    expect(phaseOf('failed', 'rewriting')).toBe('failed');
    expect(phaseOf('completed', 'optimizing')).toBe('completed');
  });

  it('falls back to the first step when processing has not recorded one', () => {
    expect(phaseOf('processing', null)).toBe('optimizing');
  });
});
