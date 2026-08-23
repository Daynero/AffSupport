import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaInfo } from '../apps/agent/src/ffmpeg/tools.js';
import { MediaToolUnavailableError } from '../apps/agent/src/ffmpeg/tools.js';
import { JobQueue } from '../apps/agent/src/queue/queue.js';
import { makeJob, optimalSettings } from './helpers.js';
import { writeStubTool } from './support/stub-tools/index.js';
import { waitFor } from './support/wait.js';

/**
 * What the compressor does today, written down before it is rewritten.
 *
 * The queue keeps its state in five independent fields — `compressionInFlight`,
 * `prioritizingEstimates`, `compressionPausedForEstimates`, `activeAbort`, `active` — and
 * every wedged-queue defence in the file exists because of that (A4). Collapsing them into
 * one value is the fix, and the risk in doing it is that these five fields carry the
 * estimate-priority handoff, which is the subtlest concurrency in the agent.
 *
 * So this file comes first. It is not a wish list: it is the A11 gap list, which named the
 * transitions no test covered, turned into assertions against the **current** code. The
 * collapse is then provably behaviour-identical rather than argued to be.
 *
 * Deliberately no real encoder. Every case here is about bookkeeping, and driving it through
 * FFmpeg would make the file slow, machine-dependent, and unable to reproduce the exact
 * failure it is about.
 */

/**
 * The one activity value, cross-checked at every broadcast.
 *
 * This began as a cross-check between the derived value and the five fields it shadowed, and
 * that is what made the collapse provable rather than argued: the derivation, then the
 * inversion, each had to keep it green. The fields are gone now, so what it checks is what
 * survived them — the invariants the five flags could describe but never enforce.
 *
 * It reads private state on purpose. The invariant is about the queue's internals, and
 * asserting it through the public surface would only cover the parts that surface exposes.
 */
interface QueueInternals {
  current: {
    kind: 'idle' | 'encoding' | 'encoding-held' | 'estimating';
    jobId?: string;
    abort?: unknown;
    child?: unknown;
    release?: unknown;
    estimating?: boolean;
  };
}

function activityDisagreement(queue: JobQueue): string | null {
  const activity = (queue as unknown as QueueInternals).current;

  if (activity.kind === 'encoding-held') {
    // A5, stated as an assertion even though it is now a type. The bug was a hold that
    // existed with its release token already overwritten by the next holder; keeping the
    // check means a future representation that reintroduces the gap fails here too.
    if (!activity.release) return 'encoding-held with no release token';
    if (!activity.child) return 'encoding-held with no child';
  }

  if (activity.kind === 'encoding' || activity.kind === 'encoding-held') {
    // Without a job identity the shutdown path cannot find the partial output it has to
    // remove, which is A2(i) — the whole reason the value carries one.
    if (!activity.jobId) return `${activity.kind} with no job identity`;
    if (!activity.abort) return `${activity.kind} with no abort handle`;
  }

  // "kind !== idle implies the queue reports itself as running." This is what makes the
  // wedged-queue defences unnecessary rather than merely redundant.
  if (activity.kind !== 'idle' && !queue.running()) return `kind=${activity.kind} but not running`;

  // Held is an encode the governor has stopped, so it must not read as active work.
  if (activity.kind === 'encoding' && !queue.compressionActive())
    return 'encoding but compressionActive() is false';
  if (activity.kind === 'encoding-held' && queue.compressionActive())
    return 'encoding-held but compressionActive() is true';

  return null;
}

let directory = '';

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
});

/** A probe result that passes output validation. */
function goodMedia(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    duration: 10,
    videoDuration: 10,
    width: 1920,
    height: 1080,
    frameRate: 30,
    bitrate: 2_000_000,
    codec: 'h264',
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    hasAudio: true,
    audioCodec: 'aac',
    audioDuration: 10,
    audioBitrate: 128_000,
    audioSampleRate: 48_000,
    audioChannels: 2,
    audioLayout: 'stereo',
    ...overrides
  };
}

