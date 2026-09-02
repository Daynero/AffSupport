import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type SourceProfile,
  type StitchJob,
  type StitchScreens,
  type StitchVerification
} from '../packages/shared/src/stitcher.js';
import { PreparedBodyCache } from '../apps/agent/src/stitcher/body-cache.js';
import type { StitchPipeline } from '../apps/agent/src/stitcher/pipeline.js';
import { StitchQueue, type StitchRunRequest } from '../apps/agent/src/stitcher/queue.js';
import { waitFor } from './support/wait.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

/** A pipeline the test releases by hand, so concurrency is observed rather than timed. */
function gatedPipeline(): { pipeline: StitchPipeline; entered: () => number; release: () => void } {
  const waiting: (() => void)[] = [];
  let entered = 0;
  const pipeline: StitchPipeline = context =>
    new Promise(resolve => {
      entered += 1;
      // A held run still answers a stop, or shutting the queue down would wait forever for
      // a release the test has no reason to give.
      const stop = () => resolve({ ok: false, error: 'STITCH_CANCELLED' });
      if (context.signal.aborted) stop();
      else context.signal.addEventListener('abort', stop, { once: true });
      waiting.push(async () => {
        const staged = path.join(context.workDir, 'result.mp4');
        await writeFile(staged, 'stitched');
        resolve({ ok: true, stagedPath: staged, verification: PASSING });
      });
    });
  return {
    pipeline,
    entered: () => entered,
    release: () => {
      for (const finish of waiting.splice(0)) finish();
    }
  };
}

/**
 * What the queue owns: order, cancellation, isolation and the rule that nothing is moved
 * into place before it has been proven. The media half is injected, because none of those
 * guarantees need a media engine to demonstrate — and one that had to encode would make
 * these assertions slow and flaky for no gain.
 */

let workspace = '';

const PASSING: StitchVerification = {
  durationSeconds: 20,
  frameCount: 600,
  videoTrackSeconds: 20,
  audioTrackSeconds: 20,
  videoCodec: 'h264',
  audioCodec: 'aac',
  width: 1080,
  height: 1080,
  pixelFormat: 'yuv420p',
  withinTolerance: true,
  mismatches: []
};

function profileFor(source: string): SourceProfile {
  return {
    path: source,
    sizeBytes: 1_000,
    modifiedAtMs: 1_700_000_000,
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    videoCodec: 'h264',
    profile: 'High',
    level: 32,
    width: 1080,
    height: 1080,
    pixelFormat: 'yuv420p',
    colorRange: 'tv',
    frameRate: 30,
    variableFrameRate: false,
    videoTimescale: 15360,
    durationSeconds: 20,
    hasAudio: true,
    audioCodec: 'aac',
    audioSampleRate: 48000,
    audioChannels: 2,
    audioBitrateKbps: 96,
    keyframeTimes: [0],
    ...{}
  };
}

const SCREENS: StitchScreens = {
  startImageId: null,
  endImageId: 'photo',
  fitMode: 'cover',
  endDurationSeconds: 45 * 60,
  startDurationSeconds: null
};

const NOTHING_FOUND = { startSeconds: 0, endSeconds: 0, adjustedByUser: false };

function requestFor(source: string, overrides: Partial<StitchRunRequest> = {}): StitchRunRequest {
  return {
    profile: profileFor(source),
    // Supplied, so the run has nothing to look for: the media half is stubbed here.
    detected: NOTHING_FOUND,
    screens: SCREENS,
    operation: 'stitch',
    destination: { kind: 'beside' },
    outputSuffix: '',
    ...overrides
  };
}

/**
 * The two steps a start takes through the routes — add the row, then run it — as one.
 *
 * Adding is deliberately separate in the queue itself: rows exist before they run, which is
 * what lets them be selected. Every assertion here is about the running half, so the tests
 * take both steps at once rather than restating the split each time.
 */
function enqueue(
  queue: StitchQueue,
  source: string,
  overrides: Partial<StitchRunRequest> = {}
): StitchJob {
  const request = requestFor(source, overrides);
  const [job] = queue.add([{ profile: request.profile }]);
  if (!job) throw new Error('the row was not added');
  queue.start(job.id, request);
  return job;
}

