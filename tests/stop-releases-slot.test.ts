import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeJob, optimalSettings } from './helpers.js';
import { handleFor, isAlive, survivorsOf, type ProcessHandle } from './support/machine-probe.js';
import { writeStubTool } from './support/stub-tools/index.js';
import { waitFor, waitForValue } from './support/wait.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

/**
 * A stop has to give the queue its place back straight away.
 *
 * Unwinding a stopped encode takes as long as the child takes to honour a signal — and for
 * one that ignores SIGTERM, as long as the escalation deadline. Holding the queue for that
 * long means the user presses stop, presses start on the next file, and nothing happens for
 * two seconds. From the outside that is a stop that did not work, or a start that did not
 * register; either way they press something else, and now there are two problems.
 *
 * So the slot is released when the stop is *signalled*, not when the child finally exits
 * (FR-004). The stopped encoder is still terminated — it carries its own escalation, and a
 * quit still waits for it — it simply no longer occupies the place the next job needs.
 */

let directory = '';
let started: ProcessHandle[] = [];

afterEach(async () => {
  // By identity, never by bare pid. These encoders are expected to be gone by now, and the
  // operating system is free to hand their numbers to something else the moment they are —
  // including a test-runner worker. Signalling a recycled pid is exactly the hazard the
  // machine probe carries a creation time to avoid, and cleanup code is not exempt from it.
  for (const survivor of await survivorsOf(started)) {
    try {
      process.kill(survivor.handle.pid, 'SIGKILL');
    } catch {
      // Gone between the identity check and the signal.
    }
  }
  started = [];
  vi.unstubAllEnvs();
  vi.resetModules();
  if (directory) await removeTemporaryDirectory(directory);
  directory = '';
});

async function queueWithTwoJobs(stub: Parameters<typeof writeStubTool>[2]) {
  directory = await mkdtemp(path.join(os.tmpdir(), 'stop-releases-slot-'));
  const marker = path.join(directory, 'encoder.pid');
  const tool = await writeStubTool(directory, 'stub-ffmpeg', { ...stub, spawnMarker: marker });
  vi.stubEnv('FFMPEG_PATH', tool);
  vi.resetModules();
  const { JobQueue } = await import('../apps/agent/src/queue/queue.js');

  const jobs = [];
  for (const name of ['first', 'second']) {
    const source = path.join(directory, `${name}.mov`);
    await writeFile(source, 'source');
    jobs.push(
      makeJob(name, 'ready', {
        inputPath: source,
        outputPath: path.join(directory, `${name}_compressed.mp4`)
      })
    );
  }

  const queue = new JobQueue(
    { ffmpeg: true, ffprobe: true },
    () => {},
    jobs,
    { ...optimalSettings, outputMode: 'chosen-folder', outputFolder: directory },
    null,
    undefined,
    Math.random,
    { probeMedia: async () => null as never }
  );
  return { queue, marker };
}

/** The pid of whichever encoder is running now, recorded by the stub itself. */
async function currentEncoder(marker: string, notPid = -1): Promise<number> {
  return waitForValue(
    async () => {
      if (!existsSync(marker)) return null;
      const pid = Number(await readMarker(marker));
      return Number.isInteger(pid) && pid > 0 && pid !== notPid ? pid : null;
    },
    { timeoutMs: 20_000, intervalMs: 25, describe: 'the encoder to record its pid' }
  );
}

/** Records an encoder by identity, so cleanup cannot signal a recycled pid. */
async function remember(pid: number): Promise<ProcessHandle | null> {
  const handle = await handleFor(pid);
  if (handle) started.push(handle);
  return handle;
}

async function readMarker(marker: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(marker, 'utf8');
}

describe('stopping one job', () => {
  it('lets the next job start while the stopped one is still unwinding', async () => {
    // The encoder ignores SIGTERM, so its teardown takes the full escalation deadline. That
    // is the window FR-004 is about: if the slot were held until the child exited, the
    // second job could not begin for as long as the first refuses to die.
    const { queue, marker } = await queueWithTwoJobs({
      hang: true,
      ignoreSigterm: true,
      writeOutput: true
    });

    expect(await queue.start(['first', 'second'])).toBe(true);
    const firstEncoder = await currentEncoder(marker);
    await remember(firstEncoder);
    await waitFor(() => queue.state().jobs[0].status === 'processing', {
      describe: 'the first encode to start'
    });

    await queue.cancel('first');

    // The load-bearing assertion, and it has to be about *overlap* rather than about the
    // second job eventually starting. Without FR-004 the second job still starts — it just
    // waits for the first child to die, which for one that ignores SIGTERM is the full
    // escalation deadline. Both versions pass a patient `waitFor`; only one has both
    // encoders alive at the same moment.
    const secondEncoder = await currentEncoder(marker, firstEncoder);
    const firstStillAlive = isAlive(firstEncoder);
    await remember(secondEncoder);

    expect(secondEncoder).not.toBe(firstEncoder);
    expect(
      firstStillAlive,
      'the second encode only started after the stopped one had finished unwinding'
    ).toBe(true);

    await waitFor(() => queue.state().jobs[1].status === 'processing', {
      timeoutMs: 20_000,
      describe: 'the second encode to start'
    });
    expect(queue.state().jobs[0].status).toBe('cancelled');

    await queue.cancelAll();
    await queue.shutdown();
  }, 60_000);

  it('still terminates the encoder it released the slot from', async () => {
    // Releasing the slot must not mean losing the child. The queue no longer refers to it,
    // so the guarantee rests on the escalation the spawn seam armed — and this is the case
    // where that matters, because the encoder never handles the polite signal.
    const { queue, marker } = await queueWithTwoJobs({
      hang: true,
      ignoreSigterm: true,
      writeOutput: true
    });

    expect(await queue.start(['first'])).toBe(true);
    const encoder = await currentEncoder(marker);
    const handle = await remember(encoder);
    expect(handle).not.toBeNull();

    await queue.cancel('first');

    await waitFor(async () => (await survivorsOf([handle!])).length === 0, {
      timeoutMs: 20_000,
      intervalMs: 50,
      describe: 'the released encoder to be gone'
    });

    await queue.shutdown();
  }, 60_000);

  it('does not let a quit outrun the termination it started', async () => {
    // The other half of releasing the slot early: between the signal and the exit, the queue
    // has moved on. An agent that quit in that window would leave a child with nothing left
    // running to escalate its termination, and a child that ignores SIGTERM would simply
    // carry on — the orphan this whole area exists to prevent.
    const { queue, marker } = await queueWithTwoJobs({
      hang: true,
      ignoreSigterm: true,
      writeOutput: true
    });

    expect(await queue.start(['first'])).toBe(true);
    const encoder = await currentEncoder(marker);
    const handle = await remember(encoder);

    await queue.cancel('first');
    await queue.shutdown();

    expect((await survivorsOf([handle!])).length).toBe(0);
  }, 60_000);
});
