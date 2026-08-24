import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeJob, optimalSettings } from './helpers.js';
import {
  describeSurvivors,
  handleFor,
  readProcessTable,
  sampleMachine,
  survivorsOf,
  type MachineSample,
  type ProcessHandle
} from './support/machine-probe.js';
import { writeStubTool } from './support/stub-tools/index.js';
import { waitFor, waitForValue } from './support/wait.js';

/**
 * A stop has to make the machine go quiet, not make a status field change.
 *
 * The best stop test in this suite asserts on the `close` event's signal argument (A14) —
 * Node's report of what Node did. A termination that escalated wrongly, or a grandchild that
 * outlived its parent, leaves it green, because it is reading the same opinion that produced
 * the bug. Everything here asks the operating system instead, through
 * `tests/support/machine-probe.ts`, which shares no code with the thing it is checking.
 *
 * Two windows, from SC-002. Five seconds for the processes to be gone, ten for consumption
 * to be back at idle — the second is longer because a machine does not stop being warm the
 * instant the last process exits.
 *
 * **Never skipped for noise.** The quantity is Soty's share of the machine, computed over the
 * tree the harness itself spawned, so a busy runner cannot push it up. "Two percent" cannot
 * be produced by someone else's build; only by a leak.
 */

const PROCESS_GONE_MS = 5_000;
const CONSUMPTION_IDLE_MS = 10_000;
/** SC-002's bound: Soty's share of the whole machine once its work has stopped. */
const IDLE_SHARE_PERCENT = 2;

let directory = '';
let started: ProcessHandle[] = [];

afterEach(async () => {
  // Whatever the assertions concluded, nothing this file spawned may outlive it. A test
  // about leaked processes that leaks processes would be worse than no test.
  for (const handle of await survivorsOf(started)) {
    try {
      process.kill(handle.handle.pid, 'SIGKILL');
    } catch {
      // Already gone between the check and the signal.
    }
  }
  started = [];
  vi.unstubAllEnvs();
  vi.resetModules();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
});

async function encodingQueue(stub: Parameters<typeof writeStubTool>[2]) {
  directory = await mkdtemp(path.join(os.tmpdir(), 'stop-releases-'));
  const source = path.join(directory, 'clip.mov');
  await writeFile(source, 'source');
  // The encoder writes its own pid here. Identifying it by a tree walk instead would mean
  // competing with whatever else the harness is running at that instant — including the
  // probe's own `ps` — and a handle for the wrong process makes every assertion below
  // vacuous rather than wrong, which is worse.
  const marker = path.join(directory, 'encoder.pid');
  const tool = await writeStubTool(directory, 'stub-ffmpeg', { ...stub, spawnMarker: marker });
  vi.stubEnv('FFMPEG_PATH', tool);
  vi.resetModules();
  const { JobQueue } = await import('../apps/agent/src/queue/queue.js');

  const job = makeJob('encoding', 'ready', {
    inputPath: source,
    outputPath: path.join(directory, 'clip_compressed.mp4')
  });
  const queue = new JobQueue(
    { ffmpeg: true, ffprobe: true },
    () => {},
    [job],
    { ...optimalSettings, outputMode: 'chosen-folder', outputFolder: directory },
    null,
    undefined,
    Math.random,
    { probeMedia: async () => null as never }
  );
  return { queue, job, marker };
}

/** Waits until the encoder is really running, and takes its identity from the marker. */
async function runningEncoder(
  queue: { state: () => { jobs: { status: string }[] } },
  marker: string
): Promise<ProcessHandle> {
  await waitFor(() => queue.state().jobs[0].status === 'processing', {
    describe: 'the encode to start'
  });
  // The pid comes from the child itself, and the identity from the operating system. Neither
  // comes from the queue — the bookkeeping a bug would have lost is exactly what is under
  // test.
  const handle = await waitForValue(
    async () => {
      const pid = Number(readFileSync(marker, 'utf8'));
      return Number.isInteger(pid) ? await handleFor(pid) : null;
    },
    { describe: 'the encoder to record its pid' }
  );
  started = [handle];
  return handle;
}

