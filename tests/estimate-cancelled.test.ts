import { describe, expect, it, vi } from 'vitest';
import { JobQueue } from '../apps/agent/src/queue/queue.js';
import { makeJob, optimalSettings } from './helpers.js';

describe('estimate state after cancellation and retry', () => {
  it('keeps a completed estimate when compression is cancelled', async () => {
    const job = makeJob('cancelled-job', 'processing', {
      startedAt: Date.now(),
      estimateStatus: 'estimated',
      estimatedOutputBytes: 500,
      estimatedSavingPercent: 50,
      estimateKey: 'current'
    });
    const queue = new JobQueue({ ffmpeg: true, ffprobe: true }, () => {}, [job], {
      ...optimalSettings
    });
    expect(await queue.cancel(job.id)).toBe(true);
    expect(queue.state().jobs[0]).toMatchObject({
      status: 'cancelled',
      estimateStatus: 'estimated',
      estimatedOutputBytes: 500,
      estimateKey: 'current'
    });
  });

  it('returns unfinished estimation to waiting when compression is cancelled', async () => {
    const job = makeJob('waiting-job', 'queued', {
      estimateStatus: 'waiting',
      estimatePriorityOrder: 1
    });
    const cancelPrioritized = vi.fn();
    const queue = new JobQueue({ ffmpeg: true, ffprobe: true }, () => {}, [job], {
      ...optimalSettings
    });
    queue.attachEstimator({
      invalidate: vi.fn(),
      resume: vi.fn(),
      schedule: vi.fn(),
      runPrioritized: vi.fn(),
      cancelPrioritized
    });

    expect(await queue.cancel(job.id)).toBe(true);
    expect(cancelPrioritized).toHaveBeenCalledWith(job.id);
    // The estimate belongs to the current settings, not to the attempt that was
    // just stopped. Marking it 'cancelled' left the card animating "estimation
    // paused" forever, because nothing ever moves a cancelled estimate back
    // into the queue — so the row goes back to 'waiting' and the estimator
    // picks it up again the way it would any other idle row.
    expect(queue.state().jobs[0]).toMatchObject({
      status: 'cancelled',
      estimateStatus: 'waiting',
      estimateProgress: null,
      estimateError: null,
      estimatePriorityOrder: null
    });
  });
});