/** A pipeline that writes a real staged file, so the install step is exercised for real. */
const succeeding: StitchPipeline = async context => {
  const staged = path.join(context.workDir, 'result.mp4');
  await writeFile(staged, 'stitched');
  return { ok: true, stagedPath: staged, verification: PASSING };
};

function makeQueue(pipeline: StitchPipeline = succeeding) {
  return new StitchQueue({
    imagePathFor: async () => path.join(workspace, 'photo.png'),
    onChange: () => {},
    bodies: new PreparedBodyCache({ root: workspace }),
    pipeline
  });
}

async function source(name = 'creative.mp4'): Promise<string> {
  const file = path.join(workspace, name);
  await writeFile(file, 'not really a video');
  return file;
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), 'stitch-queue-'));
});

afterEach(async () => {
  await removeTemporaryDirectory(workspace);
});

describe('a batch', () => {
  it('runs one job at a time', async () => {
    const gate = gatedPipeline();
    const queue = makeQueue(gate.pipeline);
    const file = await source();
    for (let index = 0; index < 4; index += 1) enqueue(queue, file);

    // Four jobs queued, and exactly one of them has reached the media half.
    await waitFor(() => gate.entered() === 1, { describe: 'the first run to start' });
    expect(queue.state().jobs.filter(job => job.status === 'running')).toHaveLength(1);
    gate.release();
    await waitFor(() => gate.entered() === 2, { describe: 'the second run to start' });
    expect(queue.state().jobs.filter(job => job.status === 'running')).toHaveLength(1);

    gate.release();
    await waitFor(() => queue.state().jobs.filter(job => job.status === 'done').length >= 2, {
      describe: 'two finished runs'
    });
    await queue.cancelAll();
    await queue.shutdown();
  });

  it('gives every output a distinct name (FR-022)', async () => {
    const queue = makeQueue();
    const file = await source();
    for (let index = 0; index < 3; index += 1) enqueue(queue, file);
    await waitFor(() => queue.state().jobs.every(job => job.status === 'done'), {
      describe: 'three outputs'
    });
    const outputs = queue.state().jobs.map(job => job.outputPath);
    expect(new Set(outputs).size).toBe(3);
    expect(outputs[0]).toContain('creative_stitched.mp4');
    await queue.shutdown();
  });

  it('lets one item fail without stopping the rest (FR-020)', async () => {
    let call = 0;
    const queue = makeQueue(async context => {
      call += 1;
      if (call === 2) return { ok: false, error: 'STITCH_IMAGE_UNAVAILABLE' };
      const staged = path.join(context.workDir, 'result.mp4');
      await writeFile(staged, 'stitched');
      return { ok: true, stagedPath: staged, verification: PASSING };
    });
    const file = await source();
    for (let index = 0; index < 3; index += 1) enqueue(queue, file);
    await waitFor(
      () => queue.state().jobs.every(job => job.status !== 'queued' && job.status !== 'running'),
      {
        describe: 'the batch to settle'
      }
    );
    const statuses = queue.state().jobs.map(job => job.status);
    expect(statuses).toEqual(['done', 'failed', 'done']);
    expect(queue.state().jobs[1]?.error).toBe('STITCH_IMAGE_UNAVAILABLE');
    await queue.shutdown();
  });

  it('uses the suffix the user set, and numbers collisions', async () => {
    const queue = makeQueue();
    const file = await source();
    enqueue(queue, file, { outputSuffix: '(перезашив)' });
    enqueue(queue, file, { outputSuffix: '(перезашив)' });
    await waitFor(() => queue.state().jobs.every(job => job.status === 'done'), {
      describe: 'both outputs'
    });
    expect(queue.state().jobs[0]?.outputPath).toContain('creative(перезашив).mp4');
    expect(queue.state().jobs[1]?.outputPath).toContain('creative(перезашив)_2.mp4');
    await queue.shutdown();
  });
});