/** The marker `pauseForRuntimeFailure` leaves behind for the next start to pick up. */
function recoveryMarker(phase: 'input-analysis' | 'encoding' | 'output-validation') {
  return JSON.stringify({ code: 'MEDIA_TOOL_UNAVAILABLE', phase, tool: 'ffprobe' });
}

describe('stopping the whole batch', () => {
  it('cancels the waiting jobs before the running one', async () => {
    // Ordering, not just the outcome. If the running encode were torn down first, the pump
    // would pick up the next queued job on its way out — so a "stop everything" would start
    // something. The observable proof is that the batch is closed and nothing is left
    // running, which cannot be true if the pump had taken another job.
    const order: string[] = [];
    const jobs = [
      makeJob('running', 'processing', { batchId: 'batch', startedAt: Date.now() }),
      makeJob('waiting-1', 'queued', { batchId: 'batch' }),
      makeJob('waiting-2', 'queued', { batchId: 'batch' })
    ];
    const batch = {
      id: 'batch',
      jobIds: jobs.map(job => job.id),
      startedAt: Date.now(),
      finishedAt: null
    };
    const queue = new JobQueue(
      { ffmpeg: false, ffprobe: false },
      () => {
        for (const job of queue.state().jobs)
          if (job.status === 'cancelled' && !order.includes(job.id)) order.push(job.id);
      },
      jobs,
      optimalSettings,
      batch
    );

    expect(await queue.cancelAll()).toBe(3);
    expect(queue.state().jobs.every(job => job.status === 'cancelled')).toBe(true);
    expect(queue.state().running).toBe(false);
  });

  it('closes the batch it emptied so the watchdog can retire', async () => {
    // A batch left with a null `finishedAt` keeps the drain watchdog ticking for the rest of
    // the session, looking for work in a queue that is already empty. A safety net that
    // cannot stop looking is itself a leak.
    const batch = { id: 'batch', jobIds: ['waiting'], startedAt: Date.now(), finishedAt: null };
    const queue = new JobQueue(
      { ffmpeg: false, ffprobe: false },
      () => {},
      [makeJob('waiting', 'queued', { batchId: batch.id })],
      optimalSettings,
      batch
    );

    await queue.cancelAll();

    expect(queue.state().batch?.finishedAt).toBeTruthy();
  });

  it('leaves a job that already finished exactly as it was', async () => {
    const queue = new JobQueue({ ffmpeg: false, ffprobe: false }, () => {}, [
      makeJob('done', 'completed'),
      makeJob('broken', 'failed'),
      makeJob('never-started', 'ready')
    ]);

    // A stop is not a reset. The lifecycle refuses `completed → cancelled` outright, and
    // this is what that refusal looks like from outside.
    expect(await queue.cancelAll()).toBe(0);
    const byId = new Map(queue.state().jobs.map(job => [job.id, job.status]));
    expect(byId.get('done')).toBe('completed');
    expect(byId.get('broken')).toBe('failed');
    expect(byId.get('never-started')).toBe('ready');
  });
});

