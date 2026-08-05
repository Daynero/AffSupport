import { describe, expect, it } from 'vitest';
import { JobQueue } from '../apps/agent/src/queue/queue.js';
import { makeJob, optimalSettings } from './helpers.js';

describe('start() failure does not wedge the queue', () => {
  it('leaves no job queued and running=false when output-path resolution throws', async () => {
    const a = makeJob('a', 'ready');
    const b = makeJob('b', 'ready');
    // chosen-folder with no folder makes outputPathFor throw. The batch and any
    // `queued` status must only be committed AFTER every path resolves, so a
    // throw here cannot strand `running=true` (which previously required an
    // agent restart to clear).
    const queue = new JobQueue({ ffmpeg: true, ffprobe: true }, () => {}, [a, b], {
      ...optimalSettings,
      outputMode: 'chosen-folder',
      outputFolder: null
    });

    await expect(queue.start(['a', 'b'])).rejects.toThrow('Choose an output folder');

    const state = queue.state();
    expect(state.running).toBe(false);
    expect(state.jobs.map(job => job.status)).toEqual(['ready', 'ready']);
    expect(state.batch).toBeNull();
    expect(queue.acceptingNewTasks()).toBe(true);
  });
});
