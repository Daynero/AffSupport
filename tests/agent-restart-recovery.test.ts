import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { bootAgent, type AgentProcess } from './support/agent-process.js';
import { handlesUnder, isAlive, survivorsOf } from './support/machine-probe.js';
import { describeRequiring, requirePath } from './support/requires.js';
import { writeStubTool } from './support/stub-tools/index.js';
import { waitFor } from './support/wait.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

/**
 * What the next launch finds after the application was cut short.
 *
 * A run that was in flight when the process died is not a run that failed — the user did
 * nothing wrong and their file is fine. Telling the two apart is FR-006, and it is the
 * difference between "try again" and "something is broken with this video". The state that
 * must never appear is the third one: a run reported as still going when nothing is going,
 * which is what sends someone looking for a progress bar that will never move.
 */

/** Probe output the compressor accepts as a real video. */
const PROBE_JSON = JSON.stringify({
  streams: [
    {
      codec_type: 'video',
      width: 1920,
      height: 1080,
      avg_frame_rate: '30/1',
      r_frame_rate: '30/1',
      bit_rate: '2000000',
      codec_name: 'h264',
      duration: '10.0'
    }
  ],
  format: { duration: '10.0', bit_rate: '2000000', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' }
});

interface QueueLike {
  jobs?: { id: string; status: string }[];
  running?: boolean;
}

let agent: AgentProcess | null = null;
let tools = '';

afterEach(async () => {
  const running = agent;
  agent = null;
  if (running) {
    const handles = await handlesUnder(running.pid).catch(() => []);
    await running.stop().catch(() => {});
    for (const survivor of await survivorsOf(handles)) {
      try {
        process.kill(survivor.handle.pid, 'SIGKILL');
      } catch {
        // Already gone, which is the expected case.
      }
    }
  }
  if (tools) await removeTemporaryDirectory(tools);
  tools = '';
});

async function bootWithStubs(): Promise<AgentProcess> {
  tools = await mkdtemp(path.join(os.tmpdir(), 'restart-tools-'));
  const encoder = await writeStubTool(tools, 'stub-ffmpeg', {
    hang: true,
    burnCpu: true,
    burnFuseMs: 60_000,
    writeOutput: true
  });
  const probe = await writeStubTool(tools, 'stub-ffprobe', {
    stdoutText: PROBE_JSON,
    durationMs: 5
  });
  return bootAgent({ env: { FFMPEG_PATH: encoder, FFPROBE_PATH: probe } });
}

/** Adds one file to the compressor and returns the id it was given. */
async function addClip(process_: AgentProcess, name: string): Promise<string> {
  const source = path.join(process_.paths.root, name);
  await writeFile(source, 'source');
  await process_.api('/api/files/add', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths: [source] })
  });
  const state = await process_.api<QueueLike>('/api/queue');
  const added = state.jobs?.at(-1);
  if (!added) throw new Error(`the compressor did not accept ${name}`);
  return added.id;
}

async function waitForDurableProcessing(process_: AgentProcess, id: string): Promise<void> {
  await waitFor(
    async () => {
      const state = JSON.parse(await readFile(process_.paths.state, 'utf8')) as QueueLike;
      return state.jobs?.some(job => job.id === id && job.status === 'processing') ?? false;
    },
    { timeoutMs: 20_000, describe: 'the processing state to reach durable storage' }
  );
}

async function crashAndReapTestTools(process_: AgentProcess): Promise<void> {
  const children = (await handlesUnder(process_.pid)).filter(handle => handle.pid !== process_.pid);
  await process_.crash();
  // SIGKILL cannot run the Agent's normal child cleanup. Reap the test stubs
  // ourselves so a later restart is isolated from the previous test process.
  for (const survivor of await survivorsOf(children)) {
    try {
      process.kill(survivor.handle.pid, 'SIGKILL');
    } catch {
      // It exited between the observation and the signal.
    }
  }
  await waitFor(async () => (await survivorsOf(children)).length === 0, {
    timeoutMs: 5_000,
    describe: 'test tools to exit after the hard crash'
  });
}

describeRequiring(requirePath('apps/agent/dist/index.js'), 'recovering from a hard stop', () => {
  it('presents a run killed mid-encode as interrupted, not failed, and not running', async () => {
    agent = await bootWithStubs();
    const id = await addClip(agent, 'clip.mp4');
    await agent.request('/api/queue/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [id] })
    });
    await waitFor(
      async () => (await agent!.api<QueueLike>('/api/queue')).jobs?.[0]?.status === 'processing',
      { timeoutMs: 20_000, describe: 'the encode to start' }
    );
    await waitForDurableProcessing(agent, id);

    // No warning, no chance to tidy up — the case the persisted state exists for.
    await crashAndReapTestTools(agent);
    await agent.restart();

    const state = await agent.api<QueueLike>('/api/queue');
    const job = state.jobs?.find(candidate => candidate.id === id);

    // The three-way distinction FR-006 is about. `failed` would send the user looking for a
    // problem with their file; `processing` would send them looking for a progress bar that
    // is never going to move.
    expect(job?.status).toBe('interrupted');
    expect(state.running).toBe(false);
  }, 120_000);

  it('offers the interrupted run again rather than resuming it', async () => {
    agent = await bootWithStubs();
    const id = await addClip(agent, 'clip.mp4');
    await agent.request('/api/queue/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [id] })
    });
    await waitFor(
      async () => (await agent!.api<QueueLike>('/api/queue')).jobs?.[0]?.status === 'processing',
      { timeoutMs: 20_000, describe: 'the encode to start' }
    );
    await waitForDurableProcessing(agent, id);
    await crashAndReapTestTools(agent);
    await agent.restart();

    // There is no resume anywhere in the local app, so the only honest thing an interrupted
    // run can offer is starting again from the beginning (FR-008).
    const restarted = await agent.request('/api/queue/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [id] })
    });
    expect(restarted.status).toBe(200);

    await waitFor(
      async () => (await agent!.api<QueueLike>('/api/queue')).jobs?.[0]?.status === 'processing',
      { timeoutMs: 20_000, describe: 'the re-run to start' }
    );

    await agent.request('/api/queue/cancel-all', { method: 'POST' });
  }, 120_000);

  it('reports nothing running across repeated restarts with work in flight', async () => {
    // SC-022 asks for twenty sleep/wake cycles with zero runs reported as running while
    // nothing is. Suspending the machine is not something a test can ask for, so this covers
    // the half that is reachable: the same question across repeated hard restarts, which is
    // the same failure mode — persisted state describing work no process is doing.
    agent = await bootWithStubs();
    const id = await addClip(agent, 'clip.mp4');

    for (let cycle = 0; cycle < 5; cycle += 1) {
      await agent.request('/api/queue/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [id] })
      });
      await waitFor(
        async () => (await agent!.api<QueueLike>('/api/queue')).jobs?.[0]?.status === 'processing',
        { timeoutMs: 20_000, describe: `cycle ${cycle}: the encode to start` }
      );
      await waitForDurableProcessing(agent, id);

      await crashAndReapTestTools(agent);
      await agent.restart();

      const state = await agent.api<QueueLike>('/api/queue');
      expect(state.running, `cycle ${cycle} reported running after a restart`).toBe(false);
      expect(state.jobs?.[0]?.status, `cycle ${cycle}`).toBe('interrupted');
      expect(isAlive(agent.pid)).toBe(true);
    }
  }, 180_000);
});