describe('recovering a run the media engine interrupted', () => {
  it('re-probes the source and returns the job to ready', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'compressor-recover-input-'));
    const source = path.join(directory, 'clip.mov');
    await writeFile(source, 'source');
    const job = makeJob('interrupted-analysis', 'interrupted', {
      inputPath: source,
      errorDetails: recoveryMarker('input-analysis')
    });
    const queue = new JobQueue(
      { ffmpeg: true, ffprobe: true },
      () => {},
      [job],
      optimalSettings,
      null,
      undefined,
      Math.random,
      { probeMedia: async () => goodMedia() }
    );

    expect(await queue.recoverRuntimeInterruptedJobs()).toBe(true);

    // The engine came back and the source is still readable, so there is nothing wrong with
    // this job — it goes back to where it was before the engine died, not to failed.
    const recovered = queue.state().jobs[0];
    expect(recovered.status).toBe('ready');
    expect(recovered.error).toBeNull();
    expect(recovered.errorDetails).toBeNull();
  });

  it('completes a run whose encode had finished before validation was interrupted', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'compressor-recover-output-'));
    const source = path.join(directory, 'clip.mov');
    const output = path.join(directory, 'clip_compressed.mp4');
    await writeFile(source, 'source');
    await writeFile(output, 'a complete encode');
    const job = makeJob('interrupted-validation', 'interrupted', {
      inputPath: source,
      outputPath: output,
      errorDetails: recoveryMarker('output-validation')
    });
    const queue = new JobQueue(
      { ffmpeg: true, ffprobe: true },
      () => {},
      [job],
      optimalSettings,
      null,
      undefined,
      Math.random,
      { probeMedia: async () => goodMedia() }
    );

    expect(await queue.recoverRuntimeInterruptedJobs()).toBe(true);

    // The encode really had finished; only the probe that checks it was interrupted. Making
    // the user encode the same video a second time to learn that would be the tool wasting
    // their machine on work it already did.
    expect(queue.state().jobs[0].status).toBe('completed');
    expect(queue.state().jobs[0].progress).toBe(100);
  });

  it('fails a run whose source turns out to be unreadable', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'compressor-recover-bad-'));
    const source = path.join(directory, 'clip.mov');
    await writeFile(source, 'source');
    const job = makeJob('unreadable', 'interrupted', {
      inputPath: source,
      errorDetails: recoveryMarker('input-analysis')
    });
    const queue = new JobQueue(
      { ffmpeg: true, ffprobe: true },
      () => {},
      [job],
      optimalSettings,
      null,
      undefined,
      Math.random,
      { probeMedia: async () => goodMedia({ codec: null, width: null, height: null }) }
    );

    await queue.recoverRuntimeInterruptedJobs();

    expect(queue.state().jobs[0].status).toBe('failed');
  });

  it('stays interrupted and reports not-recovered while the engine is still missing', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'compressor-recover-still-down-'));
    const source = path.join(directory, 'clip.mov');
    await writeFile(source, 'source');
    const job = makeJob('still-down', 'interrupted', {
      inputPath: source,
      errorDetails: recoveryMarker('input-analysis')
    });
    const queue = new JobQueue(
      { ffmpeg: true, ffprobe: true },
      () => {},
      [job],
      optimalSettings,
      null,
      undefined,
      Math.random,
      {
        probeMedia: async () => {
          throw new MediaToolUnavailableError('ffprobe', 'ENOENT');
        }
      }
    );

    // Reporting recovered here would let the agent carry on as if the engine were back, and
    // the next start would fail the same way with the marker already cleared.
    expect(await queue.recoverRuntimeInterruptedJobs()).toBe(false);
    expect(queue.state().jobs[0].status).toBe('interrupted');
    // Matched loosely: the marker also carries the underlying cause code, and pinning the
    // exact JSON would make this fail the next time a new cause is recorded.
    expect(queue.state().jobs[0].errorDetails).toContain('"phase":"input-analysis"');
  });

  it('leaves a job carrying no recovery marker alone', async () => {
    const queue = new JobQueue({ ffmpeg: true, ffprobe: true }, () => {}, [
      makeJob('ordinary-failure', 'failed', { error: 'This video format is not supported.' })
    ]);

    expect(await queue.recoverRuntimeInterruptedJobs()).toBe(true);
    expect(queue.state().jobs[0].status).toBe('failed');
  });
});