describe('a stop leaves nothing running', () => {
  it('removes every process the run spawned, within five seconds', async () => {
    const { queue, job, marker } = await encodingQueue({
      hang: true,
      burnCpu: true,
      burnFuseMs: 30_000
    });
    expect(await queue.start([job.id])).toBe(true);
    const encoder = await runningEncoder(queue, marker);

    await queue.cancel(job.id);

    let survivors = await survivorsOf([encoder]);
    await waitFor(
      async () => {
        survivors = await survivorsOf([encoder]);
        return survivors.length === 0;
      },
      { timeoutMs: PROCESS_GONE_MS, intervalMs: 50, describe: 'the encoder to be gone' }
    ).catch(() => {
      // Swallowed so the assertion below reports *which* process survived and how, rather
      // than a timeout that says only that something did.
    });

    // "left running" and "left suspended" are different bugs and are named separately: a
    // suspended orphan consumes nothing, so every other check here would call it a clean
    // stop.
    expect(describeSurvivors(survivors)).toBe('');
  }, 60_000);

  it('brings consumption back to idle within ten seconds', async () => {
    const { queue, job, marker } = await encodingQueue({
      hang: true,
      burnCpu: true,
      burnFuseMs: 30_000
    });
    expect(await queue.start([job.id])).toBe(true);
    await runningEncoder(queue, marker);

    // Establish that there was something to bring down. An idle assertion that passes over a
    // stub which never worked is the vacuous version of this test.
    let sample: MachineSample = await sampleMachine(process.pid);
    await waitFor(
      async () => {
        sample = await sampleMachine(process.pid, sample);
        return sample.sotySharePercent > IDLE_SHARE_PERCENT;
      },
      {
        timeoutMs: 25_000,
        intervalMs: 250,
        describe: 'the encoder to consume the machine'
      }
    );

    await queue.cancel(job.id);

    let idle = false;
    await waitFor(
      async () => {
        sample = await sampleMachine(process.pid, sample);
        idle = sample.sotySharePercent <= IDLE_SHARE_PERCENT;
        return idle;
      },
      { timeoutMs: CONSUMPTION_IDLE_MS, intervalMs: 250, describe: 'consumption to reach idle' }
    ).catch(() => {});

    // The machine-wide idle baseline is recorded and never subtracted: subtracting runner
    // noise is exactly how a leaked process gets hidden behind it.
    expect(
      idle,
      `share ${sample.sotySharePercent.toFixed(1)}% of ${sample.totalCapacityCores} cores, ` +
        `machine idle ${sample.machineIdlePercent.toFixed(1)}%`
    ).toBe(true);
  }, 60_000);

  it('removes a child that ignores the polite signal, rather than leaving it running', async () => {
    // Not a contrived case: a process wedged inside a native inference loop never reaches its
    // SIGTERM handler either, and from outside the two are indistinguishable. Either way a
    // stop that only sends SIGTERM leaves the machine busy.
    const { queue, job, marker } = await encodingQueue({
      hang: true,
      burnCpu: true,
      ignoreSigterm: true,
      burnFuseMs: 30_000
    });
    expect(await queue.start([job.id])).toBe(true);
    const encoder = await runningEncoder(queue, marker);

    await queue.cancel(job.id);

    let survivors = await survivorsOf([encoder]);
    await waitFor(
      async () => {
        survivors = await survivorsOf([encoder]);
        return survivors.length === 0;
      },
      { timeoutMs: PROCESS_GONE_MS, intervalMs: 50, describe: 'the escalation to land' }
    ).catch(() => {});

    expect(describeSurvivors(survivors)).toBe('');
  }, 60_000);

  it('finds an abandoned grandchild that the exit signal reports nothing about', async () => {
    // The failure A14 is about, staged deliberately. The encoder exits exactly as a healthy
    // one does — same `close` event, same signal — while a detached child it spawned is still
    // burning a core, reparented away so even the agent's own process-tree walk no longer
    // reaches it. A signal-based test calls this a clean stop.
    const { queue, job, marker } = await encodingQueue({
      hang: true,
      grandchildren: 1,
      grandchildFuseMs: 20_000
    });
    expect(await queue.start([job.id])).toBe(true);
    const encoder = await runningEncoder(queue, marker);

    // The grandchild is found the way the probe finds anything: by reading the whole table.
    // What identifies it there is parentage, not novelty — "a `node` that was not running a
    // moment ago" also describes every stub another test file spawns while this one runs, and
    // adopting one of those as the orphan makes the assertion below fail for a reason that has
    // nothing to do with stopping. `detached: true` opens a new session but does not reparent,
    // so while the encoder is alive its grandchild is exactly the row whose ppid is the
    // encoder's pid. The abandonment this test is about happens later, when the encoder dies
    // and the operating system moves the survivor to init — out of reach of any tree walk.
    const orphan = await waitForValue(
      async () => {
        const fresh = (await readProcessTable()).find(
          row => row.ppid === encoder.pid && /node/i.test(row.name)
        );
        return fresh ? { pid: fresh.pid, createdAt: fresh.createdAt, name: fresh.name } : null;
      },
      { describe: 'the abandoned grandchild to appear' }
    );
    started = [encoder, orphan];

    await queue.cancel(job.id);
    await waitFor(async () => (await survivorsOf([encoder])).length === 0, {
      timeoutMs: PROCESS_GONE_MS,
      intervalMs: 50,
      describe: 'the tracked encoder to be gone'
    });

    // The encoder is gone and the orphan is not — which is the whole point. The probe can
    // state that; the exit signal cannot, because it never knew the orphan existed.
    const remaining = await survivorsOf([encoder, orphan]);
    expect(remaining.map(survivor => survivor.handle.pid)).toEqual([orphan.pid]);
    expect(describeSurvivors(remaining)).toContain('left running');
  }, 60_000);
});
