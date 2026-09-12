import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobQueue } from '../apps/agent/src/queue/queue.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { makeJob, optimalSettings } from './helpers.js';

let directory = '';
afterEach(async () => {
  if (directory) await removeTemporaryDirectory(directory);
  directory = '';
});

describe('start() failure does not wedge the queue', () => {
  it('leaves no job queued and running=false when output-path resolution throws', async () => {
    // The sources have to exist: `start` drops jobs whose input has disappeared
    // before it resolves any output path, so a fixture pointing at nothing
    // would exercise that housekeeping pass instead of this rollback.
    directory = await mkdtemp(path.join(os.tmpdir(), 'queue-start-rollback-'));
    const a = makeJob('a', 'ready', { inputPath: path.join(directory, 'a.mov') });
    const b = makeJob('b', 'ready', { inputPath: path.join(directory, 'b.mov') });
    for (const job of [a, b]) await writeFile(job.inputPath, '');

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
