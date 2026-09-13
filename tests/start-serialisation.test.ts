import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeJob, optimalSettings } from './helpers.js';
import { writeStubTool } from './support/stub-tools/index.js';
import { waitFor } from './support/wait.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

/**
 * A double-click must not start the same work twice.
 *
 * `start` checks whether the queue is already running and then awaits — the disk warning,
 * then one output-path resolution per job. Every one of those is a turn of the event loop in
 * which a second request runs the same check against the same "not running" answer. Both go
 * on to build a batch, and the second overwrites the first, so the first batch's jobs are
 * left queued against a batch nothing will ever drain: a queue that says it is running while
 * nothing runs, until the agent restarts.
 *
 * A hundred is not a stress test for its own sake — it is what a held-down key or a wedged
 * client produces, and the failure only appears when the interleaving is dense enough.
 */

let directory = '';

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (directory) await removeTemporaryDirectory(directory);
  directory = '';
});

async function stubbedQueue(jobCount: number) {
  directory = await mkdtemp(path.join(os.tmpdir(), 'start-serialisation-'));
  const tool = await writeStubTool(directory, 'stub-ffmpeg', {
    hang: true,
    writeOutput: true
  });
  vi.stubEnv('FFMPEG_PATH', tool);
  vi.resetModules();
  const { JobQueue } = await import('../apps/agent/src/queue/queue.js');

  const jobs = [];
  for (let index = 0; index < jobCount; index += 1) {
    const source = path.join(directory, `clip-${index}.mov`);
    await writeFile(source, 'source');
    jobs.push(
      makeJob(`job-${index}`, 'ready', {
        inputPath: source,
        outputPath: path.join(directory, `clip-${index}_compressed.mp4`)
      })
    );
  }

  const batches: (string | null)[] = [];
  const queue = new JobQueue(
    { ffmpeg: true, ffprobe: true },
    () => {
      const id = queue.state().batch?.id ?? null;
      if (!batches.includes(id)) batches.push(id);
    },
    jobs,
    { ...optimalSettings, outputMode: 'chosen-folder', outputFolder: directory },
    null,
    undefined,
    Math.random,
    { probeMedia: async () => null as never }
  );
  return { queue, jobs, batches };
}

describe('starting the same work twice', () => {
  it('produces exactly one run from a hundred simultaneous starts', async () => {
    const { queue, jobs, batches } = await stubbedQueue(3);
    const ids = jobs.map(job => job.id);

    // Fired together, not awaited in turn: awaiting each one would serialise them at the
    // call site and the test would pass against the unserialised implementation too.
    const answers = await Promise.all(Array.from({ length: 100 }, () => queue.start(ids)));

    // Exactly one caller is told it started something. Ninety-nine honest refusals beat one
    // hundred cheerful yeses over a queue in an unrecoverable state.
    expect(answers.filter(Boolean)).toHaveLength(1);

    // And exactly one batch was ever built. A second batch is the failure: it takes over
    // `this.batch`, and the jobs the first one queued are left waiting on a batch that no
    // longer exists.
    expect(batches.filter(Boolean)).toHaveLength(1);
    expect(queue.state().jobs.filter(job => job.batchId !== null)).toHaveLength(3);

    await queue.cancelAll();
    await waitFor(() => !queue.state().running, { describe: 'the queue to go idle' });
  }, 30_000);

  it('refuses a second start while the first run is still going', async () => {
    const { queue, jobs } = await stubbedQueue(1);

    expect(await queue.start([jobs[0].id])).toBe(true);
    await waitFor(() => queue.state().jobs[0].status === 'processing', {
      describe: 'the encode to start'
    });

    // Sequential rather than simultaneous — the ordinary case, and the one that would still
    // be broken if the guard had simply been moved after the awaits.
    expect(await queue.start([jobs[0].id])).toBe(false);
    expect(queue.state().jobs.filter(job => job.status === 'processing')).toHaveLength(1);

    await queue.cancelAll();
    await waitFor(() => !queue.state().running, { describe: 'the queue to go idle' });
  }, 30_000);

  it('lets a later start proceed once the first run has finished', async () => {
    const { queue, jobs } = await stubbedQueue(1);

    expect(await queue.start([jobs[0].id])).toBe(true);
    await waitFor(() => queue.state().jobs[0].status === 'processing', {
      describe: 'the encode to start'
    });
    await queue.cancelAll();
    await waitFor(() => !queue.state().running, { describe: 'the queue to go idle' });

    // The gate serialises; it must not latch. A start that could never happen again would be
    // a worse bug than the one it replaced.
    expect(await queue.start([jobs[0].id])).toBe(true);
    await queue.cancelAll();
    await waitFor(() => !queue.state().running, { describe: 'the queue to go idle again' });
  }, 30_000);
});
