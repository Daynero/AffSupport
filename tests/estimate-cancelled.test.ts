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

  it('marks unfinished estimation as paused when compression is cancelled', async () => {
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
    expect(queue.state().jobs[0]).toMatchObject({
      status: 'cancelled',
      estimateStatus: 'cancelled',
      estimatePriorityOrder: null
    });
  });
});
