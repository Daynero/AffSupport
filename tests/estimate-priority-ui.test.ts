import { describe, expect, it } from 'vitest';
import type { CompressionJob } from '../packages/shared/src/types.js';
import { estimatePriorityAction } from '../apps/web/src/estimate-priority';

const queuedWaiting: CompressionJob = {
  id: 'queued', inputPath: '/input.mov', outputPath: '/output.mp4', fileName: 'input.mov',
  durationSeconds: 10, originalSize: 1000, finalSize: null, progress: 0, status: 'queued',
  error: null, preset: 'balanced', estimateStatus: 'waiting', estimatePriorityOrder: null
};

describe('estimate priority control', () => {
  it('shows prioritize for the screenshot state: compression running and queued estimate waiting', () => {
    expect(estimatePriorityAction(queuedWaiting, true)).toBe('prioritize');
  });
  it('switches the same control to cancel after prioritization', () => {
    expect(estimatePriorityAction({ ...queuedWaiting, estimatePriorityOrder: 1 }, true)).toBe('cancel');
    expect(estimatePriorityAction({ ...queuedWaiting, estimateStatus: 'estimating', estimatePriorityOrder: 1 }, true)).toBe('cancel');
  });
  it('does not show prioritize outside an active compression queue', () => {
    expect(estimatePriorityAction(queuedWaiting, false)).toBeNull();
    expect(estimatePriorityAction({ ...queuedWaiting, status: 'completed' }, true)).toBeNull();
  });
});