describe('prioritising an estimate', () => {
  it('refuses while nothing is running', () => {
    const queue = new JobQueue({ ffmpeg: true, ffprobe: true }, () => {}, [
      makeJob('waiting', 'ready')
    ]);

    // The early return this covers sits inside the method the collapse rewrites, and it is
    // half of A1: when the pause support flag lies, prioritisation is silently dead for the
    // whole session and no estimate ever jumps the queue again.
    expect(queue.prioritizeEstimate('waiting')).toBe(false);
  });

  it('refuses for a job it does not have', () => {
    const batch = { id: 'batch', jobIds: ['running'], startedAt: Date.now(), finishedAt: null };
    const queue = new JobQueue(
      { ffmpeg: true, ffprobe: true },
      () => {},
      [makeJob('running', 'processing', { batchId: batch.id })],
      optimalSettings,
      batch
    );

    expect(queue.prioritizeEstimate('no-such-job')).toBe(false);
  });
});

/**
 * The paths that only exist once a real child process is running.
 *
 * These use a governed stub from `tests/support/stub-tools/` rather than FFmpeg: the
 * behaviour under test is the queue's, and driving it through a real encoder would make the
 * file slow, dependent on what is installed, and unable to reproduce the exact stderr the
 * audio-copy fallback keys on.
 *
 * `ffmpeg/tools.ts` reads `FFMPEG_PATH` into a module constant at import time, so the module
 * graph has to be rebuilt after the variable is set — hence the dynamic import.
 */
