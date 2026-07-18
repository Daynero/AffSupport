import { describe, expect, it } from 'vitest';
import { JobQueue } from '../apps/agent/src/queue/queue.js';
import { makeJob, optimalSettings } from './helpers.js';

describe('estimate state after cancellation and retry', () => {
  it('clears stale estimate values when compression is cancelled', async () => {
    const job = makeJob('cancelled-job', 'processing', {
      startedAt: Date.now(),
      estimateStatus: 'estimated',
      estimatedOutputBytes: 500,
      estimatedSavingPercent: 50,
      estimateKey: 'old'
    });
    const queue = new JobQueue(
      { ffmpeg: true, ffprobe: true },
      () => {},
      [job],
      { ...optimalSettings }
    );
    expect(await queue.cancel(job.id)).toBe(true);
    expect(queue.state().jobs[0]).toMatchObject({
      status: 'cancelled',
      estimateStatus: 'waiting',
      estimatedOutputBytes: null,
      estimateKey: null
    });
  });
});