describe('stopping', () => {
  it('cancels a queued job without running it', async () => {
    const gate = gatedPipeline();
    const queue = makeQueue(gate.pipeline);
    const file = await source();
    enqueue(queue, file);
    const second = enqueue(queue, file);
    await waitFor(() => gate.entered() === 1, { describe: 'the first run to start' });

    expect(await queue.cancel(second.id)).toBe(true);
    gate.release();
    await waitFor(
      () => queue.state().jobs.every(job => job.status !== 'queued' && job.status !== 'running'),
      { describe: 'the queue to settle' }
    );
    expect(queue.state().jobs[1]?.status).toBe('cancelled');
    // The point of the assertion: the cancelled one never reached the pipeline at all.
    expect(gate.entered()).toBe(1);
    await queue.shutdown();
  });

  it('leaves nothing behind when a run is stopped mid-flight (SC-008)', async () => {
    const queue = makeQueue(
      context =>
        new Promise(resolve => {
          const stop = () => resolve({ ok: false, error: 'STITCH_CANCELLED' });
          if (context.signal.aborted) stop();
          else context.signal.addEventListener('abort', stop, { once: true });
        })
    );
    const file = await source();
    const job = enqueue(queue, file);
    await waitFor(() => queue.state().jobs[0]?.status === 'running', { describe: 'the run' });
    expect(await queue.cancel(job.id)).toBe(true);
    await waitFor(() => queue.state().jobs[0]?.status === 'cancelled', { describe: 'the stop' });

    // The source survives untouched and no partial output was left beside it.
    expect((await stat(file)).size).toBeGreaterThan(0);
    const beside = await readdir(workspace);
    expect(beside.filter(name => name.startsWith('creative_stitched'))).toEqual([]);
    await queue.shutdown();
  });

  it('reports an unknown job rather than pretending it stopped one', async () => {
    const queue = makeQueue();
    expect(await queue.cancel('nope')).toBe(false);
    await queue.shutdown();
  });
});

describe('what survives a restart', () => {
  it('marks a run that was in flight as interrupted rather than resuming it', () => {
    const queue = new StitchQueue({
      imagePathFor: async () => null,
      onChange: () => {},
      bodies: new PreparedBodyCache({ root: workspace }),
      jobs: [
        {
          id: 'left-running',
          sourcePath: '/videos/a.mp4',
          sourceName: 'a.mp4',
          source: {
            sizeBytes: 1000,
            durationSeconds: 20,
            width: 1080,
            height: 1080,
            frameRate: 30,
            codec: 'h264'
          },
          result: null,
          plan: requestFor('/videos/a.mp4').plan,
          destination: { kind: 'beside' },
          outputSuffix: '',
          status: 'running',
          stage: 'joining',
          outputPath: null,
          elapsedMs: null,
          error: null,
          verification: null,
          createdAt: new Date().toISOString()
        }
      ]
    });
    expect(queue.state().jobs[0]).toMatchObject({
      status: 'failed',
      error: 'STITCH_INTERRUPTED'
    });
  });
});

describe('the destination', () => {
  it('replaces the original only after a successful run (FR-021)', async () => {
    const queue = makeQueue();
    const file = await source('overwrite-me.mp4');
    enqueue(queue, file, { destination: { kind: 'overwrite' } });
    await waitFor(() => queue.state().jobs[0]?.status === 'done', { describe: 'the overwrite' });
    expect(queue.state().jobs[0]?.outputPath).toBe(file);
    await queue.shutdown();
  });

  it('reports a destination it cannot write to, and keeps the source', async () => {
    const queue = makeQueue();
    const file = await source('unwritable.mp4');
    enqueue(queue, file, {
      destination: { kind: 'folder', path: path.join(workspace, 'gone') }
    });
    await waitFor(() => queue.state().jobs[0]?.status === 'failed', { describe: 'the failure' });
    expect(queue.state().jobs[0]?.error).toBe('STITCH_OUTPUT_UNWRITABLE');
    expect((await stat(file)).size).toBeGreaterThan(0);
    await queue.shutdown();
  });

  it('leaves the original alone when the run fails', async () => {
    const queue = makeQueue(async () => ({ ok: false, error: 'STITCH_VERIFICATION_FAILED' }));
    const file = await source('keep-me.mp4');
    enqueue(queue, file, { destination: { kind: 'overwrite' } });
    await waitFor(() => queue.state().jobs[0]?.status === 'failed', { describe: 'the failure' });
    expect((await stat(file)).size).toBe('not really a video'.length);
    await queue.shutdown();
  });
});