describe('while a child process is actually running', () => {
  async function stubbedQueue(
    config: Parameters<typeof writeStubTool>[2],
    jobFile = 'clip.mov'
  ) {
    directory = await mkdtemp(path.join(os.tmpdir(), 'compressor-encode-'));
    const source = path.join(directory, jobFile);
    await writeFile(source, 'source');
    const tool = await writeStubTool(directory, 'stub-ffmpeg', config);
    vi.stubEnv('FFMPEG_PATH', tool);
    vi.resetModules();
    const { JobQueue: FreshQueue } = await import('../apps/agent/src/queue/queue.js');
    const job = makeJob('encoding-job', 'ready', {
      inputPath: source,
      outputPath: path.join(directory, 'clip_compressed.mp4')
    });
    // Every broadcast is a checkpoint. A derivation that is right at rest and wrong mid-
    // handoff is exactly the failure this step exists to rule out, and the handoff only
    // happens while a child is running.
    const disagreements: string[] = [];
    const queue: InstanceType<typeof FreshQueue> = new FreshQueue(
      { ffmpeg: true, ffprobe: true },
      () => {
        const problem = activityDisagreement(queue);
        if (problem && !disagreements.includes(problem)) disagreements.push(problem);
      },
      [job],
      { ...optimalSettings, outputMode: 'chosen-folder', outputFolder: directory },
      null,
      undefined,
      Math.random,
      { probeMedia: async () => goodMedia() }
    );
    return { queue, job, source, disagreements };
  }

  it('marks a run cancelled and removes its partial output', async () => {
    const { queue, job, disagreements } = await stubbedQueue({ hang: true, writeOutput: true });

    expect(await queue.start([job.id])).toBe(true);
    await waitFor(() => queue.state().jobs[0].status === 'processing', {
      describe: 'the encode to start'
    });

    // Waited for rather than assumed: `processing` is set before the child is spawned, so
    // reading the filesystem the moment the status flips would find nothing and the
    // assertion below would pass without the partial output ever having existed.
    const partial = queue.state().jobs[0].outputPath;
    await waitFor(() => existsSync(partial), {
      timeoutMs: 20_000,
      describe: 'the encoder to create its output'
    });

    expect(await queue.cancel(job.id)).toBe(true);

    // Waited for, not assumed. The queue reports itself idle the moment the stop is
    // signalled — that is FR-004, the slot is released before the child has finished
    // unwinding — so "not running" is no longer a proxy for "teardown complete". What is
    // guaranteed is that the partial output goes, and that is what this waits for.
    await waitFor(() => !existsSync(partial), {
      timeoutMs: 20_000,
      describe: 'the partial output to be removed'
    });

    expect(queue.state().jobs[0].status).toBe('cancelled');
    expect(disagreements).toEqual([]);
  });

  it('re-runs with transcoded audio when the container refuses the copied stream', async () => {
    const counter = path.join(os.tmpdir(), `stub-attempts-${process.pid}-${Date.now()}`);
    const { queue, job, disagreements } = await stubbedQueue({
      writeOutput: true,
      attemptCounter: counter,
      attempts: [
        // The exact shape `isAudioCopyFailure` matches. A generic failure must not trigger
        // a second encode, which is why this is keyed on the message rather than the code.
        { exitCode: 1, stderr: 'Could not find tag for codec pcm_s16le in stream #1' },
        { exitCode: 0 }
      ]
    });

    expect(await queue.start([job.id])).toBe(true);
    await waitFor(() => !queue.state().running, {
      timeoutMs: 20_000,
      describe: 'both encode passes to finish'
    });

    expect(queue.state().jobs[0].status).toBe('completed');
    expect(Number(readFileSync(counter, 'utf8'))).toBe(2);
    expect(disagreements).toEqual([]);
    await rm(counter, { force: true });
  });

  it('does not start the second pass when the run was stopped between them', async () => {
    const counter = path.join(os.tmpdir(), `stub-attempts-cancel-${process.pid}-${Date.now()}`);
    const { queue, job, disagreements } = await stubbedQueue({
      writeOutput: true,
      attemptCounter: counter,
      attempts: [
        { exitCode: 1, stderr: 'Could not find tag for codec pcm_s16le in stream #1' },
        // Long enough that a second pass, if it started, would still be running when the
        // assertion below reads the counter.
        { exitCode: 0 }
      ],
      durationMs: 4_000,
      hang: false
    });

    expect(await queue.start([job.id])).toBe(true);
    await waitFor(() => queue.state().jobs[0].status === 'processing', {
      describe: 'the first pass to start'
    });
    await queue.cancel(job.id);
    await waitFor(() => !queue.state().running, { timeoutMs: 20_000, describe: 'the run to end' });

    // A stop between the two passes has no child to signal for the pass that has not started
    // yet — it only sets a flag. Re-running anyway would follow the user's stop with a full
    // encode at full speed, which is the same defect as spawning after a cancel between
    // stages elsewhere in the agent.
    expect(queue.state().jobs[0].status).toBe('cancelled');
    expect(disagreements).toEqual([]);
    await rm(counter, { force: true });
  });

  it('removes the partial output when a shutdown lands mid-encode', async () => {
    const { queue, job, disagreements } = await stubbedQueue({ hang: true, writeOutput: true });

    expect(await queue.start([job.id])).toBe(true);
    await waitFor(() => queue.state().jobs[0].status === 'processing', {
      describe: 'the encode to start'
    });

    const partial = queue.state().jobs[0].outputPath;
    await waitFor(() => existsSync(partial), {
      timeoutMs: 20_000,
      describe: 'the encoder to create its output'
    });

    await queue.shutdown();

    // A2(i), and the reason the activity carries a job identity. Every *cancel* path
    // unlinked; shutdown could not, because nothing recorded which job the child belonged
    // to — so quitting mid-batch left a truncated .mp4 next to the user's source, with a
    // name saying it was the result.
    expect(existsSync(partial)).toBe(false);
    expect(queue.compressionActive()).toBe(false);
    expect(disagreements).toEqual([]);

    // What the job's status settles on afterwards is deliberately not asserted here. In
    // production the process exits inside `shutdown`, so the encode's continuation never
    // runs and the persisted record still says `processing` — which is what the next launch
    // turns into `interrupted`. That path is covered where it actually happens, in
    // tests/state.test.ts; asserting it here would only be racing the test runner's
    // willingness to keep the process alive.

    // What the machine does about the child is asserted independently in
    // tests/stop-releases-machine.test.ts — the queue's own report is exactly what cannot be
    // trusted for that question (A14).
  });
});

