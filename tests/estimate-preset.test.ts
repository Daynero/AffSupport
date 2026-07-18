import { describe, expect, it } from 'vitest';
import { encodingKey } from '../packages/shared/src/types.js';
import { JobQueue } from '../apps/agent/src/queue/queue.js';
import { makeJob, optimalSettings } from './helpers.js';

describe('estimate invalidation when settings change', () => {
  it('clears the old estimate and applies the same new snapshot to ready jobs', async () => {
    const job = makeJob('ready', 'ready', {
      estimateStatus: 'estimated',
      estimatedOutputBytes: 5000,
      estimatedSavingPercent: 50,
      estimateKey: 'old'
    });
    const queue = new JobQueue(
      { ffmpeg: true, ffprobe: true },
      () => {},
      [job],
      { ...optimalSettings }
    );
    let invalidations = 0;
    queue.attachEstimator({
      schedule: () => {},
      resume: () => {},
      invalidate: () => {
        invalidations++;
      }
    });
    await queue.updateSettings({ mode: 'custom', frameRate: 25, resolutionLimit: 720, crf: 20 });
    const updated = queue.state().jobs[0];
    expect(invalidations).toBe(1);
    expect(updated.encoding).toMatchObject({
      mode: 'custom',
      frameRate: 25,
      resolutionLimit: 720,
      rateControl: 'crf',
      crf: 20,
      videoBitrateKbps: null
    });
    expect(updated).toMatchObject({
      estimateStatus: 'waiting',
      estimatedOutputBytes: null,
      estimatedSavingPercent: null,
      estimateKey: null
    });
  });

  it('does not mutate an already queued batch snapshot', async () => {
    const job = makeJob('queued', 'queued', { batchId: 'batch' });
    const originalKey = encodingKey(job.encoding);
    const queue = new JobQueue(
      { ffmpeg: true, ffprobe: true },
      () => {},
      [job],
      { ...optimalSettings },
      { id: 'batch', jobIds: [job.id], startedAt: Date.now(), finishedAt: null }
    );
    queue.attachEstimator({ schedule: () => {}, resume: () => {}, invalidate: () => {} });
    await queue.updateSettings({ mode: 'custom', frameRate: 60, resolutionLimit: 550 });
    expect(encodingKey(queue.state().jobs[0].encoding)).toBe(originalKey);
  });
});
