import { describe, expect, it } from 'vitest';
import { calculateQueueSummary } from '../packages/shared/src/types.js';
import { makeJob } from './helpers.js';

describe('queue summary', () => {
  it('counts only successful sizes and reports failures separately', () => {
    const summary = calculateQueueSummary([
      makeJob('done', 'completed', { originalSize: 1000, finalSize: 400 }),
      makeJob('failed', 'failed', { originalSize: 900 }),
      makeJob('cancelled', 'cancelled', { originalSize: 800 })
    ]);
    expect(summary).toEqual({
      successful: 1,
      failed: 1,
      originalSize: 1000,
      finalSize: 400,
      savedBytes: 600,
      savedPercent: 60
    });
  });
});