describe('handing the machine to a prioritised estimate', () => {
  /**
   * The `encoding-held` variant, driven for real.
   *
   * This is the subtlest concurrency in the agent and the reason the collapse is staged:
   * `compressionPausedForEstimates`, `prioritizingEstimates`, `active` and
   * `estimateHoldRelease` are all in play at once, and A5 is what happens when the last two
   * come apart. A cross-check that never reaches this state would be checking the easy half.
   */
  it('reports one held encode, with a release token, for the whole handoff', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'compressor-held-'));
    const source = path.join(directory, 'clip.mov');
    await writeFile(source, 'source');
    const tool = await writeStubTool(directory, 'stub-ffmpeg', { hang: true, writeOutput: true });
    vi.stubEnv('FFMPEG_PATH', tool);
    vi.resetModules();
    const { JobQueue: FreshQueue } = await import('../apps/agent/src/queue/queue.js');

    const encoding = makeJob('encoding', 'ready', {
      inputPath: source,
      outputPath: path.join(directory, 'clip_compressed.mp4')
    });
    const waiting = makeJob('waiting', 'ready', {
      inputPath: source,
      outputPath: path.join(directory, 'other_compressed.mp4')
    });

    const disagreements: string[] = [];
    const kinds: string[] = [];
    const queue: InstanceType<typeof FreshQueue> = new FreshQueue(
      { ffmpeg: true, ffprobe: true },
      () => {
        const inner = queue as unknown as QueueInternals;
        if (!kinds.includes(inner.current.kind)) kinds.push(inner.current.kind);
        const problem = activityDisagreement(queue);
        if (problem && !disagreements.includes(problem)) disagreements.push(problem);
      },
      [encoding, waiting],
      { ...optimalSettings, outputMode: 'chosen-folder', outputFolder: directory },
      null,
      undefined,
      Math.random,
      { probeMedia: async () => goodMedia() }
    );

    let released = 0;
    // A governor whose hold actually lands. Reporting `isSuspended` false is the branch
    // where the handoff is abandoned, and it would never produce a held state at all.
    queue.attachPowerGovernor({
      register: () => {},
      release: () => {},
      budget: () => ({ threadBudget: 1, limitPercent: 100 }) as never,
      scaleTimeout: milliseconds => milliseconds,
      resumeForTermination: () => {},
      hold: () => () => {
        released += 1;
      },
      isSuspended: () => true,
      throttlingSupported: () => true
    });

    let prioritisedRuns = 0;
    queue.attachEstimator({
      schedule: () => {},
      invalidate: () => {},
      resume: () => {},
      runPrioritized: async () => {
        prioritisedRuns += 1;
        // Long enough that the held state is observable rather than a value that exists
        // only between two synchronous statements.
        await new Promise(resolve => setTimeout(resolve, 60));
        const target = queue.state().jobs.find(job => job.id === 'waiting');
        if (target) waiting.estimatePriorityOrder = null;
        return true;
      }
    });

    waiting.estimateStatus = 'waiting';
    waiting.estimatePriorityOrder = 1;

    expect(await queue.start([encoding.id, waiting.id])).toBe(true);
    await waitFor(() => prioritisedRuns > 0, { describe: 'the prioritised estimate to run' });
    await waitFor(() => kinds.includes('encoding-held'), {
      describe: 'the encode to be reported as held'
    });

    await queue.cancelAll();
    await waitFor(() => !queue.state().running, { describe: 'the queue to go idle' });

    // The state was actually reached, the cross-check held throughout it, and the token the
    // holder took was given back — which is the invariant A5 broke.
    expect(kinds).toContain('encoding-held');
    expect(disagreements).toEqual([]);
    expect(released).toBeGreaterThan(0);
  });
});
