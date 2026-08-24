import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bootAgent, type AgentProcess } from './support/agent-process.js';
import { INTERLEAVING_SCENARIOS, toolsIn, type ToolId } from './support/interleaving-scenarios.js';
import { DRIVABLE_TOOLS, runScenario, type ScenarioResult } from './support/interleaving-runner.js';
import { describeSurvivors, handlesUnder, survivorsOf } from './support/machine-probe.js';
import { describeRequiring, requirePath } from './support/requires.js';
import { writeStubTool } from './support/stub-tools/index.js';

/**
 * The feature's core guarantee, walked end to end.
 *
 * Everything else in this suite checks one operation at a time. What breaks in practice is
 * *sequences*: a stop that lands while another tool is starting, a stop-all that has to leave
 * a second tool's work alone, a re-run of something that was stopped, a restart with work in
 * flight. The scenarios in `tests/support/interleaving-scenarios.ts` are those sequences as
 * data; this walks them against a real, out-of-process local app and asks the operating
 * system — not the app — what is running after every step.
 *
 * The tools are stand-ins from `tests/support/stub-tools/`, and deliberately so. What is
 * under test is the application's bookkeeping across a sequence, not FFmpeg's output, and a
 * suite that needed real encoders would be slow enough that nobody ran it.
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
    },
    {
      codec_type: 'audio',
      codec_name: 'aac',
      duration: '10.0',
      bit_rate: '128000',
      sample_rate: '48000',
      channels: 2,
      channel_layout: 'stereo'
    }
  ],
  format: { duration: '10.0', bit_rate: '2128000', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' }
});

const builtAgent = requirePath('apps/agent/dist/index.js');

describeRequiring(builtAgent, 'interleaved work behaves predictably', () => {
  let root = '';
  let agent: AgentProcess;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'interleaving-'));
    const tools = path.join(root, 'tools');
    await mkdtemp(tools).catch(() => {});
    const encoder = await writeStubTool(root, 'stub-ffmpeg', {
      progress: true,
      durationMs: 4_000,
      burnCpu: true,
      burnFuseMs: 60_000,
      writeOutput: true
    });
    const probe = await writeStubTool(root, 'stub-ffprobe', {
      stdoutText: PROBE_JSON,
      durationMs: 5
    });
    const transcriber = await writeStubTool(root, 'stub-whisper', {
      durationMs: 4_000,
      burnCpu: true,
      burnFuseMs: 60_000
    });
    // Transcription refuses to start without a model, and downloading a multi-gigabyte one
    // to check bookkeeping would be absurd. A file in its place is all the presence check
    // reads, and the stand-in transcriber never opens it.
    const model = path.join(root, 'ggml-large-v3.bin');
    await writeFile(model, 'not really a model');

    agent = await bootAgent({
      env: {
        FFMPEG_PATH: encoder,
        FFPROBE_PATH: probe,
        WHISPER_PATH: transcriber,
        WHISPER_MODEL_PATH: model,
        AGENT_NATIVE_TOKEN: 'interleaving-native-token'
      }
    });
  }, 120_000);

  afterAll(async () => {
    // Whatever the assertions concluded, nothing this file started may outlive it.
    if (agent) {
      const handles = await handlesUnder(agent.pid).catch(() => []);
      await agent.stop().catch(() => {});
      for (const survivor of await survivorsOf(handles)) {
        try {
          process.kill(survivor.handle.pid, 'SIGKILL');
        } catch {
          // Already gone between the check and the signal.
        }
      }
    }
    if (root) await rm(root, { recursive: true, force: true });
  }, 120_000);

  const cases = INTERLEAVING_SCENARIOS.map(scenario => [scenario.id, scenario] as const);

  it.each(cases)(
    '%s',
    async (_id, scenario) => {
      let result: ScenarioResult;
      try {
        result = await runScenario(scenario, agent, root);
      } catch (error) {
        // The runner names the step index and the scenario's intent, which is the difference
        // between a bug report somebody can act on and "something disagreed".
        throw new Error(`${(error as Error).message}\n--- agent log ---\n${agent.log()}`, {
          cause: error
        });
      }

      // Every step either ran or is named. A scenario that quietly dropped five of its steps
      // reads exactly like one that ran them, which is the failure mode this whole file exists
      // to rule out.
      const undrivable: ToolId[] = ['landingOptimizer', 'landingPreview', 'mediaActions'];
      for (const outcome of result.unperformed) {
        const reason = outcome.reason ?? '';
        const expected =
          reason.includes('suspend the machine') ||
          undrivable.some(tool => reason.includes(tool)) ||
          reason.includes('was never added');
        expect(
          expected,
          `step ${outcome.index} was skipped for an unexpected reason: ${reason}`
        ).toBe(true);
      }

      // And the walk actually happened. Every adapter failing to match would leave a scenario
      // in which nothing was performed and nothing disagreed — a clean pass over no work at
      // all, which is the one result this file must never be able to produce.
      const applied = result.outcomes.filter(outcome => outcome.applied);
      expect(applied.length).toBeGreaterThanOrEqual(Math.ceil(scenario.steps.length / 2));

      const drivenTools = new Set(
        applied
          .filter(outcome => 'tool' in outcome.step)
          .map(outcome => (outcome.step as { tool: ToolId }).tool)
      );
      // Every tool this scenario names that the runner can actually drive. Naming the
      // intersection rather than a fixed list keeps a short scenario from being held to a long
      // one's coverage, without letting a broken adapter pass unnoticed.
      const expected = toolsIn(scenario).filter(tool => DRIVABLE_TOOLS.includes(tool));
      expect([...drivenTools].sort()).toEqual(expect.arrayContaining(expected));
    },
    180_000
  );

  it('leaves nothing running once every scenario has finished', async () => {
    const handles = await handlesUnder(agent.pid);
    // The agent itself is expected; anything else under it is work that outlived its stop.
    const children = handles.filter(handle => handle.pid !== agent.pid);
    expect(describeSurvivors(await survivorsOf(children))).toBe('');
  }, 60_000);
});
